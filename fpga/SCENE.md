# Dynamic RECT + TEXT engine

This target rebuilds each scanline's X program on the FPGA. It implements
square-cornered rectangles and transparent RED2 text with the initial fixed
64-entry RGB444 palette. Rectangle radii and palette-change events are ignored.
The baked RX01 engine remains available as a separate target.

The compiler lowers TEXT to positioned glyph draw records, applying the
existing UTF-8 decoder, two-glyph kerning history, newlines, wrapping, buffer
snapshots and clipping rules. It stores reusable 21-bit glyph shapes, not
rendered text rows. The FPGA updates active RECT/glyph records for each Y,
fetches the appropriate glyph rows, clips their masks, resolves overlapping
layers and compresses the resulting pixels into a linear X program. Text
layout is a host compiler operation; glyph rasterization and composition run
on the FPGA.

This version does not reuse fpgatool's UART text compositor and pixel FIFO.
That path combines UTF-8 layout, overlap ink and a single text pixel stream.
Here, independent text objects must remain transparent between RECT layers.
The positioned-glyph representation gives each row a fixed setup bound and
uses the existing RED2 font and layout rules. Moving layout onto the FPGA
later could reuse the streaming decoder/kerning logic behind an object-aware
interface; the X-buffer scheduler would not need to change.

Amber uses **443 draw records**, **45 glyph shapes**, and at most **55 active
records**. Its RY03 binary is **47,442 bytes**. It contains no final visible
scanlines or X programs. The compiler's output is checked against the existing
software renderer, including separate cases for Unicode, narrow wrapping,
oversized glyphs, negative X clipping and independent text buffer lengths.

## Scanline pipeline

Everything runs on the same 148.5 MHz pixel clock. Y builds row n+1 while X
executes row n; even and odd rows alternate the two 2,048-entry X buffers.
Publication, row tags, cancellation and missed deadlines use the controller in
[PINGPONG.md](PINGPONG.md). The producer job has its own register so scheduler
decisions cannot propagate through every compositor lane in one clock.

For each Y job, the producer:

1. Reads the start/end of that row's Y-event range.
2. Applies RECT/TEXT event records to an active-record table. Records expire
   at their bottom Y; a later event can reuse the lane without a delete opcode.
3. Refreshes all 64 lanes from the active table and packed glyph ROM, one per three clocks.
4. Sweeps 1,920 X coordinates, one per clock. Each lane tests its rectangle or
   shifts its glyph mask. Visibility and coverage registers precede the six-stage maximum
   tree, which selects the
   highest visible layer. Equal-layer overlaps combine transparently.
5. Emits a run only when the selected layer changes, then emits the exclusive
   endpoint 1920 to commit the complete row.

The active table is cleared at the start of each frame's row-zero job during
vertical blank. This prevents stale records after reload or recovery.
The X sweep advances monotonically. Each lane counts down its distances to
the left/right boundaries and applies a registered glyph shift. A local
one-bit visibility register separates geometry from the color tree. This
avoids distributing the global X coordinate to all 64 lanes.
An event row can introduce at most 64 simultaneously active records; all
geometry setup has a fixed bound before the 1,920-clock sweep. First-row
initialization has the vertical blank budget. No full-frame pixel buffer or
linked X list is used.

Limits checked before programming: **64 simultaneous RECT/glyph records**,
**4,096 total draw events**, and a **2,048-word compressed font** with at most
512 distinct row patterns. Font capacity depends on cropped row count and
shared patterns; all 73 UART-demo glyphs fit, including the four triangles. All 85 glyphs
currently supported by this engine, including box glyphs and the fallback,
also fit: 1,938 words (3,876 bytes).
All endpoints and glyph clipping are integer and binary. The hardware also
checks loaded resource ranges/checksum and generated record bounds.

Font storage crops each glyph's blank vertical margins and dictionary-codes
repeated 21-bit rows. Three packed bytes per unique pattern precede one
nine-bit row ID per sixteen-bit word. Amber uses 873 cropped rows and 213
patterns: 320 dictionary words plus 873 row-ID words, or 2,386 bytes.

Both tables share two 2,048-byte RAM banks (one 36 Kbit block equivalent).
Each bank has one read/write port and one read port. During upload the loader
uses the writable port; during rendering the two ports fetch adjacent
sixteen-bit dictionary words. The decoder registers dictionary addresses and
extracts either byte alignment. Descriptor tags follow the memory pipeline;
requests are spaced three clocks apart. The X sweep remains one pixel per
clock. Row zero is prepared during vertical blank; later rows must still
complete within 2,200 clocks.

All large memories use data-only BRAM lanes, including the ninth row-ID bit.
The font shrinks from six block equivalents to one. The mapped total is
15 blocks: ten for events, one for font, one for Y pointers and three for X
buffers. The active table and palette use distributed RAM.
The build helper checks every mapped BRAM for parity payload or native cascades.

## Build, simulate and export

```sh
python3 fpga/tool.py build --dynamic scene
python3 fpga/tool.py sim --dynamic scene
python3 fpga/tool.py sim --dynamic scene --boot
python3 fpga/tool.py export --dynamic scene
```

The default scene is Amber; `--scene PATH` selects another editor scene.
Simulation writes `fpga/build/scene-simulation.png` or
`fpga/build/scene-boot-simulation.png`, and compares all 2,073,600 pixels against
the existing software renderer with square corners and palette events removed.
The boot capture starts with empty memories and runs the actual RY03 loader.
An exported RY03 file can also be replayed with `sim --dynamic scene --binary PATH`.

This larger compiled HDL model can take several minutes for the VGA monitor
to acquire its initial frames. `hdl_capture.py` uses fpgatool's compiler and
unchanged monitor with a bounded 600-second capture wait, and prints progress.
It does not change the hardware clock or substitute a software rasterizer.

Native tests use the same Pypeline paths as the existing hardware tests. To
avoid interpreting the library's per-bit comparison circuits in Python on
every pixel, use its value- and type-equivalent native operator mode:

```sh
PYPELINE_SIM_SOFT_OPS=none python3.13 -m unittest fpga.test_scene_hardware.SceneHardwareTests -v
python3 -m unittest fpga.test_scene_compile fpga.test_image
bun test fpga/integration.test.js
```

The HDL captures still execute the synthesized comparison and priority logic.

The compressed-font scene route uses **seed 3** and meets the 148.5 MHz
constraint at **154.01 MHz**. The default seed reached 142.33 MHz and was
rejected. Alternate placement can reuse an unchanged mapped netlist:

```sh
python3 fpga/reseed.py 3
python3 fpga/reseed.py 3 --pack
```

The first command routes the existing `raster_scene` mapping with that seed.
The second requires a passing routed report and matching hashes of the
netlist, clock script, board pins, staged hardware and FASM. It uses
fpgatool's pinned bitstream tools and flash-pin workaround, then records the
selected seed in the normal verified-build manifest. Rebuild synthesis after
changing hardware; the helper rejects a source/mapping mismatch.

The final RY03 boot capture starts with empty memories, loads the actual
compressed binary through the hardware loader, and matches all **2,073,600
pixels** against the independent software renderer. Eight native hardware
tests cover RECT/TEXT overlap and expiry, glyph row advancement, last-pixel
transitions, replacement of all 64 lanes with over 1,400 output runs,
loader corruption and capacity limits, the highest font address and row-ID
bit eight, invalid dictionary references, cancellation and UART serialization.
Twelve host/image tests and six API/UI tests also pass.

The mapped design uses **10 RAMB36 + 10 RAMB18 = 15 full-block equivalents**,
versus 20 before compression. The font itself uses two RAMB18 blocks, down
from six RAMB36 blocks. Every memory passes the parity/cascade audit. All
85 currently supported glyphs fit in the font store; this does not reduce
the supported character set. Event capacity and the two X buffers are unchanged.

The RY03 engine and assets are installed persistently on the Basys 3. A
five-second UART check reports ready, all expected writes/checksum, and no
load, producer, deadline or scanout fault. Amber's longest observed job is
**2,199 clocks on row zero**, which is prepared during vertical blank;
nonzero rows still have the 2,200-clock deadline. The 64-event replacement
stress test meets that deadline. UART confirms 4,430 event bytes, 2,386 font
bytes, 64 palette entries, 1,081 row pointers and checksum 648,700.
The user also confirmed that the compressed-font build displays correctly
on the physical monitor.

The physical verification records, build manifest and screenshot are retained
under the ignored `fpga/build/` directory. `font-verification.json` describes
the compressed build; `font-baseline/` preserves the prior RY02 bitstream,
assets and resource report.

## Install and use the simulator button

The scene bitstream is `fpga/build/raster_scene.bit`. `load --dynamic scene`
loads the verified bitstream into volatile SRAM; `program --dynamic scene`
installs it in configuration flash. Asset upload can reconfigure the FPGA, so
normal use needs the scene engine installed persistently.

In the raster simulator, select **Dynamic RECT + TEXT** beside **Export .bin &
upload FPGA**. Uploading compiles the current unsaved editor scene to a RY03
file and runs `fpgatool program-data FILE --board basys3 --offset 0x220000`.
The downloadable `.bin` is retained on programming failure. The selector must
match the engine installed on the board; the baked engine consumes RX01.

LD0 indicates clock lock, LD11 flash activity, LD12 valid loaded assets,
LD13 a load/producer error, LD14 a latched X-consumer fault, and LD15 a Y deadline miss.
The center button reloads assets. UART diagnostics at 115200 baud report load
status, write counts/checksum, maximum observed Y-job duration and faults:

```sh
python3 fpga/debug.py --scene --binary PATH_TO_Y_PROGRAMS.bin --port /dev/cu.usbserial-2101837357871
```

## Flash ABI RY03

All multibyte values are little endian. The physical base is `0x220000`.

| Offset | Contents |
| --- | --- |
| `0x0000` | Eight u32 header words: `RY03`, dimensions, event count, font-word count, checksum, lane count, font-index base word, zero |
| `0x0100` | 64 RGB444 u16 palette values |
| `0x0200` | 1,081 u16 event addresses, including the final sentinel |
| `0x1000` | Up to 4,096 ten-byte draw records |
| `0xb000` | Up to 2,048 u16 words: packed row-pattern dictionary followed by row IDs |

The checksum sums the stored bytes of the four resource sections, excluding
header and padding. Row addresses index draw records. The bytecode for row Y
is `events[rows[Y]:rows[Y+1]]`, with no linked instructions. Record fields are:

| Bits | Field |
| --- | --- |
| 10:0, 21:11 | Left and exclusive right X |
| 32:22, 43:33 | Top and exclusive bottom Y |
| 49:44 | Foreground layer 1..63 |
| 50 | Solid RECT (1) or glyph mask (0) |
| 63:51 | Font row-ID word address at top Y |
| 68:64 | Glyph left clipping shift |
| 74:69 | Destination active lane |
| 79:75 | Zero |

RY03 changes the font encoding and header from RY02. Older binaries must be
re-exported and the matching bitstream installed. The physical flash offset
and all non-font sections stay the same. The checksum counts two bytes per
font word. Dictionary row IDs must fit nine bits and reference three bytes
entirely within the dictionary region; host validation and hardware lookup
check these bounds.

The font row-ID address advances by `Y - top` in hardware. A lane's mask is
refetched each Y job, then shifted while sweeping its X coordinates. No host
recalculation is needed between scanlines or frames.
