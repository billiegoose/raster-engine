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
records**. Its RY02 binary is **49,376 bytes**. It contains no final visible
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
3. Refreshes all 64 lanes from the active table and glyph ROM, one per clock.
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
**4,096 total draw events**, and **256 distinct glyphs** (8,192 glyph rows).
All endpoints and glyph clipping are integer and binary. The hardware also
checks loaded resource ranges/checksum and generated record bounds.

All large memories use data-only BRAM lanes, including the event and glyph
banks and the two byte-wide Y row-pointer banks. The mapping uses 16 RAMB36 blocks plus eight RAMB18 blocks,
equivalent to 20 full blocks. The active table and palette use distributed RAM.
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
The boot capture starts with empty memories and runs the actual RY02 loader.
An exported RY02 file can also be replayed with `sim --dynamic scene --binary PATH`.

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

The verified scene route uses **seed 3** and meets the 148.5 MHz constraint
at **156.18 MHz**. Seed 1's final placement missed timing even though its
earlier characterization pass met it. Alternate placement can reuse the
unchanged mapped netlist:

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

The final boot capture matches all **2,073,600 pixels** against the existing
software renderer. Seven native hardware tests cover RECT/TEXT overlap and
expiry, negative-X glyph clipping, last-pixel transitions, replacement of all
64 lanes with over 1,400 output runs, loader corruption and capacity limits,
byte-bank address boundaries, malformed event rejection and cancellation,
and UART packet serialization.

The engine is installed persistently on the Basys 3. Five-second UART checks
after SRAM loading, persistent installation and a real browser-button upload
all report ready, matching resource counts/checksum, and no load, producer,
deadline or X-consumer fault. Amber's maximum observed Y job is **2,070 clocks**
out of the **2,200-clock** line budget, including row-zero initialization.
The loaded write counts are 64 palette entries, 1,081 row pointers, 4,430 event
bytes and 4,320 glyph bytes; the checksum is 616,232. These verify the write
stream, rather than independent RAM readback.

The simulator defaults to **Dynamic RECT + TEXT**. Its real upload button was
tested through export, flash programming, reconfiguration and fresh UART
verification. Its downloaded binary matches the one used by the HDL capture.
Build, capture and board evidence is retained in the ignored
`fpga/build/scene-verification.json`, `scene-build.json`, `scene-uart-*.json`
and `scene-upload-confirmation.png`.

The user also visually confirmed that the physical monitor displays the
complete Amber scene correctly, with square corners and no missing content
or black streaks.

## Install and use the simulator button

The scene bitstream is `fpga/build/raster_scene.bit`. `load --dynamic scene`
loads the verified bitstream into volatile SRAM; `program --dynamic scene`
installs it in configuration flash. Asset upload can reconfigure the FPGA, so
normal use needs the scene engine installed persistently.

In the raster simulator, select **Dynamic RECT + TEXT** beside **Export .bin &
upload FPGA**. Uploading compiles the current unsaved editor scene to a RY02
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

## Flash ABI RY02

All multibyte values are little endian. The physical base is `0x220000`.

| Offset | Contents |
| --- | --- |
| `0x0000` | Eight u32 header words: `RY02`, dimensions, event count, font-row count, checksum, lane count, zero, zero |
| `0x0100` | 64 RGB444 u16 palette values |
| `0x0200` | 1,081 u16 event addresses, including the final sentinel |
| `0x1000` | Up to 4,096 ten-byte draw records |
| `0xb000` | Up to 8,192 three-byte glyph rows, low 21 bits used |

The checksum sums the stored bytes of the four resource sections, excluding
header and padding. Row addresses index draw records. The bytecode for row Y
is `events[rows[Y]:rows[Y+1]]`, with no linked instructions. Record fields are:

| Bits | Field |
| --- | --- |
| 10:0, 21:11 | Left and exclusive right X |
| 32:22, 43:33 | Top and exclusive bottom Y |
| 49:44 | Foreground layer 1..63 |
| 50 | Solid RECT (1) or glyph mask (0) |
| 63:51 | Glyph ROM row address at top Y |
| 68:64 | Glyph left clipping shift |
| 74:69 | Destination active lane |
| 79:75 | Zero |

The font row address advances by `Y - top` in hardware. A lane's mask is
refetched each Y job, then shifted while sweeping its X coordinates. No host
recalculation is needed between scanlines or frames.
