"""JSON stdin/stdout bridge for the pure-Python rectangle engine.

Input: {"scene": {"palette": [...], "shapes": [...], "paletteEvents": [...]}}
Output: the same execution-result schema as the JavaScript backend, including
indexed pixel rows, X instruction snapshots, Y bytecode and mutation traces.

No third-party Python packages required.
"""

import json
import sys
from engine import canvas_size, rasterize


def run(payload: dict) -> dict:
    width, height = canvas_size(payload['scene'])
    result = rasterize(payload['scene'])
    for scanline in result['scanlines']:
        scanline['row'] = list(scanline['row'])
    return dict(**result, width=width, height=height, backend='python')


def main() -> None:
    try:
        result = run(json.load(sys.stdin))
        json.dump(result, sys.stdout, separators=(',', ':'))
    except Exception as exc:
        print(f'Python raster backend: {exc}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
