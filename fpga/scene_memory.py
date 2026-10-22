# pyright: reportInvalidTypeForm=none
"""Data-only BRAM banks for the Y bytecode and glyph rows (one clock)."""
from pypeline import *
from ram import make_ram
from fpga.scene_loader import assets_t

uint80_t = make_uint_t(80)


@struct
class reads_t(NamedTuple):
    row_valid: uint1_t
    row_address: uint11_t
    row: uint16_t
    event_valid: uint1_t
    event: uint80_t
    font_valid: uint1_t
    font: uint21_t


def make_scene_memory(program=None):
    rows_init = None if program is None else program[1]
    events = None if program is None else program[2]
    font = None if program is None else program[3]
    rows_low, _ = make_ram(uint8_t, 2048, ports=('w', 'r'), read_latency=1,
                           init=None if rows_init is None else tuple(r & 255 for r in rows_init))
    rows_high, _ = make_ram(uint8_t, 2048, ports=('w', 'r'), read_latency=1,
                            init=None if rows_init is None else tuple(r >> 8 for r in rows_init))
    event0, _ = make_ram(uint8_t, 4096, ports=('w', 'r'), read_latency=1,
                         init=None if events is None else tuple((w >> 0) & 255 for w in events))
    event1, _ = make_ram(uint8_t, 4096, ports=('w', 'r'), read_latency=1,
                         init=None if events is None else tuple((w >> 8) & 255 for w in events))
    event2, _ = make_ram(uint8_t, 4096, ports=('w', 'r'), read_latency=1,
                         init=None if events is None else tuple((w >> 16) & 255 for w in events))
    event3, _ = make_ram(uint8_t, 4096, ports=('w', 'r'), read_latency=1,
                         init=None if events is None else tuple((w >> 24) & 255 for w in events))
    event4, _ = make_ram(uint8_t, 4096, ports=('w', 'r'), read_latency=1,
                         init=None if events is None else tuple((w >> 32) & 255 for w in events))
    event5, _ = make_ram(uint8_t, 4096, ports=('w', 'r'), read_latency=1,
                         init=None if events is None else tuple((w >> 40) & 255 for w in events))
    event6, _ = make_ram(uint8_t, 4096, ports=('w', 'r'), read_latency=1,
                         init=None if events is None else tuple((w >> 48) & 255 for w in events))
    event7, _ = make_ram(uint8_t, 4096, ports=('w', 'r'), read_latency=1,
                         init=None if events is None else tuple((w >> 56) & 255 for w in events))
    event8, _ = make_ram(uint8_t, 4096, ports=('w', 'r'), read_latency=1,
                         init=None if events is None else tuple((w >> 64) & 255 for w in events))
    event9, _ = make_ram(uint8_t, 4096, ports=('w', 'r'), read_latency=1,
                         init=None if events is None else tuple((w >> 72) & 255 for w in events))
    font0, _ = make_ram(uint8_t, 8192, ports=('w', 'r'), read_latency=1,
                         init=None if font is None else tuple((w >> 0) & 255 for w in font))
    font1, _ = make_ram(uint8_t, 8192, ports=('w', 'r'), read_latency=1,
                         init=None if font is None else tuple((w >> 8) & 255 for w in font))
    font2, _ = make_ram(uint8_t, 8192, ports=('w', 'r'), read_latency=1,
                         init=None if font is None else tuple((w >> 16) & 255 for w in font))

    @hw_func
    def memory(load: assets_t, row_address: uint11_t, row_read: uint1_t,
               event_address: uint12_t, event_read: uint1_t,
               font_address: uint13_t, font_read: uint1_t) -> reads_t:
        row_low = rows_low(rows_low.p0_in_t(addr=load.index[10:0], wr_data=uint8_t(load.data),
                                           wr_en=load.row_write, valid=1),
                           rows_low.p1_in_t(addr=row_address, valid=row_read))
        row_high = rows_high(rows_high.p0_in_t(addr=load.index[10:0], wr_data=uint8_t(load.data >> 8),
                                              wr_en=load.row_write, valid=1),
                             rows_high.p1_in_t(addr=row_address, valid=row_read))
        row: uint16_t = uint16_t(row_low.p1.rd_data) | (uint16_t(row_high.p1.rd_data) << 8)
        event_r0 = event0(event0.p0_in_t(addr=load.index[11:0], wr_data=uint8_t(load.data),
                       wr_en=load.event_write & (load.part == 0), valid=1),
                       event0.p1_in_t(addr=event_address, valid=event_read))
        event_r1 = event1(event1.p0_in_t(addr=load.index[11:0], wr_data=uint8_t(load.data),
                       wr_en=load.event_write & (load.part == 1), valid=1),
                       event1.p1_in_t(addr=event_address, valid=event_read))
        event_r2 = event2(event2.p0_in_t(addr=load.index[11:0], wr_data=uint8_t(load.data),
                       wr_en=load.event_write & (load.part == 2), valid=1),
                       event2.p1_in_t(addr=event_address, valid=event_read))
        event_r3 = event3(event3.p0_in_t(addr=load.index[11:0], wr_data=uint8_t(load.data),
                       wr_en=load.event_write & (load.part == 3), valid=1),
                       event3.p1_in_t(addr=event_address, valid=event_read))
        event_r4 = event4(event4.p0_in_t(addr=load.index[11:0], wr_data=uint8_t(load.data),
                       wr_en=load.event_write & (load.part == 4), valid=1),
                       event4.p1_in_t(addr=event_address, valid=event_read))
        event_r5 = event5(event5.p0_in_t(addr=load.index[11:0], wr_data=uint8_t(load.data),
                       wr_en=load.event_write & (load.part == 5), valid=1),
                       event5.p1_in_t(addr=event_address, valid=event_read))
        event_r6 = event6(event6.p0_in_t(addr=load.index[11:0], wr_data=uint8_t(load.data),
                       wr_en=load.event_write & (load.part == 6), valid=1),
                       event6.p1_in_t(addr=event_address, valid=event_read))
        event_r7 = event7(event7.p0_in_t(addr=load.index[11:0], wr_data=uint8_t(load.data),
                       wr_en=load.event_write & (load.part == 7), valid=1),
                       event7.p1_in_t(addr=event_address, valid=event_read))
        event_r8 = event8(event8.p0_in_t(addr=load.index[11:0], wr_data=uint8_t(load.data),
                       wr_en=load.event_write & (load.part == 8), valid=1),
                       event8.p1_in_t(addr=event_address, valid=event_read))
        event_r9 = event9(event9.p0_in_t(addr=load.index[11:0], wr_data=uint8_t(load.data),
                       wr_en=load.event_write & (load.part == 9), valid=1),
                       event9.p1_in_t(addr=event_address, valid=event_read))
        event_word: uint80_t = (uint80_t(event_r0.p1.rd_data) << 0) | (uint80_t(event_r1.p1.rd_data) << 8) | (uint80_t(event_r2.p1.rd_data) << 16) | (uint80_t(event_r3.p1.rd_data) << 24) | (uint80_t(event_r4.p1.rd_data) << 32) | (uint80_t(event_r5.p1.rd_data) << 40) | (uint80_t(event_r6.p1.rd_data) << 48) | (uint80_t(event_r7.p1.rd_data) << 56) | (uint80_t(event_r8.p1.rd_data) << 64) | (uint80_t(event_r9.p1.rd_data) << 72)
        font_r0 = font0(font0.p0_in_t(addr=load.index[12:0], wr_data=uint8_t(load.data),
                       wr_en=load.font_write & (load.part == 0), valid=1),
                       font0.p1_in_t(addr=font_address, valid=font_read))
        font_r1 = font1(font1.p0_in_t(addr=load.index[12:0], wr_data=uint8_t(load.data),
                       wr_en=load.font_write & (load.part == 1), valid=1),
                       font1.p1_in_t(addr=font_address, valid=font_read))
        font_r2 = font2(font2.p0_in_t(addr=load.index[12:0], wr_data=uint8_t(load.data),
                       wr_en=load.font_write & (load.part == 2), valid=1),
                       font2.p1_in_t(addr=font_address, valid=font_read))
        font_word: uint24_t = (uint24_t(font_r0.p1.rd_data) << 0) | (uint24_t(font_r1.p1.rd_data) << 8) | (uint24_t(font_r2.p1.rd_data) << 16)
        return reads_t(row_valid=row_low.p1.valid, row_address=row_low.p1.addr, row=row,
                       event_valid=event_r0.p1.valid, event=event_word,
                       font_valid=font_r0.p1.valid, font=uint21_t(font_word))
    return memory
