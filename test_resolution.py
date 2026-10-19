"""Cross-resolution raster regression tests for the pure Python backend."""
import unittest
from engine import canvas_size, compile_y, iter_scanlines, reference_row, initial_palette
from python_backend import run


class ResolutionTests(unittest.TestCase):
    def make_scene(self):
        return {
            'width': 1920, 'height': 1080,
            'palette': initial_palette(),
            'shapes': [{'id': 1, 'x': 1850, 'y': 1050, 'w': 70, 'h': 30,
                        'radius': 0, 'layer': 1}],
            'paletteEvents': [{'y': 1079, 'layer': 1, 'color': '#ff3400'}],
        }

    def test_legacy_default_and_invalid_sizes(self):
        self.assertEqual(canvas_size({}), (1280, 720))
        self.assertEqual(canvas_size({'width': 1920, 'height': 1080}), (1920, 1080))
        for invalid in ({'width': 1920}, {'width': 0, 'height': 1080},
                        {'width': 1921, 'height': 1080},
                        {'width': 1920, 'height': 1081},
                        {'width': True, 'height': 1080}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                canvas_size(invalid)

    def test_native_full_hd_scanlines_and_final_palette_change(self):
        scene = self.make_scene()
        self.assertEqual(compile_y(scene)[-2], {'op': 'WAIT_Y', 'y': 1080})
        rows = iter_scanlines(scene)
        first = next(rows)
        self.assertEqual(len(first['row']), 1920)
        last = None
        for last in rows:
            pass
        self.assertEqual(last['y'], 1079)
        self.assertEqual(last['row'][1919], 1)
        self.assertEqual(last['palette'][1], '#ff3400')
        self.assertEqual(reference_row(scene, 1079)[1919], 1)

    def test_text_can_draw_beyond_720p_right_edge(self):
        scene = self.make_scene()
        scene['texts'] = [{'id': 2, 'x': 1810, 'y': 900, 'w': 110, 'h': 36,
                           'layer': 20, 'buffer_ptr': 4096}]
        scene['textBuffers'] = {'4096': 'HI'}
        frames = (row for row in iter_scanlines(scene) if 900 <= row['y'] < 936)
        self.assertTrue(any(20 in row['row'][1810:1920] for row in frames))

    def test_python_bridge_reports_scene_dimensions(self):
        result = run({'scene': self.make_scene()})
        self.assertEqual((result['width'], result['height']), (1920, 1080))
        self.assertEqual(len(result['scanlines']), 1080)
        self.assertEqual(len(result['scanlines'][-1]['row']), 1920)
        self.assertEqual(result['scanlines'][-1]['row'][1919], 1)


if __name__ == '__main__':
    unittest.main()
