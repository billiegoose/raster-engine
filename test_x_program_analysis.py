"""Checks for static run encoding, pointer replay and adversarial generators."""
import tempfile
from pathlib import Path
import unittest

from engine import initial_palette, iter_scanlines
from scripts.analyze_x_programs import (
    analyze, decode_program, encode_runs, max_window, stress_scenes,
    storage, timing_metrics, visible_runs,
)


class XProgramAnalysisTests(unittest.TestCase):
    def test_encoding_handles_full_hd_and_layer_63(self):
        row = bytearray([0]*1919+[63])
        words = encode_runs(visible_runs(row))
        self.assertEqual(words, ((1919 << 6), (1920 << 6) | 63))
        self.assertEqual(decode_program(words, 0, 1920), row)
        for runs in (((0, 1),), ((1921, 1),), ((1, 64),), ((2, 1), (1, 0))):
            with self.assertRaises(ValueError):
                encode_runs(runs)

    def test_exact_row_sharing_and_emitted_rom_replay_with_text(self):
        scene = dict(width=64, height=40, palette=initial_palette(),
                     shapes=[dict(id=1, x=1, y=0, w=30, h=40, layer=3, radius=4)],
                     texts=[dict(id=2, x=0, y=0, w=64, h=36, layer=5, buffer_ptr=1)],
                     textBuffers={'1': 'HI'}, paletteEvents=[])
        with tempfile.TemporaryDirectory() as directory:
            result = analyze(scene, directory)
            self.assertLess(result['unique_visible_programs'], scene['height'])
            for kind in ('flat', 'shared'):
                words = [int(v, 16) for v in (Path(directory)/f'{kind}-runs.mem').read_text().split()]
                offsets = [int(v, 16) for v in (Path(directory)/f'{kind}-rows.mem').read_text().split()]
                for frame in iter_scanlines(scene):
                    self.assertEqual(decode_program(words, offsets[frame['y']], 64), frame['row'])

    def test_stress_scenes_expose_different_costs(self):
        cases = dict(stress_scenes(64, 40, 16))
        overlap = analyze(cases['coincident-overlap'])
        self.assertEqual(overlap['metrics']['edges']['max'], 32)
        self.assertEqual(overlap['max_same_layer_solid_overlap'], 16)
        self.assertEqual(overlap['metrics']['same_x']['max'], 16)
        self.assertEqual(overlap['metrics']['runs']['max'], 1)
        stripes = analyze(cases['one-pixel-stripes'])
        self.assertEqual(stripes['metrics']['runs']['max'], 64)
        self.assertEqual(stripes['unique_visible_programs'], 1)
        dense = analyze(cases['dense-unique-rows'])
        self.assertEqual(dense['metrics']['runs']['max'], 64)
        self.assertEqual(dense['unique_visible_programs'], 40)
        churn = analyze(cases['row-replacement-burst'])
        self.assertEqual(churn['metrics']['added']['max'], 32)
        self.assertEqual(churn['metrics']['removed']['max'], 32)
        self.assertEqual(churn['metrics']['edits']['max'], 64)
        text = analyze(cases['overlapping-text-sources'])
        self.assertEqual(text['metrics']['active_texts']['max'], 16)
        palette = analyze(cases['palette-every-row'])
        self.assertEqual(palette['palette_versions'], 40)
        self.assertEqual(palette['unique_visible_programs'], 1)

    def test_half_open_64_pixel_window(self):
        self.assertEqual(max_window([]), 0)
        self.assertEqual(max_window([0, 0, 63, 64]), 3)
        self.assertEqual(max_window(list(range(1920))), 64)

    def test_large_programs_require_wider_row_addresses(self):
        self.assertEqual(storage(36_570, 1080)['row_pointer_word_bits'], 18)
        dense = storage(1920*1080, 1080)
        self.assertEqual(dense['address_bits'], 21)
        self.assertEqual(dense['row_pointer_word_bits'], 36)
        self.assertEqual(dense['ramb18_blocks'], 2028)

    def test_blanking_accounting_never_double_counts_intersections(self):
        for mode in ('720p60', '1080p60'):
            metrics = timing_metrics(mode)
            self.assertEqual(metrics['total_blank_clocks'],
                             metrics['frame_clocks']-metrics['width']*metrics['height'])
            self.assertEqual(metrics['refresh_hz'], 60)
        self.assertEqual(timing_metrics('720p60')['vblank_clocks'], 49_500)
        self.assertEqual(timing_metrics('1080p60')['vblank_clocks'], 99_000)


if __name__ == '__main__':
    unittest.main()
