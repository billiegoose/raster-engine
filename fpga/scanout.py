# pyright: reportInvalidTypeForm=none
"""Linear X-program interpreter: one visible-run record per clock at maximum.

All memories and the consumer share the pixel clock. Rows start with a pointer
lookup during horizontal blank; a credit-limited prefetch FIFO absorbs the
synchronous run-memory latency. RGB, active and sync have the same latency.
"""
from pypeline import *
from ram import make_ram
from fifo import make_fifo
from vga.types import vga_timing_signals_t, vga_12bpp_t
from fpga.format import HEIGHT, RUN_CAPACITY, WIDTH
from fpga.loader import load_t
from fpga.diagnostics import debug_t


@struct
class scanout_t(NamedTuple):
    video: vga_12bpp_t
    active: uint1_t
    layer: uint6_t
    underrun: uint1_t
    debug: debug_t


def make_scanout(run_init=None, row_init=None, palette_init=None):
    # This OpenXC7 mapping loses run bit 8 on a physical 9-bit BRAM port's
    # parity lane. Byte-wide banks keep every stored bit on a data lane.
    low_init = None if run_init is None else tuple(word & 255 for word in run_init)
    mid_init = None if run_init is None else tuple((word >> 8) & 255 for word in run_init)
    high_init = None if run_init is None else tuple((word >> 16) & 3 for word in run_init)
    # Limit every bank to 32K entries so the mapper cannot use the native
    # 64K-depth BRAM cascade, which this OpenXC7 router cannot connect.
    half = RUN_CAPACITY // 2
    run_low_a, _ = make_ram(uint8_t, half, ports=('w', 'r'), read_latency=1,
                           init=None if low_init is None else low_init[:half])
    run_low_b, _ = make_ram(uint8_t, half, ports=('w', 'r'), read_latency=1,
                           init=None if low_init is None else low_init[half:])
    run_mid_a, _ = make_ram(uint8_t, half, ports=('w', 'r'), read_latency=1,
                           init=None if mid_init is None else mid_init[:half])
    run_mid_b, _ = make_ram(uint8_t, half, ports=('w', 'r'), read_latency=1,
                           init=None if mid_init is None else mid_init[half:])
    run_high_a, _ = make_ram(uint2_t, half, ports=('w', 'r'), read_latency=1,
                            init=None if high_init is None else high_init[:half])
    run_high_b, _ = make_ram(uint2_t, half, ports=('w', 'r'), read_latency=1,
                            init=None if high_init is None else high_init[half:])
    rows, _ = make_ram(uint16_t, 2048, ports=('w', 'r'), read_latency=1, init=row_init)
    palette, _ = make_ram(uint12_t, 64, ports=('w', 'r'), read_latency=1, init=palette_init)
    queue, _ = make_fifo(uint18_t, 8)

    @hw_func
    def scanout(sig: vga_timing_signals_t, load: load_t) -> scanout_t:
        phase: Reg[uint2_t] = 0  # flush, row pointer in flight, prefetch/consume
        pointer: Reg[uint16_t] = 0
        last_pointer: Reg[uint16_t] = 0
        limit_reached: Reg[uint1_t] = 0
        outstanding: Reg[uint4_t] = 0
        fetched_word: Reg[uint18_t] = 0
        fetched_valid: Reg[uint1_t] = 0
        fetched_address: Reg[uint16_t] = 0
        program_y: Reg[uint11_t] = 0
        debug: Reg[debug_t]
        previous_end: Reg[uint11_t] = 0
        stream_error: Reg[uint1_t] = 0
        ended: Reg[uint1_t] = 0
        end_x: Reg[uint11_t] = 0
        layer: Reg[uint6_t] = 0
        fault: Reg[uint1_t] = 0
        underrun: Reg[uint1_t] = 0
        display: Reg[uint1_t] = 0
        primed: Reg[uint1_t] = 0
        delayed_active: Reg[uint1_t] = 0
        delayed_hs: Reg[uint1_t] = 0
        delayed_vs: Reg[uint1_t] = 0
        delayed_layer: Reg[uint6_t] = 0
        active_stage: Reg[uint1_t] = 0
        hs_stage: Reg[uint1_t] = 0
        vs_stage: Reg[uint1_t] = 0
        layer_stage: Reg[uint6_t] = 0

        # Capture old pipeline registers before assigning their next values.
        output_active: uint1_t = delayed_active
        output_hs: uint1_t = delayed_hs
        output_vs: uint1_t = delayed_vs
        output_layer: uint6_t = delayed_layer
        current_last_pointer: uint16_t = last_pointer
        palette_index: uint6_t = layer
        checked_word: uint18_t = fetched_word
        checked_valid: uint1_t = fetched_valid
        checked_address: uint16_t = fetched_address
        old_credits: uint4_t = outstanding
        bad_reason: uint3_t = 0
        bad_address: uint16_t = checked_address
        bad_word: uint18_t = checked_word
        old_previous_end: uint11_t = previous_end
        old_stream_error: uint1_t = stream_error
        stage_active: uint1_t = active_stage
        stage_hs: uint1_t = hs_stage
        stage_vs: uint1_t = vs_stage
        stage_layer: uint6_t = layer_stage
        first_blank: uint1_t = sig.pos.x == WIDTH
        row_request: uint1_t = (sig.pos.x == (WIDTH+8)) & load.ready
        next_y: uint11_t = 0
        if sig.pos.y < (HEIGHT-1):
            next_y = sig.pos.y + 1
        row_result = rows(rows.p0_in_t(addr=load.index[10:0], wr_data=uint16_t(load.data),
                                     wr_en=load.row_write, valid=1),
                          rows.p1_in_t(addr=next_y, valid=row_request))

        request: uint1_t = ((phase == 2) & load.ready & (~first_blank) &
                            (~ended) & (~outstanding[3]) & (~limit_reached) & (~old_stream_error))
        write_upper: uint1_t = load.index[15]
        read_upper: uint1_t = pointer[15]
        low_a = run_low_a(run_low_a.p0_in_t(addr=load.index[14:0], wr_data=uint8_t(load.data),
                                          wr_en=load.run_write & (~write_upper), valid=1),
                          run_low_a.p1_in_t(addr=pointer[14:0], valid=request & (~read_upper)))
        low_b = run_low_b(run_low_b.p0_in_t(addr=load.index[14:0], wr_data=uint8_t(load.data),
                                          wr_en=load.run_write & write_upper, valid=1),
                          run_low_b.p1_in_t(addr=pointer[14:0], valid=request & read_upper))
        mid_a = run_mid_a(run_mid_a.p0_in_t(addr=load.index[14:0], wr_data=uint8_t(load.data >> 8),
                                          wr_en=load.run_write & (~write_upper), valid=1),
                          run_mid_a.p1_in_t(addr=pointer[14:0], valid=request & (~read_upper)))
        mid_b = run_mid_b(run_mid_b.p0_in_t(addr=load.index[14:0], wr_data=uint8_t(load.data >> 8),
                                          wr_en=load.run_write & write_upper, valid=1),
                          run_mid_b.p1_in_t(addr=pointer[14:0], valid=request & read_upper))
        high_a = run_high_a(run_high_a.p0_in_t(addr=load.index[14:0], wr_data=uint2_t(load.data >> 16),
                                             wr_en=load.run_write & (~write_upper), valid=1),
                            run_high_a.p1_in_t(addr=pointer[14:0], valid=request & (~read_upper)))
        high_b = run_high_b(run_high_b.p0_in_t(addr=load.index[14:0], wr_data=uint2_t(load.data >> 16),
                                             wr_en=load.run_write & write_upper, valid=1),
                            run_high_b.p1_in_t(addr=pointer[14:0], valid=request & read_upper))
        low_word: uint8_t = 0
        mid_word: uint8_t = 0
        high_word: uint2_t = 0
        response_address: uint16_t = uint16_t(low_a.p1.addr)
        if low_a.p1.valid:
            low_word = low_a.p1.rd_data
        if low_b.p1.valid:
            low_word = low_b.p1.rd_data
            response_address = uint16_t(low_b.p1.addr) | uint16_t(32768)
        if mid_a.p1.valid:
            mid_word = mid_a.p1.rd_data
        if mid_b.p1.valid:
            mid_word = mid_b.p1.rd_data
        if high_a.p1.valid:
            high_word = high_a.p1.rd_data
        if high_b.p1.valid:
            high_word = high_b.p1.rd_data
        fetched_word = uint18_t(low_word) | (uint18_t(mid_word) << 8) | (uint18_t(high_word) << 16)
        fetched_valid = low_a.p1.valid | low_b.p1.valid
        fetched_address = response_address
        offer: uint1_t = checked_valid & (phase == 2) & (~first_blank) & (~ended) & load.ready & (~old_stream_error)
        boundary: uint1_t = sig.active & (sig.pos.x == end_x) & (~fault) & (~old_stream_error) & (display | (sig.start_of_frame & primed)) & load.ready
        flush: uint1_t = (phase != 2) | first_blank | (~load.ready)
        fifo = queue(boundary | flush, checked_word, offer)

        if not load.ready:
            display = 0
            primed = 0
            phase = 0
            outstanding = 0
            end_x = 0
            fault = 0
            underrun = 0
            stream_error = 0
            previous_end = 0
            debug = debug_t(reason=0, x=0, y=0, row=0, word=0, address=0, previous_end=0, credits=0)
        else:
            last_pointer = uint16_t(load.run_count - 1)
            if (phase == 2) & fifo.data_out_valid:
                primed = 1
            if sig.start_of_frame & primed:
                display = 1
            if first_blank:
                phase = 0
                outstanding = 0
                ended = 0
                limit_reached = 0
                end_x = 0
                fault = 0
                stream_error = 0
                previous_end = 0
            elif row_request:
                phase = 1
            elif (phase == 1) & row_result.p1.valid:
                pointer = row_result.p1.rd_data
                program_y = row_result.p1.addr
                ended = 0
                limit_reached = 0
                previous_end = 0
                phase = 2
            elif phase == 2:
                take: uint1_t = boundary & fifo.data_out_valid
                if request & (~take):
                    outstanding = outstanding + 1
                elif take & (~request):
                    outstanding = outstanding - 1
                if request:
                    if pointer == current_last_pointer:
                        limit_reached = 1
                    pointer = pointer + 1
                if offer:
                    incoming_end: uint11_t = checked_word[16:6]
                    if checked_word[17] | (incoming_end <= previous_end) | (incoming_end > WIDTH):
                        stream_error = 1
                        bad_reason = 2
                    previous_end = incoming_end
                    if incoming_end == WIDTH:
                        ended = 1
                if old_stream_error:
                    fault = 1
                    underrun = 1
                if offer & (~fifo.data_in_ready):
                    fault = 1
                    underrun = 1
                    bad_reason = 3

            if boundary:
                word: uint18_t = fifo.data_out
                endpoint: uint11_t = uint11_t(word >> 6)
                if ~fifo.data_out_valid:
                    fault = 1
                    underrun = 1
                    bad_reason = 1
                    bad_address = pointer
                    bad_word = fifo.data_out
                else:
                    end_x = endpoint
                    layer = word[5:0]

        if (debug.reason == 0) & (bad_reason != 0):
            debug = debug_t(reason=bad_reason, x=sig.pos.x, y=sig.pos.y, row=program_y,
                            word=bad_word, address=bad_address, previous_end=old_previous_end,
                            credits=old_credits)

        # Register the selected index before palette lookup. Geometry checks
        # happen in prefetch, keeping comparisons and palette RAM off one path.
        color_result = palette(palette.p0_in_t(addr=load.index[5:0], wr_data=uint12_t(load.data),
                                             wr_en=load.palette_write, valid=1),
                               palette.p1_in_t(addr=palette_index, valid=1))
        active_stage = sig.active & display & load.ready & (~fault)
        hs_stage = sig.hsync
        vs_stage = sig.vsync
        layer_stage = layer
        delayed_active = stage_active
        delayed_hs = stage_hs
        delayed_vs = stage_vs
        delayed_layer = stage_layer
        color: uint12_t = 0
        if output_active:
            color = color_result.p1.rd_data
        return scanout_t(video=vga_12bpp_t(r=color[11:8], g=color[7:4], b=color[3:0],
                                          hs=output_hs, vs=output_vs),
                         active=output_active, layer=output_layer, underrun=underrun, debug=debug)

    return scanout
