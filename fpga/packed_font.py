# pyright: reportInvalidTypeForm=none
"""Writable packed row dictionary: two byte-wide true-dual-port RAM banks.

An index read, registered dictionary addresses, then two word reads decode
one glyph row every three clocks. Uploads share port zero while Y is idle.
All payload stays on data pins, including the ninth row-ID bit.
"""
from pypeline import *
from ram import make_ram
from fpga.scene_loader import assets_t


@struct
class font_result_t(NamedTuple):
    valid: uint1_t
    error: uint1_t
    bits: uint21_t


def make_packed_font(words=None):
    low, _ = make_ram(uint8_t, 2048, ports=('rw', 'r'), read_latency=1,
                       init=None if words is None else tuple(w & 255 for w in words))
    high, _ = make_ram(uint8_t, 2048, ports=('rw', 'r'), read_latency=1,
                        init=None if words is None else tuple(w >> 8 for w in words))

    @hw_func
    def read(load: assets_t, address: uint13_t, valid: uint1_t) -> font_result_t:
        index_pending: Reg[uint1_t] = 0
        pattern_pending: Reg[uint1_t] = 0
        result_pending: Reg[uint1_t] = 0
        dictionary_a: Reg[uint11_t] = 0
        dictionary_b: Reg[uint11_t] = 0
        odd: Reg[uint1_t] = 0
        result_odd: Reg[uint1_t] = 0
        bad: Reg[uint1_t] = 0
        result_bad: Reg[uint1_t] = 0
        old_index: uint1_t = index_pending
        old_pattern: uint1_t = pattern_pending
        old_result: uint1_t = result_pending
        old_odd: uint1_t = result_odd
        old_bad: uint1_t = result_bad
        a: uint11_t = uint11_t(address)
        if old_pattern:
            a = dictionary_a
        if load.font_write:
            a = uint11_t(load.index)
        lo = low(low.p0_in_t(addr=a, wr_data=uint8_t(load.data),
                            wr_en=load.font_write & (load.part == 0),
                            valid=valid | old_pattern | load.font_write),
                 low.p1_in_t(addr=dictionary_b, valid=old_pattern))
        hi = high(high.p0_in_t(addr=a, wr_data=uint8_t(load.data),
                               wr_en=load.font_write & (load.part == 1),
                               valid=valid | old_pattern | load.font_write),
                  high.p1_in_t(addr=dictionary_b, valid=old_pattern))
        first: uint16_t = uint16_t(lo.p0.rd_data) | (uint16_t(hi.p0.rd_data) << 8)
        second: uint16_t = uint16_t(lo.p1.rd_data) | (uint16_t(hi.p1.rd_data) << 8)
        joined: uint32_t = uint32_t(first) | (uint32_t(second) << 16)
        bits: uint21_t = uint21_t(joined)
        if old_odd:
            bits = uint21_t(joined >> 8)
        # Bound the registered second word address, separating the row-ID
        # adder from the comparison. Three bytes always span these two words.
        result_bad = bad | (dictionary_b >= load.font_index_base)
        if old_index:
            row_id: uint9_t = uint9_t(first)
            dictionary_a = uint11_t(row_id) + uint11_t(row_id >> 1)
            dictionary_b = uint11_t(row_id) - (~uint11_t(row_id >> 1))
            odd = row_id[0]
            bad = (first >> 9) != 0
        result_odd = odd
        index_pending = valid
        pattern_pending = old_index
        result_pending = old_pattern
        # A request every three clocks keeps index and dictionary accesses
        # disjoint. Reloads happen only while the producer is disabled.
        return font_result_t(valid=old_result, error=old_result & old_bad, bits=bits)
    return read
