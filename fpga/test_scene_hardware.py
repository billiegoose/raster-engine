import unittest
from fpga.test_hardware import AVAILABLE, HardwareTests as _HardwareTests

if AVAILABLE:
    from pypeline import sim_call, sim_zero
    from fpga.scene_y import make_scene_y
    from fpga.scene_loader import load_scene, assets_t
    from fpga.scene_compile import Primitive, SceneProgram, decode_scene
    from fpga.pingpong import y_job_t
    from fpga.format import FLASH_BASE, WIDTH


@unittest.skipUnless(AVAILABLE, 'Requires Pypeline runtime on PYTHONPATH')
class SceneHardwareTests(unittest.TestCase):
    setUp = _HardwareTests.setUp

    def fixture(self):
        primitives = (Primitive(0, 3, 0, WIDTH, 2, True),
                      Primitive(0, 3, 3, 24, 8, False, 0, 0, 1),
                      Primitive(1, 2, 10, 20, 9, True),
                      Primitive(2, 3, WIDTH-1, WIDTH, 7, True))
        events = tuple(enumerate(primitives))
        rows = (0, 2, 3, 4)+(4,)*1077
        font = (0x155555, 0xaaaaa, 0x1fffff)+(0,)*29
        return SceneProgram(tuple(range(64)), primitives, events, rows, font, 4, {})

    def test_y_generates_rect_text_overlap_and_advances_glyph_rows(self):
        program = self.fixture()
        producer = make_scene_y(decode_scene(program.to_bytes()))
        assets = sim_zero(assets_t)._replace(ready=1, event_count=4, font_count=32)
        for row in range(4):
            sim_call(producer, y_job_t(start=1, cancel=1, row=row, epoch=1), assets)
            words = []
            for cycle in range(2200):
                output = sim_call(producer, y_job_t(start=0, cancel=0, row=0, epoch=0), assets)
                self.assertFalse(output.error, (row, cycle, output))
                if output.valid:
                    self.assertEqual((int(output.row), int(output.epoch)), (row, 1))
                    words.append((int(output.end_x), int(output.layer)))
                    if output.end_x == WIDTH:
                        break
            else:
                self.fail(f'Y row {row} missed its 2,200-cycle deadline')
            pixels, x = [], 0
            for endpoint, layer in words:
                self.assertGreater(endpoint, x)
                pixels.extend([layer]*(endpoint-x))
                x = endpoint
            expected = []
            for x in range(WIDTH):
                layer = 2 if row < 3 else 0
                if row < 3 and 3 <= x < 24 and (program.font[row] >> (x-3+1)) & 1:
                    layer = 8
                if row == 1 and 10 <= x < 20:
                    layer = 9
                if row == 2 and x == WIDTH-1:
                    layer = 7
                expected.append(layer)
            self.assertEqual(pixels, expected, f'row {row}, {words}')

    def load(self, data):
        pending, writes = None, dict(palette=[], row=[], event=[], font=[])
        for cycle in range(len(data)*3):
            done = pending is not None
            byte = data[pending-FLASH_BASE] if done else 0
            pending = None
            out = sim_call(load_scene, int(not done), int(done), byte, 0)
            if out.request:
                pending = int(out.address)
            for kind in writes:
                if getattr(out, kind+'_write'):
                    writes[kind].append((int(out.index), int(out.part), int(out.data)))
            if out.ready or out.error:
                return out, writes
        self.fail('Scene loader did not finish')

    def test_loader_populates_all_asset_memories_and_rejects_checksum_errors(self):
        program = self.fixture()
        data = program.to_bytes()
        result, writes = self.load(data)
        self.assertTrue(result.ready)
        self.assertFalse(result.error)
        self.assertEqual([v for _, _, v in writes['palette']], list(program.palette))
        self.assertEqual([v for _, _, v in writes['row']], list(program.rows))
        self.assertEqual(len(writes['event']), 40)
        self.assertEqual(len(writes['font']), 96)
        sim_call(load_scene, 1, 0, 0, 1)
        broken = bytearray(data)
        broken[0xb000] ^= 1
        result, _ = self.load(broken)
        self.assertTrue(result.error)
        self.assertFalse(result.ready)

    def test_byte_banks_preserve_high_addresses_and_row_pointer_bits(self):
        from fpga.scene_memory import make_scene_memory
        memory = make_scene_memory()
        idle = sim_zero(assets_t)
        sim_call(memory, idle._replace(row_write=1, index=1080, data=4096), 0, 0, 0, 0, 0, 0)
        event = int.from_bytes(bytes(range(10)), 'little')
        font = 0x155555
        for part in range(10):
            sim_call(memory, idle._replace(event_write=1, index=4095, part=part,
                                          data=(event >> (part*8)) & 255), 0, 0, 0, 0, 0, 0)
        for part in range(3):
            sim_call(memory, idle._replace(font_write=1, index=8191, part=part,
                                          data=(font >> (part*8)) & 255), 0, 0, 0, 0, 0, 0)
        sim_call(memory, idle, 1080, 1, 4095, 1, 8191, 1)
        out = sim_call(memory, idle, 0, 0, 0, 0, 0, 0)
        self.assertTrue(out.row_valid and out.event_valid and out.font_valid)
        self.assertEqual((int(out.row_address), int(out.row), int(out.event), int(out.font)),
                         (1080, 4096, event, font))

    def test_invalid_geometry_and_glyph_range_fault_during_setup(self):
        from fpga.scene_compile import pack_event
        # Bypass the host validator deliberately to exercise the hardware guard.
        for primitive in (Primitive(0, 2, 0, WIDTH+1, 2, True),
                          Primitive(1, 2, 0, 10, 2, True),
                          Primitive(0, 33, 0, 21, 2, False)):
            producer = make_scene_y(((0,)*64, (0,)+(1,)*1080,
                                     (pack_event(0, primitive),), (0,)*32))
            assets = sim_zero(assets_t)._replace(ready=1, event_count=1, font_count=32)
            sim_call(producer, y_job_t(start=1, cancel=1, row=0, epoch=1), assets)
            for cycle in range(160):
                out = sim_call(producer, sim_zero(y_job_t), assets)
                self.assertFalse(out.valid)
                if out.error:
                    break
            else:
                self.fail('Malformed event was not rejected during row setup')
            out = sim_call(producer, y_job_t(start=0, cancel=1, row=0, epoch=1), assets)
            self.assertFalse(out.error)
            for _ in range(4):
                self.assertFalse(sim_call(producer, sim_zero(y_job_t), assets).error)

    def test_all_64_lanes_can_be_replaced_at_a_row_boundary(self):
        # Replace every full-width rectangle with a striped glyph on row 1.
        # This combines maximum setup work with over 1,400 emitted X runs,
        # including a color change on the final pixel of the scanline.
        rectangles = tuple(Primitive(0, 1, 0, WIDTH, 1+i % 63, True) for i in range(64))
        glyphs = tuple(Primitive(1, 2, i*30 if i < 63 else WIDTH-21,
                                 i*30+21 if i < 63 else WIDTH,
                                 8, False, 0, 1) for i in range(64))
        primitives = rectangles+glyphs
        events = tuple(enumerate(rectangles))+tuple(enumerate(glyphs))
        program = SceneProgram(tuple(range(64)), primitives, events,
                               (0, 64)+(128,)*1079, (0x155555,)+(0,)*31, 64, {})
        producer = make_scene_y(decode_scene(program.to_bytes()))
        assets = sim_zero(assets_t)._replace(ready=1, event_count=128, font_count=32)
        for row in range(2):
            sim_call(producer, y_job_t(start=1, cancel=1, row=row, epoch=2), assets)
            actual = []
            for cycle in range(2200):
                out = sim_call(producer, y_job_t(start=0, cancel=0, row=0, epoch=0), assets)
                self.assertFalse(out.error)
                if out.valid:
                    actual.append((int(out.end_x), int(out.layer)))
                    if out.end_x == WIDTH:
                        break
            else:
                self.fail('64-event Y program missed its deadline')
            if row == 0:
                self.assertEqual(actual, [(WIDTH, 63)])
            else:
                self.assertGreater(len(actual), 1400)
                self.assertEqual(actual[-2:], [(WIDTH-1, 0), (WIDTH, 8)])
                pixels, previous = [], 0
                for endpoint, layer in actual:
                    self.assertGreater(endpoint, previous)
                    pixels.extend([layer]*(endpoint-previous))
                    previous = endpoint
                expected = [0]*WIDTH
                for glyph in glyphs:
                    for x in range(glyph.left, glyph.right):
                        expected[x] = 8 if (x-glyph.left) % 2 == 0 else 0
                self.assertEqual(pixels, expected)

    def test_scene_uart_packet_decodes_from_the_serial_bits(self):
        from pypeline import hw_func
        import hardware.uart as uart
        from fpga.scene_diagnostics import report_scene
        from fpga.scene_dynamic import scene_output_t
        from fpga.debug import scene_packets
        for name, value in (('BAUD_DIV', 4), ('HALF_BAUD_DIV', 2)):
            self.addCleanup(setattr, uart, name, getattr(uart, name))
            setattr(uart, name, value)
        self.addCleanup(setattr, uart, 'uart_echo', uart.uart_echo)
        uart.uart_echo = hw_func(uart.uart_echo.__wrapped__)
        assets = sim_zero(assets_t)._replace(ready=1, event_count=443, font_count=1440)
        state = sim_zero(scene_output_t)._replace(ready=1, deadline=1)
        previous, start, bit, value = 1, None, 0, 0
        received = bytearray()
        for cycle in range(2500):
            tx = int(sim_call(report_scene, assets, state))
            if start is None and previous == 1 and tx == 0:
                start, bit, value = cycle, 0, 0
            if start is not None and cycle == start+6+bit*4:
                if bit < 8:
                    value |= tx << bit
                    bit += 1
                else:
                    self.assertEqual(tx, 1)
                    received.append(value)
                    start = None
            previous = tx
            if len(received) == 32:
                break
        decoded = list(scene_packets(b'noise'+received))
        self.assertEqual(len(decoded), 1)
        self.assertTrue(decoded[0]['ready'] and decoded[0]['deadline'])
        self.assertFalse(decoded[0]['load_error'] or decoded[0]['producer_error'] or decoded[0]['scanout_fault'])
        self.assertEqual((decoded[0]['event_count'], decoded[0]['font_count']), (443, 1440))
        self.assertEqual(decoded[0]['write_checksum'], 0)

    def test_header_capacity_boundaries_and_empty_program(self):
        import struct
        from fpga.scene_compile import MAGIC
        for event_count, font_count, lanes, accepted in [
            (4096, 8192, 64, True), (0, 0, 1, True), (4095, 8191, 63, True),
            (4097, 0, 1, False), (8192, 0, 1, False), (0, 8193, 1, False),
            (0, 16384, 1, False), (0, 0, 65, False), (0, 0, 0, False),
        ]:
            with self.subTest(events=event_count, font=font_count, lanes=lanes):
                sim_call(load_scene, 1, 0, 0, 1)
                header = struct.pack('<8I', MAGIC, 1920 | (1080 << 16), event_count, font_count, 0, lanes, 0, 0)
                pending, passed = None, False
                for _ in range(100):
                    done = pending is not None
                    byte = header[pending-FLASH_BASE] if done else 0
                    pending = None
                    out = sim_call(load_scene, int(not done), int(done), byte, 0)
                    if out.error:
                        break
                    if out.request:
                        if out.address >= FLASH_BASE+0x100:
                            passed = True
                            break
                        pending = int(out.address)
                self.assertEqual(passed, accepted)
        sim_call(load_scene, 1, 0, 0, 1)
        empty = SceneProgram((0,)*64, (), (), (0,)*1081, (), 1, {})
        result, writes = self.load(empty.to_bytes())
        self.assertTrue(result.ready)
        self.assertFalse(result.error)
        self.assertEqual((writes['event'], writes['font']), ([], []))


if __name__ == '__main__':
    unittest.main()
