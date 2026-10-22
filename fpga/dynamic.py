# pyright: reportInvalidTypeForm=none
"""Wire a procedural Y producer to the two-buffer controller and X engine."""
from pypeline import *
from vga.types import vga_timing_signals_t
from fpga.pingpong import schedule, y_result_t
from fpga.loader import load_t
from fpga.procedural_y import make_procedural_y
from fpga.scanout import make_scanout, scanout_t

DEMO_PALETTE = (0,) + tuple(((i & 15) << 8) | (((i >> 2) & 15) << 4) | 5 for i in range(1, 64))


@struct
class dynamic_t(NamedTuple):
    scanout: scanout_t
    deadline: uint1_t
    invalid: uint1_t
    ready: uint1_t


def make_dynamic(*, stripes=False):
    producer = make_procedural_y(stripes=stripes)
    draw = make_scanout(palette_init=DEMO_PALETTE, buffered=True)

    @hw_func
    def dynamic(sig: vga_timing_signals_t, enabled: uint1_t) -> dynamic_t:
        pending: Reg[y_result_t]
        beam: Reg[vga_timing_signals_t]
        render_load: Reg[load_t]
        render_sig: Reg[vga_timing_signals_t]
        # VGA counter carry propagation must finish before the scheduler's
        # next-row arithmetic, tag checks and producer start muxes.
        status = schedule(beam, enabled, pending)
        pending = producer(status.job)
        # Keep deadline/ownership decisions off the FIFO and RAM control
        # paths. Delay beam coordinates with the complete write/status bundle
        # so the first row's prefetch request still sees its ready flag.
        output = draw(render_sig, render_load)
        render_sig = beam
        render_load = status.load
        beam = sig
        return dynamic_t(scanout=output, deadline=status.deadline,
                         invalid=status.invalid, ready=status.load.ready)
    return dynamic
