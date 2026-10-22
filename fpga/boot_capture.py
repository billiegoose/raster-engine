# pyright: reportInvalidTypeForm=none
# pyright: reportUndefinedVariable=none
"""HDL boot capture with empty scanout RAMs and a binary-backed byte source.

The loader and RAM write ports run as hardware on the pixel clock, just as
on the board. A fast byte ROM replaces SPI; an ideal clock replaces the MMCM.
"""
from pathlib import Path
from pypeline import *
from ram import make_ram
from vga.timing import make_vga_timing, VGA_1920_1080
from vga.types import vga_12bpp_t
import fpgatool_board.basys3.part35t
from fpga.format import FLASH_BASE
from fpga.loader import load_image, load_t
from fpga.scanout import make_scanout
from fpga.board import write_video

_binary = Path(__file__).with_name('simulation.bin').read_bytes()
_size = 1 << (len(_binary)-1).bit_length()
_bytes, _ = make_ram(uint8_t, _size, ports=('r',), read_latency=1, init=tuple(_binary))
_draw = make_scanout()
_sig = make_vga_timing(VGA_1920_1080, v_start=1124)


@MAIN(148.5)
def raster_boot_capture():
    previous_ready: Reg[uint1_t] = 1
    previous_done: Reg[uint1_t] = 0
    previous_data: Reg[uint8_t] = 0
    load = load_image(previous_ready, previous_done, previous_data, 0)
    data = _bytes(_bytes.p0_in_t(addr=load.address-FLASH_BASE, valid=load.request))
    previous_ready = (~load.request) & (~data.p0.valid)
    previous_done = data.p0.valid
    previous_data = data.p0.rd_data
    render_load: Reg[load_t]
    result = _draw(_sig(), render_load)
    render_load = load
    px: Reg[vga_12bpp_t]
    write_video(px)
    px = result.video
    # Surface a sticky fault in the PNG, even if it happened before capture.
    if result.underrun | load.error:
        px = vga_12bpp_t(r=15, g=0, b=15, hs=result.video.hs, vs=result.video.vs)
