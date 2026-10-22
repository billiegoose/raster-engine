# pyright: reportInvalidTypeForm=none
# pyright: reportUndefinedVariable=none
"""HDL capture harness: same X interpreter, initialized from the exported ABI.

An ideal pixel clock replaces the board MMCM; file bytes replace the slow
boot-time flash transfer. The scanout hardware is unchanged.
"""
from pathlib import Path
from pypeline import *
from vga.timing import make_vga_timing, VGA_1920_1080
from vga.types import vga_12bpp_t
import fpgatool_board.basys3.part35t
from fpga.image import decode
from fpga.loader import load_t
from fpga.scanout import make_scanout
from fpga.board import write_video

_image = decode(Path(__file__).with_name('simulation.bin').read_bytes())
RUN_COUNT = len(_image.runs)
_draw = make_scanout(_image.runs, _image.rows, _image.palette)
_sig = make_vga_timing(VGA_1920_1080, v_start=1124)


@MAIN(148.5)
def raster_capture():
    sig = _sig()
    # Keep the status constructor in hardware rather than folding an entire
    # NamedTuple into a Python constant in the current compiler.
    load = load_t(request=0, address=0, ready=sig.pos.x < 2200, error=0, run_count=RUN_COUNT,
                  palette_write=0, row_write=0, run_write=0, index=0, data=0)
    result = _draw(sig, load)
    px: Reg[vga_12bpp_t]
    write_video(px)
    px = result.video
