# pyright: reportInvalidTypeForm=none
"""64 parallel RECT/glyph lanes, followed by a registered priority tree."""
from pypeline import *


@struct
class lane_write_t(NamedTuple):
    valid: uint1_t
    lane: uint6_t
    left: uint11_t
    right: uint11_t
    layer: uint6_t
    solid: uint1_t
    ink: uint21_t


@struct
class pixel_t(NamedTuple):
    valid: uint1_t
    x: uint11_t
    layer: uint6_t


@hw_func
def composite(write: lane_write_t, x: uint11_t, valid: uint1_t, clear: uint1_t) -> pixel_t:
    left: Reg[uint11_t[64]]
    right: Reg[uint11_t[64]]
    layer: Reg[uint6_t[64]]
    solid: Reg[uint1_t[64]]
    ink: Reg[uint21_t[64]]
    advance: Reg[uint1_t[64]]
    visible: Reg[uint1_t[64]]
    coverage: Reg[uint6_t[64]]
    a: Reg[uint6_t[32]]
    b: Reg[uint6_t[16]]
    c: Reg[uint6_t[8]]
    d: Reg[uint6_t[4]]
    e: Reg[uint6_t[2]]
    f: Reg[uint6_t]
    delayed_x: Reg[uint11_t[8]]
    delayed_valid: Reg[uint8_t] = 0
    result = pixel_t(valid=delayed_valid[7] & (~clear), x=delayed_x[7], layer=f)
    # Read each stage before writing the preceding stage. Every comparison
    # level is a separate clock; no 64-way priority chain sits in one path.
    f = e[0]
    if e[1] > e[0]:
        f = e[1]
    for i in range(2):
        e[i] = d[2*i]
        if d[2*i+1] > d[2*i]:
            e[i] = d[2*i+1]
    for i in range(4):
        d[i] = c[2*i]
        if c[2*i+1] > c[2*i]:
            d[i] = c[2*i+1]
    for i in range(8):
        c[i] = b[2*i]
        if b[2*i+1] > b[2*i]:
            c[i] = b[2*i+1]
    for i in range(16):
        b[i] = a[2*i]
        if a[2*i+1] > a[2*i]:
            b[i] = a[2*i+1]
    for i in range(32):
        a[i] = coverage[2*i]
        if coverage[2*i+1] > coverage[2*i]:
            a[i] = coverage[2*i+1]
    for i in range(64):
        # Geometry ends at a one-bit local register. A separate clock fans
        # the visible flag out to the color tree; layers are stable while
        # sweeping a row and draining its pixel pipeline.
        coverage[i] = 0
        if visible[i]:
            coverage[i] = layer[i]
        old_ink: uint21_t = ink[i]
        # Apply the preceding pixel's shift from a local register.
        if advance[i]:
            old_ink = old_ink >> 1
        # Remaining distances to the two boundaries count down locally.
        # No global X bus fans out through all 64 geometry comparators.
        covered: uint1_t = (left[i] == 0) & (right[i] != 0)
        visible[i] = covered & (solid[i] | uint1_t(old_ink))
        if write.valid & (write.lane == i):
            left[i] = write.left
            right[i] = write.right
            layer[i] = write.layer
            solid[i] = write.solid
            ink[i] = write.ink
            advance[i] = 0
        else:
            ink[i] = old_ink
            if valid:
                if left[i] != 0:
                    left[i] = left[i] - 1
                if right[i] != 0:
                    right[i] = right[i] - 1
            advance[i] = valid & covered
        if clear:
            advance[i] = 0
    for i in range(7):
        delayed_x[7-i] = delayed_x[6-i]
    delayed_x[0] = x
    delayed_valid = (delayed_valid << 1) | uint8_t(valid)
    if clear:
        delayed_valid = 0
    return result
