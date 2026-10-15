"""Tests for Python consumers that do not have Bun or Node installed."""

import unittest
from engine import (WIDTH, HEIGHT, demo_scene, compile_y, circle_insets,
                    iter_scanlines, make_machine, advance_y, list_edges,
                    rasterize, reference_row, run_y_program)


class RectangleEngineTests(unittest.TestCase):
    def setUp(self):
        self.palette = demo_scene()['palette']

    def scene(self, shapes, palette_events=None):
        return {'palette': self.palette, 'shapes': shapes,
                'paletteEvents': palette_events or []}

    def test_integer_arcs_match_exact_circle_coverage(self):
        for radius in range(1, 129):
            insets = circle_insets(radius)
            self.assertEqual(len(insets), radius)
            for row in range(radius):
                expected = radius
                dy = radius - row - .5
                while expected > 0:
                    dx = radius - (expected - 1) - .5
                    if dx * dx + dy * dy <= radius * radius:
                        expected -= 1
                    else:
                        break
                self.assertEqual(insets[row], expected)

    def test_full_demo_matches_geometry_reference_every_scanline(self):
        scene = demo_scene()
        for scanline in iter_scanlines(scene):
            self.assertEqual(scanline['row'], reference_row(scene, scanline['y']))

    def test_same_layer_overlap_and_highest_layer(self):
        scene = self.scene([
            {'id': 1, 'x': 10, 'y': 10, 'w': 100, 'h': 40, 'radius': 0, 'layer': 3},
            {'id': 2, 'x': 50, 'y': 10, 'w': 100, 'h': 40, 'radius': 0, 'layer': 3},
            {'id': 3, 'x': 80, 'y': 10, 'w': 20, 'h': 40, 'radius': 0, 'layer': 5},
        ])
        run = rasterize(scene)
        row = run['scanlines'][20]['row']
        self.assertEqual([row[x] for x in [0, 20, 60, 90, 110, 150]],
                         [0, 3, 3, 5, 3, 0])
        self.assertEqual(run['scanlines'][50]['edges'], [])

    def test_y_bytecode_can_replay_without_scene_shapes(self):
        scene = self.scene([{'id': 1, 'x': 10, 'y': 5, 'w': 30, 'h': 10,
                             'radius': 4, 'layer': 3}])
        program = compile_y(scene)
        replay = run_y_program(self.scene([]), program)
        original = rasterize(scene)
        self.assertEqual([f['row'] for f in replay['scanlines']],
                         [f['row'] for f in original['scanlines']])
        self.assertEqual(replay['totalEdits'], original['totalEdits'])

    def test_bytecode_edit_changes_pixels(self):
        scene = self.scene([{'id': 1, 'x': 10, 'y': 5, 'w': 30, 'h': 10,
                             'radius': 0, 'layer': 3}])
        program = compile_y(scene)
        next(ins for ins in program if ins['op'] == 'ROUND_RECT')['rect']['x'] = 20
        replay = run_y_program(self.scene([]), program)
        self.assertEqual(replay['scanlines'][5]['row'][15], 0)
        self.assertEqual(replay['scanlines'][5]['row'][25], 3)
        self.assertEqual(replay['scanlines'][5]['edges'][0]['x'], 20)

    def test_stepwise_scanline_interface(self):
        scene = self.scene([{'id': 1, 'x': 10, 'y': 5, 'w': 30, 'h': 10,
                             'radius': 0, 'layer': 3}],
                           [{'y': 5, 'layer': 3, 'color': '#abcdef'}])
        machine = make_machine(scene, compile_y(scene))
        advance_y(machine, 4)
        self.assertEqual(list_edges(machine.head), [])
        advance_y(machine, 5)
        self.assertEqual([e['x'] for e in list_edges(machine.head)], [10, 40])
        self.assertEqual(machine.palette[3], '#abcdef')
        advance_y(machine, 15)
        self.assertEqual(list_edges(machine.head), [])
        self.assertRaises(ValueError, advance_y, machine, 14)

    def test_palette_takes_effect_on_exact_scanline(self):
        scene = self.scene([], [{'y': 120, 'layer': 2, 'color': '#abcdef'}])
        scanlines = iter_scanlines(scene)
        for scanline in scanlines:
            if scanline['y'] == 119:
                self.assertNotEqual(scanline['palette'][2], '#abcdef')
            if scanline['y'] == 120:
                self.assertEqual(scanline['palette'][2], '#abcdef')
                break

    def test_streaming_rows_are_mutable_palette_indices(self):
        scene = self.scene([{'id': 1, 'x': 4, 'y': 1, 'w': 5, 'h': 3,
                             'radius': 0, 'layer': 9}])
        scanlines = iter_scanlines(scene)
        scanline0, scanline1 = next(scanlines), next(scanlines)
        self.assertIsInstance(scanline1['row'], bytearray)
        self.assertEqual(len(scanline1['row']), WIDTH)
        self.assertEqual(scanline0['row'][4], 0)
        self.assertEqual(scanline1['row'][4:9], b'\x09' * 5)
        scanline1['row'][4] = 4
        self.assertEqual(scanline1['row'][4], 4)


if __name__ == '__main__':
    unittest.main()
