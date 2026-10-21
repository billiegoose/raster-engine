"""Binary text VM tests, with an optional independent fpgatool column oracle."""
import importlib.util
from pathlib import Path
import unittest

from binary_text import TextSource, glyph_row, metadata, pair_advance, normalize_text, decode_utf8
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
        for code in range(1, 128):
            descriptor = reference.DESCRIPTORS[code]
            self.assertEqual(metadata(code)['valid'], bool(descriptor & (1 << 18)), code)
            if not descriptor & (1 << 18):
                continue
            base = descriptor & 1023
            width = (descriptor >> 10) & 255
            self.assertEqual(metadata(code)['width'], width + (code == 32), code)
            for y in range(32):
                independently_assembled = sum(((reference.COLUMNS[base + x] >> y) & 1) << x
                                              for x in range(width))
                self.assertEqual(glyph_row(code, y), independently_assembled, (code, y))

    def test_kerning_exactly_matches_independent_uncompressed_pair_table(self):
        if reference is None:
            self.skipTest('optional adjacent fpgatool checkout is absent')
        codes = [code for code in range(1, 128) if metadata(code)['valid']]
        for left in codes:
            for right in codes:
                self.assertEqual(pair_advance(left, right),
                                 reference.ADVANCES[(left << 8) | right] + (left == 32),
                                 (left, right))

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


    def render_text_rows(self, content, *, w=300, h=110, length=None, rows=(9, 10, 12, 15, 17)):
        spec = self.text(98, 'unicode', x=0, y=0, w=w, h=h,
                         **({'buffer_length': length} if length is not None else {}))
        source = TextSource.create(normalize_text(spec), {'unicode': content})
        wanted = set(rows)
        return {y: source.scanline_bits(y, w) for y in range(max(rows) + 1) if y in wanted}

    def test_unicode_triangle_glyph_rows_match_source_artwork(self):
        # Golden source rows from red2-font; no Pillow/Aseprite dependency in tests.
        triangles = {
            '▲': (17, {9: 256, 12: 1984, 17: 16376}),
            '▶': (17, {8: 16, 13: 8176, 18: 16}),
            '▼': (17, {9: 16376, 14: 1984, 17: 256}),
            '◀': (17, {8: 4096, 13: 8176, 18: 4096}),
        }
        for char, (width, rows) in triangles.items():
            code = ord(char)
            with self.subTest(char=char):
                self.assertTrue(metadata(code)['valid'])
                self.assertEqual(metadata(code)['width'], width)
                for y, bits in rows.items():
                    self.assertEqual(glyph_row(code, y), bits)
                self.assertEqual(glyph_row(code, 0), 0)
                self.assertEqual(glyph_row(code, 31), 0)
        self.assertFalse(metadata(ord('★'))['valid'])

    def test_unicode_kerning_and_exact_scanline_positions(self):
        # Advances are verified against red2-font's independent AutoKerning.
        for text, step in [('◀▶', 17), ('▶▲', 17), ('▲▼', 17),
                           ('▼◀', 17), ('A▲', 18), ('▲A', 17),
                           ('│▼', 17), ('├▶', 17)]:
            with self.subTest(text=text):
                self.assertEqual(pair_advance(ord(text[0]), ord(text[1])), step)
                rows = self.render_text_rows(text, rows=(13,))
                self.assertEqual(rows[13], glyph_row(ord(text[0]), 13) |
                                 (glyph_row(ord(text[1]), 13) << step))
        for char in '◀▶▲▼':
            self.assertTrue(any(self.render_text_rows('A' + char + 'B').values()))

    def test_utf8_bytes_malformed_input_and_byte_counted_snapshots(self):
        content = 'A▲B▶C▼D◀E'
        encoded = content.encode('utf-8')
        self.assertEqual(len(encoded), 17)  # Five ASCII bytes and four 3-byte UTF-8 triangles.
        index = 0
        decoded = []
        while index < len(encoded):
            code, end = decode_utf8(encoded, index)
            decoded.append(chr(code))
            index = end
        self.assertEqual(''.join(decoded), content)
        rows = (9, 13, 17, 20)
        self.assertEqual(self.render_text_rows(content, rows=rows),
                         self.render_text_rows(encoded, rows=rows))
        self.assertEqual(self.render_text_rows(content, rows=rows),
                         self.render_text_rows(list(encoded), rows=rows))
        self.assertEqual(self.render_text_rows('A▲', length=3, rows=rows),
                         self.render_text_rows('A', rows=rows))
        self.assertEqual(self.render_text_rows('A▲', length=4, rows=rows),
                         self.render_text_rows('A▲', rows=rows))
        self.assertEqual(self.render_text_rows(b'A\xc0\xafB\xf0\x80\x80\x80C\xe2\x96\xb6D', rows=rows),
                         self.render_text_rows('ABC▶D', rows=rows))
        self.assertEqual(self.render_text_rows('A☃B', rows=rows),
                         self.render_text_rows('A\x00B', rows=rows))
        self.assertNotEqual(self.render_text_rows('A☃B', rows=rows),
                            self.render_text_rows('AB', rows=rows))

    def test_native_box_drawing_rows_and_kerning_for_file_tree(self):
        glyphs = '─│┌┐└┘├┤┬┴┼'
        for character in glyphs:
            with self.subTest(character=character):
                self.assertTrue(metadata(ord(character))['valid'])
                self.assertEqual(metadata(ord(character))['width'], 17)
                self.assertTrue(any(glyph_row(ord(character), y) for y in range(32)))
        branch = sum(1 << x for x in range(8, 17))
        self.assertEqual(glyph_row(ord('├'), 13), branch)
        self.assertEqual(glyph_row(ord('─'), 13), (1 << 17) - 1)
        self.assertEqual(glyph_row(ord('│'), 1), 1 << 8)
        self.assertEqual(glyph_row(ord('│'), 31), 1 << 8)
        self.assertEqual(glyph_row(ord('└'), 0), 1 << 8)
        self.assertEqual(glyph_row(ord('└'), 13), branch)
        # ├'s vertical reaches scanline 31. The next │ begins at row 1,
        # so a 31px row step joins their vertical strokes continuously.
        self.assertEqual(glyph_row(ord('├'), 31), glyph_row(ord('│'), 1))
        self.assertEqual(glyph_row(ord('│'), 31), glyph_row(ord('└'), 0))
        for left,right in [('├','─'),('│',' '),(' ','├'),('└','─')]:
            self.assertEqual(pair_advance(ord(left),ord(right)),17)
        self.assertEqual(metadata(32)['width'],13)
        self.assertEqual(pair_advance(32,65),17)

    def test_reserved_notdef_box_for_every_unknown_codepoint(self):
        self.assertEqual(metadata(0)['width'], 14)
        self.assertEqual(glyph_row(0, 2), (1 << 14) - 1)
        self.assertEqual(glyph_row(0, 3), (1 << 13) + 1)
        self.assertEqual(glyph_row(0, 23), (1 << 14) - 1)
        for text in ('A★B', 'A☃B', 'A🌼B', 'AaB'):
            with self.subTest(text=text):
                self.assertEqual(self.render_text_rows(text, rows=(2, 3, 12, 23)),
                                 self.render_text_rows('A\0B', rows=(2, 3, 12, 23)))
        self.assertEqual(pair_advance(0, 0), 18)

    def test_unicode_newlines_and_wrap_preserve_utf8_codepoint_boundaries(self):
        y_rows = (9, 13, 17, 45, 49, 53)
        self.assertEqual(self.render_text_rows('▲▼', w=22, rows=y_rows),
                         self.render_text_rows('▲\n▼', w=22, rows=y_rows))
        # Two fixed 17px cells fit at width 34 but wrap at width 33.
        self.assertEqual(self.render_text_rows('▲▼', w=33, rows=y_rows),
                         self.render_text_rows('▲\n▼', w=33, rows=y_rows))
        self.assertNotEqual(self.render_text_rows('▲▼', w=34, rows=y_rows),
                            self.render_text_rows('▲\n▼', w=34, rows=y_rows))
        # The first glyph of the new line occupies the full three UTF-8 bytes.
        self.assertEqual(self.render_text_rows('▲▶', w=11, rows=y_rows),
                         self.render_text_rows('▲\n▶', w=11, rows=y_rows))

    def test_unicode_text_masks_integrate_with_indexed_scene_palette(self):
        text = self.text(1, 'triangles', x=10, y=4, w=120, h=36, layer=15)
        scene = self.scene([text], {'triangles': '▲▶▼◀'})
        source = TextSource.create(normalize_text(text), scene['textBuffers'])
        for frame in iter_scanlines(scene):
            y = frame['y']
            if 4 <= y < 40:
                mask = source.scanline_bits(y, 150)
                self.assertEqual({x for x in range(150) if frame['row'][x] == 15},
                                 {x for x in range(150) if (mask >> x) & 1}, y)
            if y >= 40:
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
        sys.path.insert(0, str(root / 'scripts'))
        sys.path.insert(0, str(root / 'examples'))
        file_spec = importlib.util.spec_from_file_location('red2_independent_pixel_verifier', verifier)
        module = importlib.util.module_from_spec(file_spec)
        file_spec.loader.exec_module(module)
        # fpgatool's independent reference uses the original 12px SPACE,
        # while the new source font advances SPACE by 17px (rather than 16).
        # Keep its *drawn* descriptor 12px wide: SPACE has zero ink and the
        # next column in the old column-major atlas belongs to another glyph.
        # Modify only the inter-glyph advance, never the reference bitmaps.
        advances = list(module.ADVANCES)
        for right in range(256):
            index = (32 << 8) | right
            if module.DESCRIPTORS[right] & (1 << 18):
                advances[index] += 1
        module.ADVANCES = tuple(advances)
        cases = [
            ('simple', 'HELLO, WORLD!', 310, 110),
            ('nonadjacent', "P.O. L'.. /,<T", 360, 110),
            ('newlines', 'HELLO\nWORLD\nAVATAR', 310, 160),
            ('wrap', 'AVATAR VERY LONG WORDS P.O. P.O. P.O. AVATAR', 115, 220),
            ('punctuation', 'A~B-C\n\nWORLD', 180, 200),
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
