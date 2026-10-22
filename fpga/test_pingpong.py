"""Cycle tests of the actual Pypeline producer/controller/consumer pipeline."""
import unittest
from fpga.test_hardware import AVAILABLE, HardwareTests as _HardwareTests

if AVAILABLE:
    from pypeline import sim_call, sim_zero
    from vga.types import vga_pos_t, vga_timing_signals_t
    from fpga.format import WIDTH, HEIGHT
    from fpga.pingpong import schedule, y_result_t, HANDOFF_X
    from fpga.procedural_y import make_procedural_y
    from fpga.scanout import make_scanout


@unittest.skipUnless(AVAILABLE, 'Requires Pypeline runtime on PYTHONPATH')
class PingPongTests(unittest.TestCase):
    setUp = _HardwareTests.setUp

    def beam(self, x, y):
        return vga_timing_signals_t(pos=vga_pos_t(x=x, y=y),
            active=int(x < WIDTH and y < HEIGHT),
            hsync=int(2008 <= x < 2052), vsync=int(1084 <= y < 1089),
            start_of_frame=int(x == 0 and y == 0), end_of_frame=0)

    def test_unique_one_pixel_rows_overlap_generation_and_scanout(self):
        producer = make_procedural_y(stripes=True)
        draw = make_scanout(palette_init=tuple(range(64)), buffered=True)
        pending = sim_zero(y_result_t)
        writes, starts = [], []
        clock, started, was_busy = 0, 0, False
        durations = []
        def tick(x, y):
            nonlocal pending, clock, started, was_busy
            sig = self.beam(x, y)
            status = sim_call(schedule, sig, 1, pending)
            pending = sim_call(producer, status.job)
            output = sim_call(draw, sig, status.load)
            self.assertFalse(status.deadline or status.invalid or output.underrun,
                             (x, y, status, output.debug))
            if status.job.start:
                starts.append((y, x, int(status.job.row)))
                started = clock
            if was_busy and not status.busy:
                durations.append(clock-started)
            was_busy = bool(status.busy)
            clock += 1
            if status.load.run_write:
                writes.append((int(status.load.index), int(status.load.data)))
                if status.load.ready:
                    self.assertNotEqual(int(status.load.index) >> 11, int(status.front))
                if y < HEIGHT and x < WIDTH:
                    # While visible, all writes belong to the opposite bank.
                    self.assertNotEqual(int(status.load.index) >> 11, y & 1)
            return output
        # Bootstrap row zero in vblank. Jump across unused blank lines.
        for x in range(2200):
            tick(x, HEIGHT)
        for x in range(2200):
            tick(x, 1124)
        pixels = []
        for y in range(4):
            for x in range(2200):
                output = tick(x, y)
                if output.active:
                    pixels.append((int(output.layer), int(output.video.b)))
        def color(x, y):
            return 1+(x & 1)+2*((y >> x) & 1) if x < 11 else 1+((x ^ y) & 1)
        expected = [(color(x, y), color(x, y)) for y in range(4) for x in range(WIDTH)]
        self.assertEqual(pixels, expected)
        # Commit at start+1922 is observable by a claim on the next clock.
        self.assertEqual(durations, [1922]*5)
        self.assertEqual(starts[:4], [(1080, 0, 0), (1124, HANDOFF_X, 1),
                                      (0, HANDOFF_X, 2), (1, HANDOFF_X, 3)])
        self.assertEqual(writes[:WIDTH], [(x, ((x+1) << 6) | (1+(x & 1))) for x in range(WIDTH)])
        self.assertEqual(writes[WIDTH:2*WIDTH],
                         [(2048+x, ((x+1) << 6) | color(x, 1)) for x in range(WIDTH)])

    def begin(self):
        self.idle = sim_zero(y_result_t)
        status = sim_call(schedule, self.beam(0, HEIGHT), 1, self.idle)
        self.assertTrue(status.job.start)
        return int(status.job.epoch)

    def emit(self, epoch, endpoint=WIDTH, row=0, layer=3):
        return y_result_t(valid=1, end_x=endpoint, layer=layer, row=row, epoch=epoch, error=0)

    def test_final_write_on_deadline_does_not_publish_partial_buffer(self):
        epoch = self.begin()
        status = sim_call(schedule, self.beam(HANDOFF_X, 1124), 1, self.emit(epoch))
        self.assertTrue(status.deadline)
        self.assertFalse(status.load.ready or status.load.run_write)
        self.assertTrue(status.job.cancel)

    def test_commit_on_deadline_is_also_too_late(self):
        epoch = self.begin()
        status = sim_call(schedule, self.beam(HANDOFF_X-1, 1124), 1, self.emit(epoch))
        self.assertTrue(status.load.run_write)
        status = sim_call(schedule, self.beam(HANDOFF_X, 1124), 1, self.idle)
        self.assertTrue(status.deadline)
        self.assertFalse(status.load.ready)

    def test_commit_before_deadline_is_ready_and_bank_is_reused(self):
        epoch = self.begin()
        sim_call(schedule, self.beam(HANDOFF_X-2, 1124), 1, self.emit(epoch))
        sim_call(schedule, self.beam(HANDOFF_X-1, 1124), 1, self.idle)
        status = sim_call(schedule, self.beam(HANDOFF_X, 1124), 1, self.idle)
        self.assertTrue(status.load.ready)
        self.assertFalse(status.deadline or status.invalid)
        self.assertEqual((int(status.job.start), int(status.job.row)), (1, 1))
        status = sim_call(schedule, self.beam(HANDOFF_X+1, 1124), 1, self.emit(epoch, row=1))
        self.assertEqual(int(status.load.index), 2048)
        sim_call(schedule, self.beam(HANDOFF_X+2, 1124), 1, self.idle)
        status = sim_call(schedule, self.beam(HANDOFF_X, 0), 1, self.idle)
        self.assertEqual((int(status.front), int(status.job.row)), (1, 2))
        status = sim_call(schedule, self.beam(HANDOFF_X+1, 0), 1, self.emit(epoch, row=2))
        self.assertEqual(int(status.load.index), 0)

    def test_missing_producer_blanks_until_next_vblank_and_fault_stays_latched(self):
        self.begin()
        status = sim_call(schedule, self.beam(HANDOFF_X, 1124), 1, self.idle)
        self.assertTrue(status.deadline)
        status = sim_call(schedule, self.beam(HANDOFF_X, 0), 1, self.idle)
        self.assertFalse(status.load.ready or status.job.start)
        epoch = self.begin()
        sim_call(schedule, self.beam(10, HEIGHT), 1, self.emit(epoch))
        sim_call(schedule, self.beam(11, HEIGHT), 1, self.idle)
        status = sim_call(schedule, self.beam(HANDOFF_X, 1124), 1, self.idle)
        self.assertTrue(status.load.ready and status.deadline)
        status = sim_call(schedule, self.beam(0, 0), 0, self.idle)
        self.assertFalse(status.deadline or status.invalid or status.load.ready)

    def test_invalid_endpoints_and_stale_job_tags_never_publish(self):
        for endpoint, row_delta, epoch_delta in [(0, 0, 0), (WIDTH+1, 0, 0),
                                                (WIDTH, 1, 0), (WIDTH, 0, 1)]:
            with self.subTest(endpoint=endpoint, row=row_delta, epoch=epoch_delta):
                sim_call(schedule, self.beam(0, 0), 0, sim_zero(y_result_t))
                epoch = self.begin()
                status = sim_call(schedule, self.beam(1, HEIGHT), 1,
                    self.emit((epoch+epoch_delta) & 3, endpoint, row=row_delta))
                self.assertTrue(status.invalid)
                self.assertFalse(status.load.run_write or status.load.ready)

    def test_decreasing_endpoint_and_extra_word_after_terminator_fault(self):
        epoch = self.begin()
        sim_call(schedule, self.beam(1, HEIGHT), 1, self.emit(epoch, 20))
        status = sim_call(schedule, self.beam(2, HEIGHT), 1, self.emit(epoch, 19))
        self.assertTrue(status.invalid)
        epoch = self.begin()
        sim_call(schedule, self.beam(1, HEIGHT), 1, self.emit(epoch))
        status = sim_call(schedule, self.beam(2, HEIGHT), 1, self.emit(epoch))
        self.assertTrue(status.invalid)
        self.assertFalse(status.load.ready or status.load.run_write)

    def test_procedural_rectangle_has_full_background_and_increasing_spans(self):
        from fpga.pingpong import y_job_t
        producer = make_procedural_y()
        for y in (0, 99, 100, 127, 555, 899, 900, 1079):
            sim_call(producer, y_job_t(start=1, cancel=1, row=y, epoch=2))
            words = [sim_call(producer, y_job_t(start=0, cancel=0, row=0, epoch=0)) for _ in range(4)]
            actual = [(int(w.end_x), int(w.layer)) for w in words if w.valid]
            expected = [(160+y//2, 0), (1120+y//2, 1+(y & 31)), (WIDTH, 0)] if 100 <= y < 900 else [(WIDTH, 0)]
            self.assertEqual(actual, expected)

    def test_last_row_has_no_out_of_frame_job_and_next_frame_invalidates_tags(self):
        # Walk the complete controller schedule using one-word rows. Skip
        # idle beam clocks; all relevant write/commit/handoff edges are real.
        epoch = self.begin()
        sim_call(schedule, self.beam(1, HEIGHT), 1, self.emit(epoch))
        sim_call(schedule, self.beam(2, HEIGHT), 1, self.idle)
        for row in range(HEIGHT):
            beam_y = 1124 if row == 0 else row-1
            status = sim_call(schedule, self.beam(HANDOFF_X, beam_y), 1, self.idle)
            self.assertTrue(status.load.ready)
            self.assertFalse(status.deadline or status.invalid)
            self.assertEqual(int(status.front), row & 1)
            self.assertEqual(int(status.job.start), int(row < HEIGHT-1))
            if row < HEIGHT-1:
                self.assertEqual(int(status.job.row), row+1)
                sim_call(schedule, self.beam(HANDOFF_X+1, beam_y), 1, self.emit(epoch, row=row+1))
                sim_call(schedule, self.beam(HANDOFF_X+2, beam_y), 1, self.idle)
        status = sim_call(schedule, self.beam(HANDOFF_X, HEIGHT-1), 1, self.idle)
        self.assertFalse(status.load.ready or status.job.start or status.deadline)
        next_epoch = self.begin()
        self.assertNotEqual(next_epoch, epoch)
        # A valid row-zero result from the previous frame is rejected.
        status = sim_call(schedule, self.beam(1, HEIGHT), 1, self.emit(epoch))
        self.assertTrue(status.invalid)
        self.assertFalse(status.load.run_write or status.load.ready)


if __name__ == '__main__':
    unittest.main()
