"""Compile reference palette pixels to a checked, independently flashable ROM."""
from __future__ import annotations

from dataclasses import dataclass
import struct

from fpga.format import (
    FLASH_BASE, HEIGHT, MAGIC, PALETTE_OFFSET, ROWS_OFFSET, RUNS_OFFSET,
    RUN_CAPACITY, WIDTH,
)


@dataclass(frozen=True)
class RomImage:
    palette: tuple[int, ...]
    rows: tuple[int, ...]
    runs: tuple[int, ...]

    def scanline(self, y):
        x, address = 0, self.rows[y]
        result = bytearray()
        while x < WIDTH:
            if address >= len(self.runs):
                raise ValueError(f'Row {y} has no terminating run')
            word = self.runs[address]
            end, layer = word >> 6, word & 63
            if word >> 17 or not x < end <= WIDTH:
                raise ValueError(f'Invalid run at address {address}')
            result.extend([layer]*(end-x))
            address += 1
            x = end
        return result

    def to_bytes(self):
        if len(self.palette) != 64 or len(self.rows) != HEIGHT:
            raise ValueError('Invalid palette or row count')
        if not 1 <= len(self.runs) <= RUN_CAPACITY:
            raise ValueError(f'Image exceeds {RUN_CAPACITY:,} run records')
        checksum = (sum(self.palette)+sum(self.rows)+sum(self.runs)) & 0xffffffff
        data = bytearray(RUNS_OFFSET+3*len(self.runs))
        struct.pack_into('<4I', data, 0, MAGIC, WIDTH | (HEIGHT << 16), len(self.runs), checksum)
        struct.pack_into('<64H', data, PALETTE_OFFSET, *self.palette)
        struct.pack_into(f'<{HEIGHT}H', data, ROWS_OFFSET, *self.rows)
        for i, word in enumerate(self.runs):
            data[RUNS_OFFSET+3*i:RUNS_OFFSET+3*i+3] = word.to_bytes(3, 'little')
        return bytes(data)


def rgb444(color):
    if not isinstance(color, str) or len(color) != 7 or color[0] != '#':
        raise ValueError('FPGA palettes require #rrggbb colors')
    try:
        r, g, b = (int(color[i:i+2], 16) >> 4 for i in (1, 3, 5))
    except ValueError as error:
        raise ValueError('FPGA palettes require #rrggbb colors') from error
    return (r << 8) | (g << 4) | b


def bake(scene):
    from engine import canvas_size, iter_scanlines
    if canvas_size(scene) != (WIDTH, HEIGHT):
        raise ValueError(f'This FPGA design requires a {WIDTH} × {HEIGHT} scene')
    if scene.get('paletteEvents'):
        raise ValueError('Baked ROM v1 requires a constant palette; remove scanline palette events')
    palette = tuple(rgb444(color) for color in scene['palette'])
    if len(palette) != 64:
        raise ValueError('Expected 64 palette entries')
    shared, runs, rows = {}, [], []
    for frame in iter_scanlines(scene):
        row = frame['row']
        words = tuple((x << 6) | row[x-1] for x in range(1, WIDTH) if row[x] != row[x-1])
        words += ((WIDTH << 6) | row[-1],)
        if words not in shared:
            if len(runs)+len(words) > RUN_CAPACITY:
                raise ValueError(f'Image exceeds {RUN_CAPACITY:,} run records after row sharing')
            shared[words] = len(runs)
            runs.extend(words)
        rows.append(shared[words])
    return RomImage(palette, tuple(rows), tuple(runs))


def decode(data):
    if len(data) < RUNS_OFFSET:
        raise ValueError('Truncated ROM header')
    magic, dimensions, count, checksum = struct.unpack_from('<4I', data)
    if magic != MAGIC or dimensions != WIDTH | (HEIGHT << 16):
        raise ValueError('Unsupported ROM format or resolution')
    if not 1 <= count <= RUN_CAPACITY or len(data) != RUNS_OFFSET+count*3:
        raise ValueError('Invalid ROM run count or length')
    palette = struct.unpack_from('<64H', data, PALETTE_OFFSET)
    rows = struct.unpack_from(f'<{HEIGHT}H', data, ROWS_OFFSET)
    runs = tuple(int.from_bytes(data[i:i+3], 'little') for i in range(RUNS_OFFSET, len(data), 3))
    if any(color > 0xfff for color in palette) or any(address >= count for address in rows):
        raise ValueError('Invalid palette or row pointer')
    if (sum(palette)+sum(rows)+sum(runs)) & 0xffffffff != checksum:
        raise ValueError('ROM checksum mismatch')
    if any(word >> 17 or not 0 < word >> 6 <= WIDTH for word in runs):
        raise ValueError('Invalid run fields')
    image = RomImage(palette, rows, runs)
    for y in range(HEIGHT):
        image.scanline(y)
    return image
