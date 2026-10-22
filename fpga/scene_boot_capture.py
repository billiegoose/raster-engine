# pyright: reportInvalidTypeForm=none
"""Empty memories -> hardware RY02 loader -> Y compositor -> X interpreter."""
from pathlib import Path
from pypeline import *
from ram import make_ram
from vga.timing import make_vga_timing, VGA_1920_1080
from vga.types import vga_12bpp_t
import fpgatool_board.basys3.part35t
from fpga.format import FLASH_BASE
from fpga.scene_loader import load_scene, assets_t
from fpga.scene_dynamic import make_scene_engine
from fpga.board import write_video

_binary = Path(__file__).with_name('scene.bin').read_bytes()
_bytes, _ = make_ram(uint8_t, 1 << (len(_binary)-1).bit_length(), ports=('r',), read_latency=1, init=tuple(_binary))
_draw = make_scene_engine()
_sig = make_vga_timing(VGA_1920_1080, v_start=1080)


@MAIN(148.5)
def scene_boot_capture():
    previous_ready: Reg[uint1_t] = 1
    previous_done: Reg[uint1_t] = 0
    previous_data: Reg[uint8_t] = 0
    load = load_scene(previous_ready, previous_done, previous_data, 0)
    data = _bytes(_bytes.p0_in_t(addr=load.address-FLASH_BASE, valid=load.request))
    previous_ready = (~load.request) & (~data.p0.valid)
    previous_done = data.p0.valid
    previous_data = data.p0.rd_data
    render_assets: Reg[assets_t]
    result = _draw(_sig(), render_assets, uint1_t(1))
    render_assets = load
    px: Reg[vga_12bpp_t]
    write_video(px)
    px = result.scanout.video
    if result.deadline | result.invalid | result.scanout.underrun | load.error:
        px = vga_12bpp_t(r=15, g=0, b=15, hs=result.scanout.video.hs, vs=result.scanout.video.vs)
