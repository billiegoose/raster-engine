import json
from pathlib import Path
import subprocess
import unittest
from engine import iter_scanlines
from fpga.scene_compile import compile_scene, square_scene, decode_scene, pack_event


def software_row(program, y):
    row = bytearray(1920)
    for p in program.primitives:
        if p.top <= y < p.bottom:
            ink = (1 << 1920)-1 if p.solid else program.font[p.glyph+y-p.glyph_y] >> p.shift
            for x in range(p.left, p.right):
                if (p.solid or (ink >> (x-p.left)) & 1) and p.layer > row[x]:
                    row[x] = p.layer
    return row


class SceneCompilerTests(unittest.TestCase):
    def scene(self, **changes):
        return dict(width=1920, height=1080, palette=['#000000']+['#ffffff']*63,
                    shapes=[], texts=[], textBuffers={}, paletteEvents=[], **changes)

    def check(self, scene):
        program = compile_scene(scene)
        for reference in iter_scanlines(square_scene(scene)):
            self.assertEqual(software_row(program, reference['y']), reference['row'], f"row {reference['y']}")
        palette, rows, events, font = decode_scene(program.to_bytes())
        self.assertEqual((palette, rows, font), (program.palette, program.rows, program.font))
        self.assertEqual(events, tuple(pack_event(*event) for event in program.events))
        return program

    def test_amber_square_corners_matches_independent_reference(self):
        root = Path(__file__).resolve().parents[1]
        script = 'import {compileScene} from "./scene-model.js"; console.log(JSON.stringify(compileScene(await Bun.file("scenes/amber-components.json").json())))'
        scene = json.loads(subprocess.check_output(['bun', '-e', script], cwd=root, text=True))
        program = self.check(scene)
        self.assertEqual(program.metrics['lanes'], 55)
        self.assertEqual(program.metrics['primitives'], 443)

    def test_utf8_wrap_clip_snapshot_and_overlapping_layers(self):
        scene = self.scene()
        scene['shapes'] = [dict(id=1, x=0, y=0, w=120, h=90, layer=3, radius=20),
                           dict(id=2, x=15, y=10, w=70, h=30, layer=8)]
        for i, (text, x, width, length) in enumerate([
            ('AVATAR\nhello ▲─★', -7, 85, None), ('Wii', 2, 8, None),
            ('€A\nB', 100, 100, 2), ('VAVV', 10, 60, None), ('\n\nA', 150, 50, None),
        ]):
            scene['texts'].append(dict(id=i+10, x=x, y=i*4, w=width, h=150,
                                       layer=4+i, buffer_ptr=i, buffer_length=length))
            scene['textBuffers'][str(i)] = text
        scene['paletteEvents'] = [dict(y=20, layer=3, color='#ff0000')]
        self.check(scene)

    def test_limits_and_corruption_are_rejected(self):
        scene = self.scene()
        scene['shapes'] = [dict(id=i, x=0, y=0, w=100, h=100, layer=1) for i in range(65)]
        with self.assertRaisesRegex(ValueError, '64 active'):
            compile_scene(scene)
        scene['shapes'] = []
        data = bytearray(compile_scene(scene).to_bytes())
        data[0x200] ^= 1
        with self.assertRaisesRegex(ValueError, 'checksum'):
            decode_scene(data)


if __name__ == '__main__':
    unittest.main()
