"""Measure X lists and compile static scenes into 18-bit visible-run programs.

Run from any directory:
  python3 scripts/analyze_x_programs.py --out-dir analysis/x-programs

The default corpus is amber-components plus generated adversarial scenes. The
existing JS scene compiler resolves editor layer IDs, and the Python renderer
supplies the authoritative pixels, including text. No FPGA timing is simulated.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
from itertools import groupby
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from engine import initial_palette, iter_scanlines  # noqa: E402


# CTA-style progressive timings, matching the neighboring fpgatool examples.
MODES = {
    '720p60': (1280, 720, 110, 40, 220, 5, 5, 20, 74_250_000),
    '1080p60': (1920, 1080, 88, 44, 148, 4, 5, 36, 148_500_000),
}


def timing_metrics(mode):
    w, h, hf, hs, hb, vf, vs, vb, hz = MODES[mode]
    ht, vt = w + hf + hs + hb, h + vf + vs + vb
    vertical = (vt - h) * ht
    horizontal = (ht - w) * h  # exclude horizontal blank inside vertical blank
    return dict(width=w, height=h, pixel_hz=hz, total_width=ht, total_height=vt,
                h_front=hf, h_sync=hs, h_back=hb, v_front=vf, v_sync=vs, v_back=vb,
                clocks_per_line=ht, hblank_clocks=ht-w, vblank_lines=vt-h,
                vblank_clocks=vertical, active_line_hblank_clocks=horizontal,
                total_blank_clocks=vertical+horizontal, frame_clocks=ht*vt,
                hblank_us=(ht-w)/hz*1e6, vblank_us=vertical/hz*1e6,
                refresh_hz=hz/(ht*vt))


def compile_scene(path):
    script = ('import {compileScene} from "./scene-model.js"; '
              'console.log(JSON.stringify(compileScene('
              'await Bun.file(process.argv[1]).json())));')
    return json.loads(subprocess.check_output(
        ['bun', '-e', script, str(Path(path).resolve())], cwd=ROOT, text=True))


def visible_runs(row):
    """(exclusive end X, palette index), covering the entire scanline."""
    if not row:
        return ()
    return tuple((x, row[x-1]) for x in range(1, len(row)) if row[x] != row[x-1]) + (
        (len(row), row[-1]),)


def encode_runs(runs):
    """bits 16:6 = exclusive end X; bits 5:0 = layer; bit 17 = zero."""
    last = 0
    words = []
    for end, layer in runs:
        if not last < end <= 1920 or not 0 <= layer < 64:
            raise ValueError('Invalid run')
        words.append((end << 6) | layer)
        last = end
    return tuple(words)


def decode_program(words, offset, width):
    row = bytearray()
    while len(row) < width:
        word = words[offset]
        offset += 1
        if word >> 17:
            raise ValueError('Reserved bit set')
        end, layer = word >> 6, word & 63
        if not len(row) < end <= width:
            raise ValueError('Invalid run end')
        row.extend([layer] * (end-len(row)))
    return row


def max_window(xs, width=64):
    """Largest event count in a half-open width-pixel window; xs is sorted."""
    left = best = 0
    for right, x in enumerate(xs):
        while x-xs[left] >= width:
            left += 1
        best = max(best, right-left+1)
    return best


def distribution(values):
    ordered = sorted(values)
    peak = max(values)
    return dict(total=sum(values), mean=sum(values)/len(values),
                p95=ordered[(95*len(values)+99)//100-1], max=peak,
                peak_rows=[i for i, n in enumerate(values) if n == peak][:12])


def storage(run_count, height):
    # A 7-series RAMB18 can store 1,024 18-bit words. Pointer memory is separate.
    address_bits = max(1, (run_count-1).bit_length())
    pointer_bits = 18 if address_bits <= 18 else 36
    pointer_depth = 18432//pointer_bits
    blocks = (run_count+1023)//1024 + (height+pointer_depth-1)//pointer_depth
    bits = run_count*18+height*pointer_bits
    return dict(run_words=run_count, row_pointer_words=height,
                address_bits=address_bits, row_pointer_word_bits=pointer_bits,
                payload_bits=bits, payload_bytes=bits/8,
                ramb18_blocks=blocks, bram_reserved_bytes=blocks*2304,
                board_bram_percent=blocks)  # Basys 3 has 100 RAMB18 equivalents.


def analyze(scene, emit_dir=None):
    rows = []
    unique = {}
    unique_words = []
    flat_words, flat_offsets, unique_offsets = [], [], []
    op_totals = Counter()
    palettes = set()
    digest = hashlib.sha256()
    max_counter = 0
    previous_edges = {}
    for frame in iter_scanlines(scene):
        row, edges = frame['row'], frame['edges']
        runs = visible_runs(row)
        words = encode_runs(runs)
        # Check the actual packed format, not just run counting.
        if decode_program(words, 0, len(row)) != row:
            raise AssertionError('Packed X program differs from reference pixels')
        digest.update(row)
        palettes.add(tuple(frame['palette']))
        if words not in unique:
            unique[words] = len(unique_words)
            unique_words.extend(words)
        unique_offsets.append(unique[words])
        if emit_dir is not None:
            flat_offsets.append(len(flat_words))
            flat_words.extend(words)
        ops = Counter(edge.get('op', 'PAINT') for edge in edges)
        op_totals.update(ops)
        counts = Counter()
        paint_peak = 0
        for x, group in groupby(edges, key=lambda e: e['x']):
            # Batch coincident events: transient ordering is not visible coverage.
            for edge in group:
                if edge.get('op', 'PAINT') == 'PAINT':
                    counts[edge['layer']] += edge['delta']
            paint_peak = max(paint_peak, max(counts.values(), default=0))
        max_counter = max(max_counter, paint_peak)
        current_edges = {e['key']: e for e in edges}
        moved = sum(key in previous_edges and e['x'] != previous_edges[key]['x']
                    for key, e in current_edges.items())
        added = len(current_edges.keys()-previous_edges.keys())
        removed = len(previous_edges.keys()-current_edges.keys())
        previous_edges = current_edges
        xs = [e['x'] for e in edges]
        text_ids = {e['shape'] for e in edges if e.get('op') == 'START_MASK'}
        rows.append(dict(y=frame['y'], edges=len(edges), runs=len(runs),
                         paint_edges=ops['PAINT'], mask_edges=len(edges)-ops['PAINT'],
                         active_texts=len(text_ids), edits=len(frame['changes']),
                         added=added, removed=removed, moved=moved,
                         same_x=max(Counter(xs).values(), default=0),
                         edges_per_64px=max_window([x for x in xs if x < len(row)]),
                         run_starts_per_64px=max_window([0]+[x for x, _ in runs[:-1]])))
    if emit_dir is not None:
        if len(flat_words) > 1 << 18 or len(unique_words) > 1 << 18:
            raise ValueError('ROM emission currently supports only 18-bit row pointers')
        emit_dir = Path(emit_dir)
        emit_dir.mkdir(parents=True, exist_ok=True)
        for name, values in [('flat-runs', flat_words), ('flat-rows', flat_offsets),
                             ('shared-runs', unique_words), ('shared-rows', unique_offsets)]:
            (emit_dir / f'{name}.mem').write_text(''.join(f'{v:05x}\n' for v in values))
        # Check cross-row pointers and the actual shared layout as well.
        for y, offset in enumerate(unique_offsets):
            flat = decode_program(flat_words, flat_offsets[y], scene['width'])
            if decode_program(unique_words, offset, scene['width']) != flat:
                raise AssertionError('Shared row pointer differs from flat program')
    metrics = {key: distribution([r[key] for r in rows]) for key in rows[0] if key != 'y'}
    return dict(width=scene['width'], height=scene['height'],
                rectangles=len(scene.get('shapes', [])), texts=len(scene.get('texts', [])),
                text_buffer_bytes=sum(len(v.encode('utf-8')) if isinstance(v, str) else len(v)
                                      for v in scene.get('textBuffers', {}).values()),
                palette_events=len(scene.get('paletteEvents', [])),
                palette_versions=len(palettes), raw_edge_op_totals=dict(op_totals),
                max_same_layer_solid_overlap=max_counter,
                unique_visible_programs=len(unique), pixel_sha256=digest.hexdigest(),
                metrics=metrics,
                flat_visible_storage=storage(metrics['runs']['total'], scene['height']),
                shared_visible_storage=storage(len(unique_words), scene['height']))


def stress_scenes(width=1920, height=1080, count=128):
    def blank():
        return dict(width=width, height=height, palette=initial_palette(),
                    shapes=[], texts=[], textBuffers={}, paletteEvents=[])

    def rect(id, x, y, w, h, layer=1, radius=0):
        return dict(id=id, x=x, y=y, w=w, h=h, layer=layer, radius=radius)

    scene = blank()
    scene['shapes'] = [rect(i, 0, 0, width, height) for i in range(count)]
    yield 'coincident-overlap', scene

    scene = blank()
    scene['shapes'] = [rect(i, x, 0, 1, height) for i, x in enumerate(range(0, width, 2))]
    yield 'one-pixel-stripes', scene

    scene = blank()
    scene['shapes'] = [rect(i, x, 0, 1, height) for i, x in enumerate(range(0, width, 2))]
    stripes = (width+1)//2
    # Change one stripe's layer on every row; defeats exact whole-row sharing
    # while preserving the maximum one-run-per-pixel density (for even widths).
    scene['shapes'].extend(rect(stripes+y, 2*(y % stripes), y, 1, 1,
                               2+(y//stripes) % 62) for y in range(height))
    yield 'dense-unique-rows', scene

    scene = blank()
    for y in range(min(height, 16)):
        scene['shapes'].extend(rect(y*count+i, (i*2) % width, y, 1, 1,
                                    1+y % 2) for i in range(count))
    yield 'row-replacement-burst', scene

    scene = blank()
    diameter = min(256, height, width)
    scene['shapes'] = [rect(i, (i*7) % max(1, width-diameter+1),
                            i % max(1, min(64, height-diameter+1)), diameter,
                            diameter, 1+i % 63, diameter//2) for i in range(count)]
    yield 'moving-rounded-edges', scene

    scene = blank()
    # Every text producer must supply mask bits at once, including same-layer OR.
    scene['textBuffers'] = {str(i+1): f'W{i:03}MW'*(width//40+1) for i in range(count)}
    scene['texts'] = [dict(id=i, x=0, y=0, w=width, h=min(height, 36),
                           layer=1+i % 63, buffer_ptr=i+1) for i in range(count)]
    yield 'overlapping-text-sources', scene

    scene = blank()
    scene['shapes'] = [rect(0, 0, 0, width, height)]
    scene['paletteEvents'] = [dict(y=y, layer=layer,
                                  color=f'#{(y*7919+layer*65537) % 0x1000000:06x}')
                              for y in range(height) for layer in range(64)]
    yield 'palette-every-row', scene


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scene', type=Path, default=ROOT/'scenes/amber-components.json')
    parser.add_argument('--out-dir', type=Path, default=ROOT/'analysis/x-programs')
    parser.add_argument('--skip-stress', action='store_true')
    parser.add_argument('--stress-count', type=int, default=128)
    args = parser.parse_args()
    if args.stress_count < 1:
        parser.error('--stress-count must be positive')
    args.out_dir.mkdir(parents=True, exist_ok=True)
    scene = compile_scene(args.scene)
    report = dict(encoding='18-bit word: zero[17], exclusive_end_x[16:6], layer[5:0]; '
                  'row ends at scene width; each row pointer is one 18-bit word',
                  assumptions='Storage includes run ROM and row pointers (18-bit words, '
                  'or 36 bits when the program exceeds 18 address bits); excludes palettes, '
                  'FIFO and logic. Shared programs use exact whole-row deduplication only. '
                  'Raw edges still require text generation. No cycle costs are assumed.',
                  timing={mode: timing_metrics(mode) for mode in MODES},
                  scene=str(args.scene.relative_to(ROOT)) if args.scene.is_relative_to(ROOT)
                  else str(args.scene),
                  source_sha256=hashlib.sha256(args.scene.read_bytes()).hexdigest(),
                  representative=analyze(scene, args.out_dir/'amber-static'), stress={})
    if not args.skip_stress:
        for name, case in stress_scenes(scene['width'], scene['height'], args.stress_count):
            report['stress'][name] = analyze(case)
    destination = args.out_dir/'metrics.json'
    destination.write_text(json.dumps(report, indent=2)+'\n')
    print(destination)
    for name, result in [('representative', report['representative']), *report['stress'].items()]:
        print(f"{name}: edges={result['metrics']['edges']['max']} max/"
              f"{result['metrics']['edges']['total']} total, runs="
              f"{result['metrics']['runs']['max']} max/{result['metrics']['runs']['total']} total, "
              f"unique={result['unique_visible_programs']}, "
              f"flat/shared RAMB18={result['flat_visible_storage']['ramb18_blocks']}/"
              f"{result['shared_visible_storage']['ramb18_blocks']}")


if __name__ == '__main__':
    main()
