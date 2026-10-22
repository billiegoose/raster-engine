# pyright: reportInvalidTypeForm=none
"""Coherent RYD2 UART snapshots of scene loading and Y job deadlines."""
from pypeline import *
import hardware.uart as uart
from fpga.scene_loader import assets_t
from fpga.scene_dynamic import scene_output_t
from fpga.format import FLASH_BASE

uart.BAUD_DIV = 1289
uart.HALF_BAUD_DIV = 644


@hw_func
def report_scene(load: assets_t, state: scene_output_t) -> uint1_t:
    event_bytes: Reg[uint16_t] = 0
    font_bytes: Reg[uint16_t] = 0
    palette_writes: Reg[uint16_t] = 0
    row_writes: Reg[uint16_t] = 0
    checksum: Reg[uint32_t] = 0
    sum_delta: Reg[uint9_t] = 0
    cycles: Reg[uint12_t] = 0
    was_busy: Reg[uint1_t] = 0
    maximum: Reg[uint12_t] = 0
    maximum_row: Reg[uint11_t] = 0
    previous_events: uint16_t = event_bytes
    previous_font: uint16_t = font_bytes
    previous_palette: uint16_t = palette_writes
    previous_rows: uint16_t = row_writes
    previous_sum: uint32_t = checksum
    previous_maximum: uint12_t = maximum
    previous_maximum_row: uint11_t = maximum_row
    checksum = checksum + sum_delta
    sum_delta = 0
    if load.event_write:
        event_bytes = event_bytes + 1
    if load.font_write:
        font_bytes = font_bytes + 1
    if load.palette_write:
        palette_writes = palette_writes + 1
    if load.row_write:
        row_writes = row_writes + 1
    if load.palette_write | load.row_write:
        sum_delta = uint9_t(load.data[7:0]) + uint9_t(load.data[15:8])
    elif load.event_write | load.font_write:
        sum_delta = uint9_t(load.data[7:0])
    if state.job.start:
        cycles = 0
    elif state.busy:
        cycles = cycles + 1
    elif was_busy:
        if cycles > maximum:
            maximum = cycles
            maximum_row = state.job.row
    was_busy = state.busy
    if load.request & (load.address == FLASH_BASE):
        event_bytes = 0
        font_bytes = 0
        palette_writes = 0
        row_writes = 0
        checksum = 0
        sum_delta = 0
        maximum = 0
        maximum_row = 0
    flags: uint8_t = uint8_t(load.ready) | (uint8_t(load.error) << 1) | (uint8_t(state.invalid) << 2) | (uint8_t(state.deadline) << 3) | (uint8_t(state.scanout.underrun) << 4)
    packet: uint8_t[32] = [82, 89, 68, 50, flags, 0,
        uint8_t(load.event_count), uint8_t(load.event_count >> 8),
        uint8_t(load.font_count), uint8_t(load.font_count >> 8),
        uint8_t(previous_maximum), uint8_t(previous_maximum >> 8),
        uint8_t(previous_maximum_row), uint8_t(previous_maximum_row >> 8),
        uint8_t(previous_events), uint8_t(previous_events >> 8),
        uint8_t(previous_font), uint8_t(previous_font >> 8),
        uint8_t(previous_palette), uint8_t(previous_palette >> 8),
        uint8_t(previous_rows), uint8_t(previous_rows >> 8),
        uint8_t(previous_sum), uint8_t(previous_sum >> 8), uint8_t(previous_sum >> 16), uint8_t(previous_sum >> 24),
        0, 0, 0, 0, 13, 10]
    snapshot: Reg[uint8_t[32]]
    index: Reg[uint5_t] = 0
    pause: Reg[uint24_t] = 0
    data: Reg[uint8_t] = 0
    sequence: Reg[uint8_t] = 0
    acknowledged: Reg[uint8_t] = 0
    old_data: uint8_t = data
    old_sequence: uint8_t = sequence
    if sequence == acknowledged:
        if pause != 0:
            pause = pause - 1
        else:
            data = snapshot[index]
            if index == 0:
                snapshot = packet
                data = 82
            sequence = sequence + 1
            if index == 31:
                index = 0
                pause = 14_850_000
            else:
                index = index + 1
    sent = uart.uart_echo(uint1_t(1), old_data, old_sequence)
    acknowledged = sent.accepted_seq
    return sent.tx
