# pyright: reportInvalidTypeForm=none
# pyright: reportUndefinedVariable=none
"""Basys 3 fixed-address flash ROM X-program engine, 1920x1080 at 60 Hz."""
from pypeline import *
from vga.timing import VGA_1920_1080, make_vga_timing
from vga.types import vga_12bpp_t
import fpgatool_board.basys3.part35t
import fpgatool_board.basys3.qspi as board_flash
import fpgatool_board.basys3.buttons as board_buttons
import fpgatool_board.basys3.leds as board_leds
import fpgatool_board.basys3.uart as board_uart
import hardware.SPI as spi
from hardware.xilinx7_clock import MmcmStage, make_mmcm_clock, synchronize_clock_lock
from fpga.loader import load_image, load_t
from fpga.scanout import make_scanout
from fpga.board import write_video
from fpga.diagnostics import report, debug_t

# The inherited transport's constants assume a 100 MHz calling clock. Run
# all raster state at 148.5 MHz while retaining conservative flash timings.
spi._HALF_PERIOD_CYCLES = 15  # 148.5 MHz / 30 = 4.95 MHz SCK.
spi._BYTE_POWERUP_CYCLES = 2_970_000  # 20 ms.
spi._BYTE_NORMAL_CS_HIGH_CYCLES = 15  # >=100 ns.
spi._BYTE_RECOVERY_CS_HIGH_CYCLES = 30  # >=200 ns.
spi._BYTE_RES_CYCLES = 14_850  # 100 us.

_clock = make_mmcm_clock(100.0, MmcmStage(27, 4, 5), MmcmStage(11, 2, 5))
pixel_clock: Wire[uint1_t] = make_clock(148.5)
pixel_locked: AsyncWire[uint1_t]
_timing = make_vga_timing(VGA_1920_1080)
_scanout = make_scanout()


@MAIN(100.0)
def raster_clock():
    generated = _clock(0)
    pixel_clock = generated.clock
    pixel_locked = generated.locked
    board_leds.LD0 = generated.locked


@MAIN(148.5)
def raster_engine():
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
    load = load_image(previous_ready, previous_done, previous_data, reload)
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
    board_leds.LD1 = 0
    board_leds.LD2 = 0
    board_leds.LD3 = 0
    board_leds.LD4 = 0
    board_leds.LD5 = 0
    board_leds.LD6 = 0
    board_leds.LD7 = 0
    board_leds.LD8 = 0
    board_leds.LD9 = 0
    board_leds.LD10 = 0
    board_leds.LD11 = flash.busy
    board_leds.LD12 = load.ready
    board_leds.LD13 = load.error
    board_leds.LD15 = 0


    # Isolate the loader's checksum/validation logic from the scanout's
    # high-fanout control paths. Data, writes and status share one register.
    render_load: Reg[load_t]
    diagnostic_load: load_t = render_load
    output = _scanout(_timing(), render_load)
    render_load = load
    px: Reg[vga_12bpp_t]
    write_video(px)
    if locked:
        px = output.video
    board_leds.LD14 = output.underrun
    debug_snapshot: Reg[debug_t]
    fault_snapshot: Reg[uint1_t] = 0
    board_uart.RsTx = report(diagnostic_load, debug_snapshot, fault_snapshot)
    debug_snapshot = output.debug
    fault_snapshot = output.underrun
