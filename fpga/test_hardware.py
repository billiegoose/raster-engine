"""Native Pypeline checks; set PYTHONPATH to the fpgatool Pypeline runtime."""
import unittest
import tempfile
import os

from fpga.format import FLASH_BASE, HEIGHT, RUNS_OFFSET, WIDTH
from fpga.image import RomImage

try:
    from pypeline import sim_call, sim_reset, sim_zero
    from vga.types import vga_pos_t, vga_timing_signals_t
    from fpga.loader import load_image, load_t
    from fpga.scanout import make_scanout
    from fpga.diagnostics import debug_t, report
    import hardware.uart as uart
    from operators.soft import register_sw_lib_replacements
    register_sw_lib_replacements()
except ImportError:
    AVAILABLE = False
else:
    AVAILABLE = True


@unittest.skipUnless(AVAILABLE, 'Requires Pypeline runtime on PYTHONPATH')
class HardwareTests(unittest.TestCase):
    def setUp(self):
        sim_reset()
        import SYN
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        previous = SYN.SYN_OUTPUT_DIRECTORY
        self.addCleanup(setattr, SYN, 'SYN_OUTPUT_DIRECTORY', previous)
        SYN.SYN_OUTPUT_DIRECTORY = directory.name
        self.addCleanup(os.chdir, os.getcwd())
        os.chdir(directory.name)

    def load(self, data):
        pending = None
        writes = {'palette': [], 'row': [], 'run': []}
        for _ in range(len(data)*4):
            done = pending is not None
            byte = data[pending-FLASH_BASE] if done else 0
            pending = None
            status = sim_call(load_image, int(not done), int(done), byte, 0)
            if status.request:
                pending = int(status.address)
            for kind in writes:
                if getattr(status, kind+'_write'):
                    writes[kind].append((int(status.index), int(status.data)))
            if status.ready or status.error:
                return status, writes
        self.fail('Loader did not finish')

    def test_loader_checks_flash_abi_and_writes_all_memories(self):
        image = RomImage(tuple(range(64)), (0,)*HEIGHT, ((WIDTH << 6) | 2,))
        status, writes = self.load(image.to_bytes())
        self.assertEqual(int(status.error), 0)
        self.assertEqual(int(status.ready), 1)
        self.assertEqual(writes['palette'], list(enumerate(image.palette)))
        self.assertEqual(writes['row'], list(enumerate(image.rows)))
        self.assertEqual(writes['run'], list(enumerate(image.runs)))

    def test_loader_rejects_corruption(self):
        image = RomImage((0,)*64, (0,)*HEIGHT, ((WIDTH << 6),))
        data = bytearray(image.to_bytes())
        data[RUNS_OFFSET] ^= 1
        status, _ = self.load(data)
        self.assertEqual(int(status.error), 1)
        self.assertEqual(int(status.ready), 0)

    def test_loader_writes_the_complete_flash_image_on_the_pixel_clock(self):
        image = RomImage(tuple(range(64)), (0, 1)+(0,)*(HEIGHT-2),
                         ((WIDTH << 6) | 1, (WIDTH << 6) | 2))
        data = image.to_bytes()
        draw = make_scanout()
        render_load = sim_zero(load_t)
        pending = None
        writes = {'palette': [], 'row': [], 'run': []}
        def beam(x, y):
            return vga_timing_signals_t(pos=vga_pos_t(x=x, y=y),
                active=int(x < WIDTH and y < HEIGHT), hsync=0, vsync=0,
                start_of_frame=int(x == 0 and y == 0), end_of_frame=0)
        for tick in range(len(data)*4):
            done = pending is not None
            byte = data[pending-FLASH_BASE] if done else 0
            pending = None
            load = sim_call(load_image, int(not done), int(done), byte, 0)
            if load.request:
                pending = int(load.address)
            for kind in writes:
                if getattr(load, kind+'_write'):
                    writes[kind].append((int(load.index), int(load.data)))
            output = sim_call(draw, beam(tick % 2200, 1124), render_load)
            render_load = load
            self.assertFalse(load.error)
            self.assertFalse(output.underrun)
            if load.ready:
                break
        self.assertTrue(load.ready)
        self.assertEqual(writes['palette'], list(enumerate(image.palette)))
        self.assertEqual(writes['row'], list(enumerate(image.rows)))
        self.assertEqual(writes['run'], list(enumerate(image.runs)))
        # Verify RAM contents by rendering; no initialized ROM is used.
        # No initialized ROM is used in this path.
        for x in range(WIDTH, 2200):
            sim_call(draw, beam(x, 1124), load)
        visible = []
        for y in range(2):
            for x in range(2200):
                output = sim_call(draw, beam(x, y), load)
                if output.active:
                    visible.append((int(output.layer), int(output.video.b)))
        self.assertEqual(visible, [(1, 1)]*WIDTH+[(2, 2)]*WIDTH)

    def draw_row(self, words, row_addresses=None, row_count=1):
        palette = tuple((i << 8) | i for i in range(16))+(0,)*48
        draw = make_scanout(words, row_addresses or (0,)*HEIGHT, palette)
        loaded = load_t(request=0, address=0, ready=1, error=0, run_count=len(words),
                        palette_write=0, row_write=0, run_write=0, index=0, data=0)
        def tick(x, y):
            active = x < WIDTH and y < HEIGHT
            sig = vga_timing_signals_t(pos=vga_pos_t(x=x, y=y), active=int(active),
                hsync=int(2008 <= x < 2052), vsync=int(1084 <= y < 1089),
                start_of_frame=int(x == 0 and y == 0), end_of_frame=0)
            return sim_call(draw, sig, loaded)
        for x in range(WIDTH, 2200):
            tick(x, 1124)
        outputs = [tick(x, y) for y in range(row_count) for x in range(2200)]
        visible = [p for p in outputs if p.active]
        self.assertEqual(len(visible), WIDTH*row_count)
        self.assertFalse(any(p.underrun for p in outputs))
        for index, output in enumerate(outputs[2:], 0):
            self.assertEqual(int(output.video.hs), int(2008 <= index % 2200 < 2052))
        return visible

    def test_one_pixel_runs_sustain_one_record_per_clock(self):
        words = tuple(((x+1) << 6) | (1+x % 2) for x in range(WIDTH))
        visible = self.draw_row(words)
        self.assertEqual([int(p.layer) for p in visible], [1+x % 2 for x in range(WIDTH)])
        self.assertEqual([(int(p.video.r), int(p.video.b)) for p in visible],
                         [(1+x % 2, 1+x % 2) for x in range(WIDTH)])

    def test_short_row_does_not_consume_following_row_program(self):
        words = ((WIDTH << 6) | 3, (WIDTH << 6) | 7)
        visible = self.draw_row(words)
        self.assertEqual({int(p.layer) for p in visible}, {3})

    def test_first_fault_records_the_bad_word_and_its_delayed_ram_address(self):
        words = ((10 << 6) | 3, (9 << 6) | 7, (WIDTH << 6) | 2)
        draw = make_scanout(words, (0,)*HEIGHT, (0,)*64)
        load = load_t(request=0, address=0, ready=1, error=0, run_count=len(words),
                      palette_write=0, row_write=0, run_write=0, index=0, data=0)
        for x in range(WIDTH, 2200):
            sig = vga_timing_signals_t(pos=vga_pos_t(x=x, y=1124), active=0,
                                      hsync=0, vsync=0, start_of_frame=0, end_of_frame=0)
            output = sim_call(draw, sig, load)
        self.assertTrue(output.underrun)
        self.assertEqual(int(output.debug.reason), 2)
        self.assertEqual(int(output.debug.word), words[1])
        self.assertEqual(int(output.debug.address), 1)
        self.assertEqual(int(output.debug.previous_end), 10)
        self.assertEqual(int(output.debug.row), 0)
        original = output.debug
        for x in range(20):
            sig = vga_timing_signals_t(pos=vga_pos_t(x=x, y=0), active=1,
                                      hsync=0, vsync=0, start_of_frame=int(x == 0), end_of_frame=0)
            output = sim_call(draw, sig, load)
            self.assertEqual(output.debug, original)

    def test_uart_packet_decodes_from_the_actual_serial_bitstream(self):
        from fpga.debug import packets
        from pypeline import hw_func
        for name, value in (('BAUD_DIV', 4), ('HALF_BAUD_DIV', 2)):
            self.addCleanup(setattr, uart, name, getattr(uart, name))
            setattr(uart, name, value)
        # Native Reg simulation snapshots globals when @hw_func decorates.
        self.addCleanup(setattr, uart, 'uart_echo', uart.uart_echo)
        uart.uart_echo = hw_func(uart.uart_echo.__wrapped__)
        load = load_t(request=0, address=0, ready=1, error=0, run_count=1,
                      palette_write=0, row_write=0, run_write=0, index=0, data=0)
        debug = debug_t(reason=2, x=777, y=10, row=11, word=(777 << 6) | 3,
                        address=123, previous_end=700, credits=8)
        previous, start, bit, value = 1, None, 0, 0
        received = bytearray()
        for cycle in range(2500):
            write_data = (0xabc, 123, (WIDTH << 6) | 3)[min(cycle, 2)]
            current_load = load._replace(palette_write=int(cycle == 0), row_write=int(cycle == 1),
                                         run_write=int(cycle == 2), data=write_data)
            tx = int(sim_call(report, current_load, debug, 1))
            if start is None and previous == 1 and tx == 0:
                start, bit, value = cycle, 0, 0
            if start is not None and cycle == start+6+bit*4:
                if bit < 8:
                    value |= tx << bit
                    bit += 1
                else:
                    self.assertEqual(tx, 1, 'UART stop bit')
                    received.append(value)
                    start = None
            previous = tx
            if len(received) == 36:
                break
        decoded = list(packets(received))
        self.assertEqual(len(decoded), 1)
        self.assertEqual(decoded[0]['reason'], 'invalid_run')
        self.assertEqual((decoded[0]['x'], decoded[0]['row'], decoded[0]['address']), (777, 11, 123))
        self.assertEqual(decoded[0]['word'], (777 << 6) | 3)
        self.assertEqual(decoded[0]['credits'], 8)
        self.assertEqual((decoded[0]['palette_writes'], decoded[0]['row_writes'], decoded[0]['run_writes']), (1, 1, 1))
        self.assertEqual(decoded[0]['write_checksum'], 0xabc+123+((WIDTH << 6) | 3))

    def test_row_pointers_jump_back_and_prefetch_flushes_between_rows(self):
        words = ((WIDTH << 6) | 3, (1 << 6) | 7, (WIDTH << 6) | 2)
        visible = self.draw_row(words, (0, 1, 0)+(0,)*(HEIGHT-3), row_count=3)
        self.assertEqual([int(p.layer) for p in visible], [3]*WIDTH+[7]+[2]*(WIDTH-1)+[3]*WIDTH)


if __name__ == '__main__':
    unittest.main()
