# pyright: reportInvalidTypeForm=none
from pathlib import Path
from pypeline import *
from vga.timing import make_vga_timing, VGA_1920_1080
from vga.types import vga_12bpp_t
import fpgatool_board.basys3.part35t
from fpga.scene_compile import decode_scene
from fpga.scene_loader import assets_t
from fpga.scene_dynamic import make_scene_engine
from fpga.board import write_video

_program = decode_scene(Path(__file__).with_name('scene.bin').read_bytes())
EVENT_COUNT = len(_program[2])
FONT_COUNT = len(_program[3])
_draw = make_scene_engine(_program)
_sig = make_vga_timing(VGA_1920_1080, v_start=1080)


@MAIN(148.5)
def scene_capture():
    sig = _sig()
    assets = assets_t(request=0, address=0, ready=sig.pos.x < 2200, error=0, palette_write=0, row_write=0,
                      event_write=0, font_write=0, index=0, part=0, data=0,
                      event_count=EVENT_COUNT, font_count=FONT_COUNT)
    result = _draw(sig, assets, uint1_t(1))
    px: Reg[vga_12bpp_t]
    write_video(px)
    px = result.scanout.video
    if result.deadline | result.invalid | result.scanout.underrun:
        px = vga_12bpp_t(r=15, g=0, b=15, hs=result.scanout.video.hs, vs=result.scanout.video.vs)
