"""Host-only reference for procedural development captures (no Pypeline import)."""
from fpga.format import WIDTH


def palette():
    return (0,) + tuple(((i & 15) << 8) | (((i >> 2) & 15) << 4) | 5 for i in range(1, 64))


def row_indices(y, *, stripes=False):
    if stripes:
        return bytes(1+(x & 1)+2*((y >> x) & 1) if x < 11 else 1+((x ^ y) & 1)
                     for x in range(WIDTH))
    if 100 <= y < 900:
        left, right = 160+y//2, 1120+y//2
        return bytes(left) + bytes([1+(y & 31)])*(right-left) + bytes(WIDTH-right)
    return bytes(WIDTH)
