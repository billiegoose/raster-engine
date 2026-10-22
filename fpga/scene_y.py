# pyright: reportInvalidTypeForm=none
"""RECT/TEXT Y interpreter: update lanes, fetch masks, composite and emit RLE."""
from pypeline import *
from ram import make_ram
from fpga.pingpong import y_job_t, y_result_t
from fpga.scene_loader import assets_t
from fpga.scene_memory import make_scene_memory
from fpga.compositor import composite, lane_write_t
from fpga.format import WIDTH, HEIGHT

uint69_t = make_uint_t(69)
uint80_t = make_uint_t(80)


def make_scene_y(program=None):
    memory = make_scene_memory(program)
    descriptors, _ = make_ram(uint69_t, 64, ports=('w', 'r'), read_latency=1)

    @hw_func
    def produce(job: y_job_t, load: assets_t) -> y_result_t:
        phase: Reg[uint4_t] = 0
        row: Reg[uint11_t] = 0
        epoch: Reg[uint2_t] = 0
        lane_index: Reg[uint6_t] = 0
        pointer: Reg[uint13_t] = 0
        stop: Reg[uint13_t] = 0
        drain: Reg[uint3_t] = 0
        event_word: Reg[uint80_t] = 0
        event_valid: Reg[uint1_t] = 0
        prepared: Reg[uint69_t] = 0
        prepared_lane: Reg[uint6_t] = 0
        prepared_valid: Reg[uint1_t] = 0
        lane_write: Reg[lane_write_t]
        x: Reg[uint11_t] = 0
        previous_layer: Reg[uint6_t] = 0
        final: Reg[uint1_t] = 0
        fault: Reg[uint1_t] = 0
        check_valid: Reg[uint1_t] = 0
        check_bad: Reg[uint1_t] = 0
        check_height: Reg[uint11_t] = 0
        check_base: Reg[uint13_t] = 0
        check_solid: Reg[uint1_t] = 0
        check_limit: Reg[uint14_t] = 0
        checked_valid: Reg[uint1_t] = 0
        checked_bad: Reg[uint1_t] = 0
        checked_end: Reg[uint14_t] = 0
        checked_solid: Reg[uint1_t] = 0
        checked_limit: Reg[uint14_t] = 0
        old_phase: uint4_t = phase
        old_prepared: uint69_t = prepared
        old_prepared_lane: uint6_t = prepared_lane
        old_prepared_valid: uint1_t = prepared_valid
        old_write: lane_write_t = lane_write
        valid: uint1_t = 0
        end_x: uint11_t = 0
        color: uint6_t = previous_layer
        clear: uint1_t = job.start | job.cancel

        descriptor_write: uint1_t = event_valid & (~clear) & (old_phase != 0)
        descriptor_address: uint6_t = event_word[74:69]
        descriptor_word: uint69_t = event_word[68:0]
        # Validate raw registered event fields, independent of the descriptor
        # clear/write mux. Subtraction, end-address addition and the final
        # range decision each end at a register. All drain during setup.
        event_fault: uint1_t = checked_valid & (checked_bad | ((~checked_solid) & (checked_end > checked_limit)))
        checked_valid = check_valid & (~clear)
        checked_bad = check_bad
        checked_end = uint14_t(check_base) + uint14_t(check_height)
        checked_solid = check_solid
        checked_limit = check_limit
        check_valid = descriptor_write & (old_phase != 1)
        check_height = uint11_t(event_word[43:33]) - uint11_t(event_word[32:22])
        check_base = event_word[63:51]
        check_solid = event_word[50]
        check_limit = load.font_count
        check_bad = ((event_word[10:0] >= event_word[21:11]) | (event_word[21:11] > WIDTH) |
                     (event_word[32:22] != row) | (event_word[43:33] <= row) |
                     (event_word[43:33] > HEIGHT) | (event_word[49:44] == 0) | (event_word[68:64] > 20))
        if old_phase == 1:
            descriptor_write = 1
            descriptor_address = lane_index
            descriptor_word = 0
        desc = descriptors(descriptors.p0_in_t(addr=descriptor_address, wr_data=descriptor_word,
                                              wr_en=descriptor_write, valid=1),
                           descriptors.p1_in_t(addr=lane_index, valid=(old_phase == 7) & (~clear)))
        glyph_address: uint13_t = uint13_t(desc.p1.rd_data[63:51]) + uint13_t(row) - uint13_t(desc.p1.rd_data[32:22])
        table_address: uint11_t = row
        if old_phase == 3:
            table_address = row + 1
        resources = memory(load, table_address, ((old_phase == 2) | (old_phase == 3)) & (~clear),
                           uint12_t(pointer), (old_phase == 5) & (~clear),
                           glyph_address, desc.p1.valid & (~clear))
        prepared = desc.p1.rd_data
        prepared_lane = desc.p1.addr
        prepared_valid = desc.p1.valid & (~clear)
        lane_layer: uint6_t = old_prepared[49:44]
        if (row < old_prepared[32:22]) | (row >= old_prepared[43:33]):
            lane_layer = 0
        lane_write = lane_write_t(valid=resources.font_valid & old_prepared_valid & (~clear),
                                  lane=old_prepared_lane, left=old_prepared[10:0], right=old_prepared[21:11],
                                  layer=lane_layer, solid=old_prepared[50],
                                  ink=resources.font >> old_prepared[68:64])
        pixels = composite(old_write, x, (old_phase == 9) & (~clear), clear)
        event_word = resources.event
        event_valid = resources.event_valid & ((old_phase == 5) | (old_phase == 6)) & (~clear)

        if job.cancel:
            phase = 0
            final = 0
            fault = 0
            event_valid = 0
            prepared_valid = 0
        if job.start:
            row = job.row
            epoch = job.epoch
            lane_index = 0
            pointer = 0
            stop = 0
            drain = 0
            final = 0
            x = 0
            previous_layer = 0
            fault = 0
            event_valid = 0
            prepared_valid = 0
            phase = 2
            if job.row == 0:
                phase = 1
        elif not job.cancel:
            if old_phase == 1:
                lane_index = lane_index + 1
                if lane_index == 0:
                    phase = 2
            elif old_phase == 2:
                phase = 3
            elif old_phase == 3:
                if resources.row_valid:
                    pointer = uint13_t(resources.row)
                phase = 4
            elif old_phase == 4:
                if resources.row_valid:
                    stop = uint13_t(resources.row)
                    phase = 11
            elif old_phase == 11:
                # Row addresses are monotonic (checked during loading).
                # End the BRAM path at stop before deciding whether the
                # range is empty; no wide comparison drives the FSM here.
                drain = 0
                phase = 6
                if pointer != stop:
                    phase = 5
            elif old_phase == 5:
                pointer = pointer + 1
                if pointer == stop:
                    drain = 0
                    phase = 6
            elif old_phase == 6:
                if drain == 3:
                    lane_index = 0
                    phase = 7
                drain = drain + 1
            elif old_phase == 7:
                lane_index = lane_index + 1
                if lane_index == 0:
                    phase = 8
            elif old_phase == 8:
                if old_write.valid & (old_write.lane == 63):
                    x = 0
                    phase = 9
            elif old_phase == 9:
                x = x + 1
                if x == WIDTH:
                    phase = 10

            if event_fault:
                fault = 1
            if final:
                valid = 1
                end_x = WIDTH
                color = previous_layer
                final = 0
                phase = 0
            elif pixels.valid:
                if pixels.x == 0:
                    previous_layer = pixels.layer
                elif pixels.layer != previous_layer:
                    valid = 1
                    end_x = pixels.x
                    color = previous_layer
                    previous_layer = pixels.layer
                if pixels.x == (WIDTH-1):
                    final = 1
        return y_result_t(valid=valid, end_x=end_x, layer=color, row=row, epoch=epoch, error=fault)
    return produce
