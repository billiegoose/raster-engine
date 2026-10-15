"""Binary text VM tests, with an optional independent fpgatool column oracle."""
import importlib.util
from pathlib import Path
import unittest

from binary_text import TextSource, glyph_row, metadata, pair_advance, normalize_text
from engine import WIDTH, compile_y, iter_scanlines, rasterize, run_y_program, initial_palette

REFERENCE_PATH = (Path(__file__).resolve().parent.parent / 'fpgatool' /
                  'examples/hardware/red2_uart_data.py')
if REFERENCE_PATH.exists():
    spec = importlib.util.spec_from_file_location('red2_column_reference', REFERENCE_PATH)
    reference = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reference)
else:
    reference = None


class BinaryTextTests(unittest.TestCase):
    def scene(self, texts=(), buffers=None, shapes=()):
        return {'palette': initial_palette(), 'shapes': list(shapes), 'paletteEvents': [],
                'texts': list(texts), 'textBuffers': {} if buffers is None else buffers}

    def text(self, ident, ptr, x=60, y=30, w=400, h=72, layer=20, **extra):
        return dict(id=ident, buffer_ptr=ptr, x=x, y=y, w=w, h=h, layer=layer, **extra)

    def test_binary_rom_matches_independent_column_major_glyphs(self):
        if reference is None:
            self.skipTest('optional adjacent fpgatool checkout is absent')
        for code in range(128):
            descriptor = reference.DESCRIPTORS[code]
            self.assertEqual(metadata(code)['valid'], bool(descriptor & (1 << 18)), code)
            if not descriptor & (1 << 18):
                continue
            base = descriptor & 1023
            width = (descriptor >> 10) & 255
            self.assertEqual(metadata(code)['width'], width, code)
            for y in range(32):
                independently_assembled = sum(((reference.COLUMNS[base + x] >> y) & 1) << x
                                              for x in range(width))
                self.assertEqual(glyph_row(code, y), independently_assembled, (code, y))

    def test_kerning_exactly_matches_independent_uncompressed_pair_table(self):
        if reference is None:
            self.skipTest('optional adjacent fpgatool checkout is absent')
        codes = [code for code in range(128) if metadata(code)['valid']]
        for left in codes:
            for right in codes:
                self.assertEqual(pair_advance(left, right),
                                 reference.ADVANCES[(left << 7) | right], (left, right))

    def test_independent_buffers_create_distinct_masks_and_persistent_x_nodes(self):
        texts = [self.text(91, 0x1000, x=30, y=20, layer=12),
                 self.text(92, 0x2000, x=330, y=20, layer=13)]
        scene = self.scene(texts, {'4096':'P.O.', '8192':'AVATAR'})
        scanlines = iter_scanlines(scene)
        rows = [next(scanlines) for _ in range(65)]
        for y in (20, 21, 22, 32, 40, 54):
            masked = [edge for edge in rows[y]['edges'] if edge.get('op')]
            self.assertEqual(len(masked), 4)
            self.assertEqual({edge['buffer_ptr'] for edge in masked}, {4096, 8192})
            if y > 20:
                self.assertEqual([step for step in rows[y]['changes']
                                  if step['key'].startswith('text:')], [])
        self.assertIn(12, {v for r in rows for v in r['row']})
        self.assertIn(13, {v for r in rows for v in r['row']})
        self.assertEqual([e for e in rows[56]['edges'] if e.get('op')],
                         [e for e in rows[57]['edges'] if e.get('op')])

    def test_masks_are_transparent_and_obey_z_index(self):
        text = self.text(80, 'main', x=35, y=10, w=200, h=36, layer=12)
        behind = {'id': 1, 'x': 0, 'y': 0, 'w': 350, 'h': 100, 'radius': 0, 'layer': 7}
        front = {'id': 2, 'x': 80, 'y': 0, 'w': 40, 'h': 100, 'radius': 0, 'layer': 20}
        scene = self.scene([text], {'main':'AVATAR'}, [behind, front])
        source = TextSource.create(normalize_text(text), scene['textBuffers'])
        for row in iter_scanlines(scene):
            if row['y'] < 10:
                self.assertEqual(row['row'][40], 7)
            if 10 <= row['y'] < 46:
                mask = source.scanline_bits(row['y'], WIDTH)
                for x in range(0, 300):
                    expected = 20 if 80 <= x < 120 else 12 if (mask >> x) & 1 else 7
                    self.assertEqual(row['row'][x], expected, (row['y'], x))
            if row['y'] >= 46:
                break

    def test_text_bytecode_replays_without_scene_texts(self):
        scene = self.scene([self.text(19, 55, x=240, y=30)], {'55': 'HELLO WORLD'})
        program = compile_y(scene)
        self.assertEqual(len([i for i in program if i['op'] == 'TEXT']), 1)
        replay_scene = self.scene(buffers=scene['textBuffers'])
        original = rasterize(scene)
        replay = run_y_program(replay_scene, program)
        for y in range(30, 66):
            self.assertEqual(replay['scanlines'][y]['row'], original['scanlines'][y]['row'])
        self.assertEqual(original['totalEdits'], replay['totalEdits'])
        self.assertEqual(original['totalEvents'], replay['totalEvents'])

    def test_buffer_length_is_snapshot_and_missing_buffers_are_errors(self):
        scene = self.scene([self.text(1, 4, buffer_length=1)], {'4':'ABCD'})
        original = next(r for r in iter_scanlines(scene) if r['y'] == 35)
        other = self.scene([self.text(1, 4)], {'4':'A'})
        trimmed = next(r for r in iter_scanlines(other) if r['y'] == 35)
        self.assertEqual(original['row'], trimmed['row'])
        with self.assertRaisesRegex(ValueError, 'does not exist'):
            next(row for row in iter_scanlines(self.scene([self.text(1, 7)], {})) if row['y'] == 30)
        with self.assertRaisesRegex(ValueError, 'buffer_length'):
            next(row for row in iter_scanlines(self.scene([self.text(1, 4, buffer_length=40)], {'4':'AB'})) if row['y'] == 30)

    def test_two_texts_on_same_layer_union_their_ink(self):
        a = self.text(1, 'a', x=40, y=10, layer=20)
        b = self.text(2, 'b', x=45, y=10, layer=20)
        both = self.scene([a,b], {'a':'A', 'b':'V'})
        mask_a = TextSource.create(normalize_text(a), both['textBuffers'])
        mask_b = TextSource.create(normalize_text(b), both['textBuffers'])
        for frame in iter_scanlines(both):
            y = frame['y']
            if 10 <= y < 46:
                expected = mask_a.scanline_bits(y, WIDTH) | mask_b.scanline_bits(y, WIDTH)
                self.assertEqual({x for x in range(35,80) if frame['row'][x] == 20},
                                 {x for x in range(35,80) if (expected >> x) & 1})
            if y >= 46:
                break


if __name__ == '__main__':
    unittest.main()

class IndependentRasterOracleTests(unittest.TestCase):
    """Compare every bitmap bit with fpgatool's independent column renderer."""

    def test_full_text_rows_match_column_major_for_wrapping_and_kerning(self):
        import sys
        import importlib.util
        root = Path(__file__).resolve().parent.parent / 'fpgatool'
        verifier = root / 'scripts/verify_uart_pixels.py'
        if not verifier.exists():
            self.skipTest('optional adjacent fpgatool checkout is absent')
        sys.path.insert(0, str(root / 'examples'))
        file_spec = importlib.util.spec_from_file_location('red2_independent_pixel_verifier', verifier)
        module = importlib.util.module_from_spec(file_spec)
        file_spec.loader.exec_module(module)
        cases = [
            ('simple', 'HELLO, WORLD!', 310, 110),
            ('nonadjacent', "P.O. L'.. /,<T", 360, 110),
            ('newlines', 'HELLO\nWORLD\nAVATAR', 310, 160),
            ('wrap', 'AVATAR VERY LONG WORDS P.O. P.O. P.O. AVATAR', 115, 220),
            ('unsupported', 'A\rB~C\n\nWORLD', 180, 200),
            ('oversized', 'WWWWWWWWWWWW', 20, 160),
            ('spaces', '  A  V   A   ', 140, 110),
            ('thin-region', 'P.O. THE QUICK BROWN FOX', 13, 200),
            ('exact-width', 'POPOPOP', 19, 200),
        ]
        for name, text, width, height in cases:
            with self.subTest(name=name):
                source = TextSource.create(normalize_text(dict(
                    id=1, x=0, y=0, w=width, h=height, layer=13, buffer_ptr=100)),
                    {'100': text})
                expected = module.expected_pixels(text.encode('utf-8'), width=width,
                                                  height=height, margin_x=0, margin_y=0)
                for y in range(height):
                    actual = source.scanline_bits(y, width)
                    # Independent oracle has one byte per pixel; pack the ink.
                    reference_bits = sum(1 << x for x, px in
                                         enumerate(expected[y*width:(y+1)*width]) if px)
                    self.assertEqual(actual, reference_bits, (name, y, hex(actual ^ reference_bits)))
