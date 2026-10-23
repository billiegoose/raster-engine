# pyright: reportInvalidTypeForm=none
"""RY03 flash loader: fixed palette, Y event table, descriptors and glyph ROM."""
from pypeline import *
from fpga.format import FLASH_BASE, WIDTH, HEIGHT
from fpga.scene_compile import (MAGIC, PALETTE_OFFSET, ROWS_OFFSET, EVENTS_OFFSET,
                                FONT_OFFSET, EVENT_CAPACITY, FONT_CAPACITY)


@struct
class assets_t(NamedTuple):
    request: uint1_t
    address: uint32_t
    ready: uint1_t
    error: uint1_t
    palette_write: uint1_t
    row_write: uint1_t
    event_write: uint1_t
    font_write: uint1_t
    index: uint16_t
    part: uint4_t
    data: uint16_t
    event_count: uint13_t
    font_count: uint14_t
    font_index_base: uint11_t


@hw_func
def load_scene(byte_ready: uint1_t, byte_done: uint1_t, byte_data: uint8_t,
               reload: uint1_t) -> assets_t:
    phase: Reg[uint3_t] = 0
    index: Reg[uint13_t] = 0
    part: Reg[uint4_t] = 0
    waiting: Reg[uint1_t] = 0
    assembled: Reg[uint32_t] = 0
    pending_word: Reg[uint32_t] = 0
    checking: Reg[uint1_t] = 0
    checksum: Reg[uint32_t] = 0
    expected: Reg[uint32_t] = 0
    event_count: Reg[uint13_t] = 0
    font_count: Reg[uint14_t] = 0
    font_index_base: Reg[uint11_t] = 0
    last_event: Reg[uint12_t] = 0
    last_font: Reg[uint11_t] = 0
    previous_row: Reg[uint16_t] = 0
    finishing: Reg[uint1_t] = 0
    ready: Reg[uint1_t] = 0
    error: Reg[uint1_t] = 0
    request: uint1_t = 0
    palette_write: uint1_t = 0
    row_write: uint1_t = 0
    event_write: uint1_t = 0
    font_write: uint1_t = 0
    write_index: uint16_t = index
    header_index: uint3_t = uint3_t(index)
    write_part: uint4_t = part
    data: uint16_t = 0
    address: uint32_t = FLASH_BASE + (uint32_t(index) << 2) + part
    last_part: uint4_t = 3
    if phase == 1:
        address = FLASH_BASE+PALETTE_OFFSET+(uint32_t(index) << 1)+part
        last_part = 1
    elif phase == 2:
        address = FLASH_BASE+ROWS_OFFSET+(uint32_t(index) << 1)+part
        last_part = 1
    elif phase == 3:
        address = FLASH_BASE+EVENTS_OFFSET+uint32_t(index)*10+part
        last_part = 9
    elif phase == 4:
        address = FLASH_BASE+FONT_OFFSET+(uint32_t(index) << 1)+part
        last_part = 1

    if reload:
        phase = 0
        index = 0
        part = 0
        waiting = 0
        assembled = 0
        pending_word = 0
        checking = 0
        checksum = 0
        expected = 0
        previous_row = 0
        event_count = 0
        font_count = 0
        font_index_base = 0
        last_event = 0
        last_font = 0
        finishing = 0
        ready = 0
        error = 0
    elif finishing:
        finishing = 0
        if (checksum != expected) | error:
            error = 1
        else:
            ready = 1
    elif checking:
        # Keep byte assembly and word validation on separate pixel clocks.
        # The SPI transport is idle, so index/phase remain stable here.
        checking = 0
        word: uint32_t = pending_word
        index = index + 1
        if phase == 0:
            if (header_index == 0) & (word != MAGIC):
                error = 1
            elif (header_index == 1) & (word != (WIDTH | (HEIGHT << 16))):
                error = 1
            elif header_index == 2:
                if ((word >> 13) != 0) | (word[12] & (word[11:0] != 0)):
                    error = 1
                event_count = uint13_t(word)
                last_event = uint12_t(word) - 1
            elif header_index == 3:
                if word > FONT_CAPACITY:
                    error = 1
                font_count = uint14_t(word)
                last_font = uint11_t(word) - 1
            elif header_index == 4:
                expected = word
            elif (header_index == 5) & ((word == 0) | ((word >> 7) != 0) | (word[6] & (word[5:0] != 0))):
                error = 1
            elif header_index == 6:
                if (word > 768) | (word > font_count) | ((font_count != 0) & (word == 0)):
                    error = 1
                font_index_base = uint11_t(word)
            elif (header_index == 7) & (word != 0):
                error = 1
            if header_index == 7:
                phase = 1
                index = 0
        elif phase == 1:
            data = uint16_t(word)
            palette_write = 1
            if (word >> 12) != 0:
                error = 1
            if write_index == 63:
                phase = 2
                index = 0
        elif phase == 2:
            data = uint16_t(word)
            row_write = 1
            if ((word > event_count) | (word < previous_row) |
                    ((write_index == 0) & (word != 0)) |
                    ((write_index == HEIGHT) & (word != event_count))):
                error = 1
            previous_row = uint16_t(word)
            if write_index == HEIGHT:
                phase = 3
                index = 0
                if event_count == 0:
                    phase = 4
                    if font_count == 0:
                        finishing = 1
    elif (~ready) & (~error):
        if (~waiting) & byte_ready:
            request = 1
            waiting = 1
        elif waiting & byte_done:
            waiting = 0
            shifted: uint32_t = uint32_t(byte_data) << (uint5_t(part) << 3)
            word: uint32_t = assembled | shifted
            if phase != 0:
                checksum = checksum + uint32_t(byte_data)
            if phase == 3:
                data = byte_data
                event_write = 1
                if (part == 9) & ((byte_data & 248) != 0):
                    error = 1
            elif phase == 4:
                data = byte_data
                font_write = 1

            if part == last_part:
                part = 0
                assembled = 0
                if phase < 3:
                    pending_word = word
                    checking = 1
                else:
                    index = index + 1
                    if phase == 3:
                        if uint12_t(write_index) == last_event:
                            phase = 4
                            index = 0
                            if font_count == 0:
                                finishing = 1
                    elif phase == 4:
                        if uint11_t(write_index) == last_font:
                            finishing = 1
            else:
                part = part + 1
                if phase < 3:
                    assembled = word
    return assets_t(request=request, address=address, ready=ready, error=error,
                    palette_write=palette_write, row_write=row_write,
                    event_write=event_write, font_write=font_write,
                    index=write_index, part=write_part, data=data,
                    event_count=event_count, font_count=font_count, font_index_base=font_index_base)
