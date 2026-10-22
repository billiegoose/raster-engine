# pyright: reportInvalidTypeForm=none
# pyright: reportUndefinedVariable=none
"""First-fault record and repeating 115200-baud USB UART diagnostic packets."""
from pypeline import *
import hardware.uart as uart
from fpga.loader import load_t
from fpga.format import FLASH_BASE

uart.BAUD_DIV = 1289  # 148.5 MHz / 1289 = 115205.6 baud.
uart.HALF_BAUD_DIV = 644


@struct
class debug_t(NamedTuple):
    reason: uint3_t  # 1: empty FIFO; 2: invalid run; 3: full FIFO.
    x: uint12_t
    y: uint11_t
    row: uint11_t
    word: uint18_t
    address: uint16_t
    previous_end: uint11_t
    credits: uint4_t


@hw_func
def report(load: load_t, debug: debug_t, underrun: uint1_t) -> uint1_t:
    palette_writes: Reg[uint16_t] = 0
    row_writes: Reg[uint16_t] = 0
    run_writes: Reg[uint32_t] = 0
    checksum: Reg[uint32_t] = 0
    old_palette_writes: uint16_t = palette_writes
    old_row_writes: uint16_t = row_writes
    old_run_writes: uint32_t = run_writes
    old_checksum: uint32_t = checksum
    if load.request & (load.address == FLASH_BASE):
        palette_writes = 0
        row_writes = 0
        run_writes = 0
        checksum = 0
    else:
        if load.palette_write:
            palette_writes = palette_writes + 1
        if load.row_write:
            row_writes = row_writes + 1
        if load.run_write:
            run_writes = run_writes + 1
        if load.palette_write | load.row_write | load.run_write:
            checksum = checksum + load.data

    flags: uint8_t = uint8_t(load.ready) | (uint8_t(load.error) << 1) | (uint8_t(underrun) << 2)
    packet: uint8_t[36] = [
        82, 88, 68, 50, flags, uint8_t(debug.reason),
        uint8_t(debug.x), uint8_t(debug.x >> 8),
        uint8_t(debug.y), uint8_t(debug.y >> 8),
        uint8_t(debug.row), uint8_t(debug.row >> 8),
        uint8_t(debug.word), uint8_t(debug.word >> 8), uint8_t(debug.word >> 16), 0,
        uint8_t(debug.address), uint8_t(debug.address >> 8),
        uint8_t(debug.previous_end), uint8_t(debug.previous_end >> 8),
        uint8_t(debug.credits), 0,
        uint8_t(old_palette_writes), uint8_t(old_palette_writes >> 8),
        uint8_t(old_row_writes), uint8_t(old_row_writes >> 8),
        uint8_t(old_run_writes), uint8_t(old_run_writes >> 8), uint8_t(old_run_writes >> 16), uint8_t(old_run_writes >> 24),
        uint8_t(old_checksum), uint8_t(old_checksum >> 8), uint8_t(old_checksum >> 16), uint8_t(old_checksum >> 24),
        13, 10]
    index: Reg[uint6_t] = 0
    pause: Reg[uint24_t] = 0
    data: Reg[uint8_t] = 0
    sequence: Reg[uint8_t] = 0
    acknowledged: Reg[uint8_t] = 0
    queued_data: uint8_t = data
    queued_sequence: uint8_t = sequence
    if sequence == acknowledged:
        if pause != 0:
            pause = pause - 1
        else:
            data = packet[index]
            sequence = sequence + 1
            if index == 35:
                index = 0
                pause = 14_850_000  # Repeat every 100 ms, plus UART time.
            else:
                index = index + 1
    sent = uart.uart_echo(uint1_t(1), queued_data, queued_sequence)
    acknowledged = sent.accepted_seq
    return sent.tx
