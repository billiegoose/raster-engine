# pyright: reportInvalidTypeForm=none
"""Small real Y producers for exercising the buffer pipeline without a ROM.

These generate X records from coordinates on the FPGA. They are development
producers, not the scene/rounded-rectangle/text Y interpreter.
"""
from pypeline import *
from fpga.format import WIDTH
from fpga.pingpong import y_job_t, y_result_t


def make_procedural_y(*, stripes=False):
    @hw_func
    def produce(job: y_job_t) -> y_result_t:
        active: Reg[uint1_t] = 0
        row: Reg[uint11_t] = 0
        epoch: Reg[uint2_t] = 0
        cursor: Reg[uint11_t] = 0
        phase: Reg[uint2_t] = 0
        valid: uint1_t = 0
        end_x: uint11_t = WIDTH
        layer: uint6_t = 0
        if job.cancel:
            active = 0
        if job.start:
            row = job.row
            epoch = job.epoch
            cursor = 0
            phase = 0
            active = 1
        elif active:
            valid = 1
            if stripes:
                # 1,920 records per row. The first eleven pixels encode Y,
                # making even stale data from the same bank detectable.
                end_x = cursor + 1
                layer = uint6_t(1) + uint6_t(cursor[0] ^ row[0])
                if cursor < 11:
                    row_bit: uint1_t = uint1_t(row >> uint4_t(cursor))
                    layer = uint6_t(1) + uint6_t(cursor[0]) + (uint6_t(row_bit) << 1)
                cursor = cursor + 1
                if end_x == WIDTH:
                    active = 0
            else:
                # A skewed rectangle: visible rows 100..899, horizontal
                # position computed from Y rather than a stored X program.
                if (row >= 100) & (row < 900):
                    if phase == 0:
                        end_x = 160 + (row >> 1)
                    elif phase == 1:
                        end_x = 1120 + (row >> 1)
                        layer = 1 + uint6_t(row[4:0])
                    else:
                        active = 0
                    phase = phase + 1
                else:
                    active = 0
        return y_result_t(valid=valid, end_x=end_x, layer=layer, row=row, epoch=epoch, error=0)
    return produce
