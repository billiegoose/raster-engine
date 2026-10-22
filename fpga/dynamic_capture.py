# pyright: reportInvalidTypeForm=none
"""HDL capture of X programs generated at runtime into initially empty buffers."""
from pypeline import *
from vga.timing import make_vga_timing, VGA_1920_1080
from vga.types import vga_12bpp_t
import fpgatool_board.basys3.part35t
from fpga.board import write_video
from fpga.dynamic import make_dynamic
from fpga.dynamic_config import STRIPES

_draw = make_dynamic(stripes=STRIPES)
_sig = make_vga_timing(VGA_1920_1080, v_start=1080)


@MAIN(148.5)
def dynamic_capture():
    result = _draw(_sig(), uint1_t(1))
    px: Reg[vga_12bpp_t]
    write_video(px)
    px = result.scanout.video
    if result.deadline | result.invalid | result.scanout.underrun:
        px = vga_12bpp_t(r=15, g=0, b=15, hs=result.scanout.video.hs, vs=result.scanout.video.vs)
