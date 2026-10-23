"""Compare fpgatool's dependency-free PNG capture with an exported ROM image."""
import argparse
from pathlib import Path
import struct
import sys
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fpga.image import decode
from fpga.format import WIDTH, HEIGHT


def read_capture(path):
    data = Path(path).read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Expected a PNG capture')
    cursor, compressed = 8, bytearray()
    while cursor < len(data):
        length = struct.unpack_from('>I', data, cursor)[0]
        kind = data[cursor+4:cursor+8]
        payload = data[cursor+8:cursor+8+length]
        if kind == b'IHDR':
            if struct.unpack('>IIBBBBB', payload) != (WIDTH, HEIGHT, 8, 2, 0, 0, 0):
                raise ValueError('Expected a 1920 × 1080 RGB8 capture')
        if kind == b'IDAT':
            compressed.extend(payload)
        cursor += length+12
    raw = zlib.decompress(compressed)
    stride = 1+WIDTH*3
    if len(raw) != stride*HEIGHT or any(raw[y*stride] for y in range(HEIGHT)):
        raise ValueError('Expected fpgatool PNG rows with filter zero')
    return b''.join(raw[y*stride+1:(y+1)*stride] for y in range(HEIGHT))


def compare(binary, screenshot):
    image = decode(Path(binary).read_bytes())
    captured = read_capture(screenshot)
    colors = tuple(bytes((((c >> 8) & 15)*17, ((c >> 4) & 15)*17, (c & 15)*17))
                   for c in image.palette)
    for y in range(HEIGHT):
        expected = b''.join(colors[index] for index in image.scanline(y))
        actual = captured[y*WIDTH*3:(y+1)*WIDTH*3]
        if actual != expected:
            first = next(x for x in range(WIDTH) if actual[x*3:x*3+3] != expected[x*3:x*3+3])
            raise AssertionError(f'HDL capture differs at x={first}, y={y}: '
                                 f'{tuple(actual[first*3:first*3+3])} vs {tuple(expected[first*3:first*3+3])}')
    return f'All {WIDTH*HEIGHT:,} HDL pixels match the exported RGB444 image'


def compare_dynamic(screenshot, *, stripes=False):
    from fpga.dynamic_reference import palette, row_indices
    captured = read_capture(screenshot)
    colors = tuple(bytes((((c >> 8) & 15)*17, ((c >> 4) & 15)*17, (c & 15)*17))
                   for c in palette())
    for y in range(HEIGHT):
        expected = b''.join(colors[i] for i in row_indices(y, stripes=stripes))
        actual = captured[y*WIDTH*3:(y+1)*WIDTH*3]
        if actual != expected:
            first = next(x for x in range(WIDTH) if actual[x*3:x*3+3] != expected[x*3:x*3+3])
            raise AssertionError(f'Dynamic HDL capture differs at x={first}, y={y}: '
                                 f'{tuple(actual[first*3:first*3+3])} vs {tuple(expected[first*3:first*3+3])}')
    return f'All {WIDTH*HEIGHT:,} runtime-generated HDL pixels match the procedural reference'


def compare_scene(binary, screenshot, *, scene=None):
    from fpga.scene_compile import decode_scene, square_scene, font_row
    palette, rows, events, font = decode_scene(Path(binary).read_bytes())
    if scene is not None:
        from engine import iter_scanlines
        reference = (frame['row'] for frame in iter_scanlines(square_scene(scene)))
    else:
        def reference_rows():
            lanes = {}
            for y in range(HEIGHT):
                for word in events[rows[y]:rows[y+1]]:
                    lanes[(word >> 69) & 63] = word
                row = bytearray(WIDTH)
                for word in lanes.values():
                    top, bottom = (word >> 22) & 2047, (word >> 33) & 2047
                    if not top <= y < bottom:
                        continue
                    left, right, layer = word & 2047, (word >> 11) & 2047, (word >> 44) & 63
                    solid = (word >> 50) & 1
                    ink = 0 if solid else font_row(font, ((word >> 51) & 8191)+y-top) >> ((word >> 64) & 31)
                    for x in range(left, right):
                        if (solid or (ink >> (x-left)) & 1) and layer > row[x]:
                            row[x] = layer
                yield row
        reference = reference_rows()
    captured = read_capture(screenshot)
    colors = tuple(bytes((((c >> 8) & 15)*17, ((c >> 4) & 15)*17, (c & 15)*17)) for c in palette)
    for y, row in enumerate(reference):
        expected = b''.join(colors[i] for i in row)
        actual = captured[y*WIDTH*3:(y+1)*WIDTH*3]
        if actual != expected:
            first = next(x for x in range(WIDTH) if actual[x*3:x*3+3] != expected[x*3:x*3+3])
            raise AssertionError(f'RECT/TEXT HDL differs at x={first}, y={y}: '
                                 f'{tuple(actual[first*3:first*3+3])} vs {tuple(expected[first*3:first*3+3])}')
    return f'All {WIDTH*HEIGHT:,} RECT/TEXT HDL pixels match the reference (square corners, fixed palette)'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('screenshot', type=Path)
    args = parser.parse_args()
    print(compare(args.binary, args.screenshot))
