# pyright: reportInvalidTypeForm=none
# pyright: reportUndefinedVariable=none
"""Basys 3 fixed-flash RECT/TEXT Y-program engine, one 148.5 MHz clock."""
from pypeline import *
from vga.timing import VGA_1920_1080, make_vga_timing
from vga.types import vga_12bpp_t
import fpgatool_board.basys3.part35t
import fpgatool_board.basys3.qspi as board_flash
import fpgatool_board.basys3.buttons as board_buttons
import fpgatool_board.basys3.leds as leds
import fpgatool_board.basys3.uart as board_uart
import hardware.SPI as spi
from hardware.xilinx7_clock import MmcmStage, make_mmcm_clock, synchronize_clock_lock
from fpga.scene_loader import load_scene, assets_t
from fpga.scene_dynamic import make_scene_engine, scene_output_t
from fpga.scene_diagnostics import report_scene
from fpga.board import write_video

spi._HALF_PERIOD_CYCLES = 15
spi._BYTE_POWERUP_CYCLES = 2_970_000
spi._BYTE_NORMAL_CS_HIGH_CYCLES = 15
spi._BYTE_RECOVERY_CS_HIGH_CYCLES = 30
spi._BYTE_RES_CYCLES = 14_850
_clock = make_mmcm_clock(100.0, MmcmStage(27, 4, 5), MmcmStage(11, 2, 5))
pixel_clock: Wire[uint1_t] = make_clock(148.5)
pixel_locked: AsyncWire[uint1_t]
_timing = make_vga_timing(VGA_1920_1080)
_draw = make_scene_engine()


@MAIN(100.0)
def scene_clock():
    generated = _clock(0)
    pixel_clock = generated.clock
    pixel_locked = generated.locked
    leds.LD0 = generated.locked


@MAIN(148.5)
def scene_engine():
    locked = synchronize_clock_lock(pixel_locked)
    previous_ready: Reg[uint1_t] = 0
    previous_done: Reg[uint1_t] = 0
    previous_data: Reg[uint8_t] = 0
    button_meta: Reg[uint1_t] = 0
    button_sync: Reg[uint1_t] = 0
    button_previous: Reg[uint1_t] = 0
    pending_reload: Reg[uint1_t] = 0
    if button_sync & (~button_previous):
        pending_reload = 1
    button_previous = button_sync
    button_sync = button_meta
    button_meta = board_buttons.BTNC
    reload: uint1_t = pending_reload & previous_ready
    if reload:
        pending_reload = 0
    load = load_scene(previous_ready, previous_done, previous_data, reload)
    flash = spi.flash_byte_io(board_flash.QspiDQ1_I, uint2_t(load.request), load.address, uint8_t(0))
    previous_ready = flash.ready
    previous_done = flash.done
    previous_data = flash.read_data
    board_flash.QspiCSn = board_flash.drive_clock_and_cs(flash.cclk, flash.cs_n, not flash.busy)
    board_flash.QspiDQ0_O = flash.dq0
    board_flash.QspiDQ0_T = 0
    board_flash.QspiDQ1_O = 0
    board_flash.QspiDQ1_T = 1
    board_flash.QspiDQ2_O = flash.dq2
    board_flash.QspiDQ2_T = 0
    board_flash.QspiDQ3_O = flash.dq3
    board_flash.QspiDQ3_T = 0
    render_assets: Reg[assets_t]
    observed_assets: assets_t = render_assets
    output = _draw(_timing(), render_assets, locked)
    render_assets = load
    px: Reg[vga_12bpp_t]
    write_video(px)
    if locked:
        px = output.scanout.video
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
    leds.LD11 = flash.busy
    leds.LD12 = load.ready
    leds.LD13 = load.error | output.invalid
    leds.LD14 = output.scanout.underrun
    leds.LD15 = output.deadline
    diagnostic_assets: Reg[assets_t]
    diagnostic_state: Reg[scene_output_t]
    board_uart.RsTx = report_scene(diagnostic_assets, diagnostic_state)
    diagnostic_assets = observed_assets
    diagnostic_state = output
