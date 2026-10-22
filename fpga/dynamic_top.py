# pyright: reportInvalidTypeForm=none
# pyright: reportUndefinedVariable=none
"""Development bitstream for the two-buffer runtime producer (no flash assets)."""
from pypeline import *
from vga.timing import make_vga_timing, VGA_1920_1080
from vga.types import vga_12bpp_t
from hardware.xilinx7_clock import MmcmStage, make_mmcm_clock, synchronize_clock_lock
import fpgatool_board.basys3.part35t
import fpgatool_board.basys3.leds as leds
from fpga.board import write_video
from fpga.dynamic import make_dynamic
from fpga.dynamic_config import STRIPES

_clock = make_mmcm_clock(100.0, MmcmStage(27, 4, 5), MmcmStage(11, 2, 5))
pixel_clock: Wire[uint1_t] = make_clock(148.5)
pixel_locked: AsyncWire[uint1_t]
_sig = make_vga_timing(VGA_1920_1080)
_draw = make_dynamic(stripes=STRIPES)


@MAIN(100.0)
def dynamic_clock():
    generated = _clock(0)
    pixel_clock = generated.clock
    pixel_locked = generated.locked
    leds.LD0 = generated.locked


@MAIN(148.5)
def dynamic_engine():
    locked = synchronize_clock_lock(pixel_locked)
    result = _draw(_sig(), locked)
    px: Reg[vga_12bpp_t]
    write_video(px)
    if locked:
        px = result.scanout.video
    leds.LD1 = 0
    leds.LD2 = 0
    leds.LD3 = 0
    leds.LD4 = 0
    leds.LD5 = 0
    leds.LD6 = 0
    leds.LD7 = 0
    leds.LD8 = 0
    leds.LD9 = 0
    leds.LD10 = 0
    leds.LD11 = 0
    leds.LD12 = result.ready
    leds.LD13 = result.invalid
    leds.LD14 = result.scanout.underrun
    leds.LD15 = result.deadline
