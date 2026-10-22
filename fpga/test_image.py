import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from engine import initial_palette, iter_scanlines
from fpga.backend import program
from fpga.format import FLASH_BASE, HEIGHT, RUNS_OFFSET, WIDTH
from fpga.image import RomImage, bake, decode
from fpga.tool import read_timing, verify_data_lanes


class ImageTests(unittest.TestCase):
    def scene(self):
        return dict(width=WIDTH, height=HEIGHT, palette=initial_palette(), shapes=[],
                    paletteEvents=[], texts=[], textBuffers={})

    def test_amber_binary_replays_all_reference_pixels(self):
        root = Path(__file__).resolve().parents[1]
        source = ('import {compileScene} from "./scene-model.js"; '
                  'console.log(JSON.stringify(compileScene(await Bun.file("scenes/amber-components.json").json())));')
        scene = json.loads(subprocess.check_output(['bun', '-e', source], cwd=root, text=True))
        image = bake(scene)
        self.assertEqual(len(image.runs), 33028)
        restored = decode(image.to_bytes())
        for frame in iter_scanlines(scene):
            self.assertEqual(restored.scanline(frame['y']), frame['row'])

    def test_rejects_bad_header_checksum_and_nonmonotonic_runs(self):
        original = bytearray(bake(self.scene()).to_bytes())
        for index in (0, 4, 8, 12, RUNS_OFFSET):
            data = original.copy()
            data[index] ^= 1
            with self.assertRaises(ValueError):
                decode(data)
        image = RomImage((0,)*64, (0,)*HEIGHT, ((10 << 6), (9 << 6), (WIDTH << 6)))
        with self.assertRaisesRegex(ValueError, 'Invalid run'):
            decode(image.to_bytes())

    def test_unsupported_scene_fails_before_programming(self):
        for changes in ({'width': 1280, 'height': 720},
                        {'paletteEvents': [{'y': 1, 'layer': 1, 'color': '#ffffff'}]}):
            with patch('fpga.backend.run_programmer') as run:
                with self.assertRaises(ValueError):
                    program(dict(self.scene(), **changes))
                run.assert_not_called()

    def test_program_uses_fixed_offset_and_retains_binary_after_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch('fpga.backend.run_programmer', return_value=subprocess.CompletedProcess([], 1, '', 'No device')) as run:
                result = program(self.scene(), directory)
            self.assertFalse(result['ok'])
            self.assertTrue(Path(result['path']).is_file())
            self.assertEqual(decode(Path(result['path']).read_bytes()).scanline(0), bytearray(WIDTH))
            self.assertEqual(run.call_args.args[0], ['fpgatool', 'program-data', result['path'],
                                                  '--board', 'basys3', '--offset', hex(FLASH_BASE)])

    def test_final_timing_checks_padded_clock_names_and_last_routed_result(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'timing.log'
            base=("Info: Max frequency for clock 'system': 152.25 MHz (PASS at 100.00 MHz)\n"
                  "Info: Max frequency for clock        'pixel': 172.83 MHz (PASS at 148.50 MHz)\n")
            path.write_text(base)
            self.assertEqual(read_timing(path)['pixel']['achieved_mhz'],172.83)
            # Clock generation alone has no timed 100 MHz register path.
            path.write_text(base.splitlines(keepends=True)[1])
            self.assertEqual(set(read_timing(path)), {'pixel'})
            path.write_text(base.splitlines(keepends=True)[0])
            with self.assertRaisesRegex(ValueError, 'required pixel clock'):
                read_timing(path)
            path.write_text(base+"Warning: Max frequency for clock        'pixel': 139.16 MHz (FAIL at 148.50 MHz)\n")
            with self.assertRaisesRegex(ValueError,'failed'):
                read_timing(path)

    def test_mapped_memory_check_rejects_payload_on_parity_inputs_or_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'mapped.json'
            cells = {f'core.{bank}_ram': {'type': 'RAMB36E1', 'connections':
                     {'DIPADIP': ['0']*4, 'DIPBDIP': ['0']*4, 'DOPBDOP': [100+i]},
                     'port_directions': {'DIPADIP': 'input', 'DIPBDIP': 'input', 'DOPBDOP': 'output'}}
                     for i, bank in enumerate(('run_low', 'run_mid', 'run_high'))}
            def write():
                path.write_text(json.dumps({'modules': {'top': {'cells': cells}}}))
            write()
            self.assertEqual(verify_data_lanes(path)['parity_payload_bits'], 0)
            cells['core.run_low_ram']['connections']['DIPADIP'][0] = 42
            write()
            with self.assertRaisesRegex(ValueError, 'parity input'):
                verify_data_lanes(path)
            cells['core.run_low_ram']['connections']['DIPADIP'][0] = '0'
            cells['consumer'] = {'type': 'LUT1', 'connections': {'I0': [100]}, 'port_directions': {'I0': 'input'}}
            write()
            with self.assertRaisesRegex(ValueError, 'parity output'):
                verify_data_lanes(path)
            del cells['consumer']
            cells['core.run_low_ram']['connections']['CASCADEINA'] = [42]
            write()
            with self.assertRaisesRegex(ValueError, 'native BRAM cascade'):
                verify_data_lanes(path)


if __name__ == '__main__':
    unittest.main()
