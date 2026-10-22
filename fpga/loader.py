# pyright: reportInvalidTypeForm=none
"""Read-only flash-to-BRAM loader; byte transport is supplied by the board top."""
from pypeline import *
from fpga.format import (FLASH_BASE, HEIGHT, MAGIC, PALETTE_OFFSET, ROWS_OFFSET,
                         RUNS_OFFSET, RUN_CAPACITY, WIDTH)


@struct
class load_t(NamedTuple):
    request: uint1_t
    address: uint32_t
    ready: uint1_t
    error: uint1_t
    run_count: uint17_t
    palette_write: uint1_t
    row_write: uint1_t
    run_write: uint1_t
    index: uint16_t
    data: uint18_t


@hw_func
def load_image(byte_ready: uint1_t, byte_done: uint1_t, byte_data: uint8_t,
               reload: uint1_t) -> load_t:
    waiting: Reg[uint1_t] = 0
    phase: Reg[uint2_t] = 0  # header, palette, row pointers, run words
    index: Reg[uint17_t] = 0
    part: Reg[uint2_t] = 0
    assembled: Reg[uint32_t] = 0
    pending_word: Reg[uint32_t] = 0
    validating: Reg[uint1_t] = 0
    committing: Reg[uint1_t] = 0
    invalid: Reg[uint1_t] = 0
    phase_end: Reg[uint1_t] = 0
    last_run_index: Reg[uint16_t] = 0
    count: Reg[uint17_t] = 0
    checksum: Reg[uint32_t] = 0
    expected: Reg[uint32_t] = 0
    finishing: Reg[uint1_t] = 0
    ready: Reg[uint1_t] = 0
    error: Reg[uint1_t] = 0

    request: uint1_t = 0
    palette_write: uint1_t = 0
    row_write: uint1_t = 0
    run_write: uint1_t = 0
    write_index: uint16_t = uint16_t(index)
    data: uint18_t = 0
    address: uint32_t = FLASH_BASE + (uint32_t(index) << 2) + part
    last_part: uint2_t = 3
    if phase == 1:
        address = FLASH_BASE + PALETTE_OFFSET + (uint32_t(index) << 1) + part
        last_part = 1
    elif phase == 2:
        address = FLASH_BASE + ROWS_OFFSET + (uint32_t(index) << 1) + part
        last_part = 1
    elif phase == 3:
        address = FLASH_BASE + RUNS_OFFSET + uint32_t(index)*3 + part
        last_part = 2

    if reload:
        # Board top pulses reload only while the transport is idle.
        waiting = 0
        phase = 0
        index = 0
        part = 0
        assembled = 0
        pending_word = 0
        validating = 0
        committing = 0
        invalid = 0
        phase_end = 0
        checksum = 0
        count = 0
        finishing = 0
        ready = 0
        error = 0
    elif finishing:
        # Check the registered final sum on its own clock, rather than putting
        # the 32-bit addition and equality check in one pixel-clock path.
        finishing = 0
        if (checksum != expected) | error:
            error = 1
        else:
            ready = 1
    elif validating:
        # Byte assembly, field checks and committing a word each get their
        # own clock. The transport is idle here, so phase/index stay stable.
        validating = 0
        committing = 1
        invalid = 0
        phase_end = 0
        if phase == 0:
            if write_index == 0:
                invalid = pending_word != MAGIC
            elif write_index == 1:
                invalid = pending_word != (WIDTH | (HEIGHT << 16))
            elif write_index == 2:
                invalid = (pending_word == 0) | (pending_word > RUN_CAPACITY)
            phase_end = write_index == 3
        elif phase == 1:
            invalid = (pending_word >> 12) != 0
            phase_end = write_index == 63
        elif phase == 2:
            invalid = ((pending_word >> 16) != 0) | (uint17_t(pending_word[15:0]) >= count)
            phase_end = write_index == (HEIGHT-1)
        else:
            invalid = ((pending_word >> 17) != 0) | (pending_word[16:6] == 0) | (pending_word[16:6] > WIDTH)
            phase_end = write_index == last_run_index
    elif committing:
        committing = 0
        if invalid:
            error = 1
        else:
            index = index + 1
            if phase == 0:
                if write_index == 2:
                    count = uint17_t(pending_word)
                    last_run_index = uint16_t(pending_word - 1)
                if phase_end:
                    expected = pending_word
                    phase = 1
                    index = 0
            else:
                data = uint18_t(pending_word)
                checksum = checksum + pending_word
                if phase == 1:
                    palette_write = 1
                    if phase_end:
                        phase = 2
                        index = 0
                elif phase == 2:
                    row_write = 1
                    if phase_end:
                        phase = 3
                        index = 0
                else:
                    run_write = 1
                    if phase_end:
                        finishing = 1
    elif (~ready) & (~error):
        if (~waiting) & byte_ready:
            request = 1
            waiting = 1
        elif waiting & byte_done:
            waiting = 0
            shifted: uint32_t = byte_data
            if part == 1:
                shifted = uint32_t(byte_data) << 8
            elif part == 2:
                shifted = uint32_t(byte_data) << 16
            elif part == 3:
                shifted = uint32_t(byte_data) << 24
            word: uint32_t = assembled | shifted
            if part != last_part:
                assembled = word
                part = part + 1
            else:
                pending_word = word
                validating = 1
                assembled = 0
                part = 0

    return load_t(request=request, address=address, ready=ready, error=error,
                  run_count=count, palette_write=palette_write, row_write=row_write,
                  run_write=run_write, index=write_index, data=data)
