# pyright: reportInvalidTypeForm=none
"""Fixed-palette RECT/TEXT producer connected to the two X buffers."""
from pypeline import *
from vga.types import vga_timing_signals_t
from fpga.pingpong import schedule, y_result_t, y_job_t
from fpga.scene_loader import assets_t
from fpga.scene_y import make_scene_y
from fpga.scanout import make_scanout, scanout_t
from fpga.loader import load_t


@struct
class scene_output_t(NamedTuple):
    scanout: scanout_t
    deadline: uint1_t
    invalid: uint1_t
    ready: uint1_t
    job: y_job_t
    busy: uint1_t


def make_scene_engine(program=None):
    producer = make_scene_y(program)
    draw = make_scanout(palette_init=None if program is None else program[0], buffered=True)

    @hw_func
    def engine(sig: vga_timing_signals_t, assets: assets_t, enabled: uint1_t) -> scene_output_t:
        pending: Reg[y_result_t]
        producer_job: Reg[y_job_t]
        beam: Reg[vga_timing_signals_t]
        render_sig: Reg[vga_timing_signals_t]
        render_load: Reg[load_t]
        scanout_fault: Reg[uint1_t] = 0
        state = schedule(beam, enabled & assets.ready & (~assets.error), pending)
        # Ownership checks must end before producer controls fan out to all
        # 64 lanes. The extra job clock is included in the line budget.
        pending = producer(producer_job, assets)
        producer_job = state.job
        output = draw(render_sig, render_load)
        # A frame boundary resets the consumer's per-frame ready state.
        # Keep any earlier fault observable until assets are reloaded.
        if output.underrun:
            scanout_fault = 1
        if not assets.ready:
            scanout_fault = 0
        observed = scanout_t(video=output.video, active=output.active, layer=output.layer,
                             underrun=scanout_fault, debug=output.debug)
        write_index: uint16_t = state.load.index
        write_data: uint18_t = state.load.data
        if assets.palette_write:
            write_index = assets.index
            write_data = assets.data
        render_load = load_t(request=0, address=0, ready=state.load.ready, error=assets.error,
                             run_count=4096, palette_write=assets.palette_write, row_write=0,
                             run_write=state.load.run_write, index=write_index, data=write_data)
        render_sig = beam
        beam = sig
        return scene_output_t(scanout=observed, deadline=state.deadline, invalid=state.invalid,
                              ready=state.load.ready, job=state.job, busy=state.busy)
    return engine
