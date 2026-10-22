# Baked ROM X-program engine for Basys 3

The runtime **RECT + TEXT** target is documented in [SCENE.md](SCENE.md),
with its two-buffer scheduler in [PINGPONG.md](PINGPONG.md). The baked Amber
flash engine described below remains available as a separate target.

This folder contains the Pypeline implementation, binary compiler, simulator
controls and upload endpoint. The few changes outside it connect the controls
to the existing simulator and API. Hardware sources contain no Amber scene
data: the same bitstream reads any supported exported image at a fixed flash
address.

The first version displays **1920 × 1080 at 60 Hz**, with a constant 64-entry
RGB444 palette. The host bakes rectangles, hard rounded edges, RED2 text,
clipping and overlaps into final visible runs. The FPGA executes those runs;
there is no runtime Y interpreter or text renderer. Other resolutions,
scanline palette changes and images exceeding 65,536 shared run records are
rejected before programming.

## Build and install the engine once

With `fpgatool` on PATH:

```sh
python3 fpga/tool.py build
python3 fpga/tool.py program
```

`build` synthesizes and routes the Pypeline design, then copies the resulting
bitstream to `fpga/build/raster_rom.bit`, together with the final `timing.log`.
The helper checks the pixel clock result, including padded clock-name lines
and the last routed result for each clock, before copying or loading a bitstream.
`program` installs that bitstream in
configuration flash so the engine boots again after asset programming and
power cycles. `python3 fpga/tool.py load` instead loads the built engine into
volatile FPGA SRAM, useful for development; asset programming can reconfigure
the FPGA, so persistent installation is the normal workflow.

Current fpgatool requires design and bitstream paths under its checkout. The
helper discovers that checkout through the resolved PATH executable and
stages a copy under its ignored `build/raster-engine-source/` directory. It
does not modify tracked fpgatool files. Canonical sources stay here. Pypeline,
RAM/FIFO primitives, the board pin bindings, MMCM and SPI transport come from
fpgatool's pinned toolchain and examples.

## Export and upload a scene

For the baked firmware, select **Baked X programs** beside the upload button.
The simulator defaults to **Dynamic RECT + TEXT**, matching the currently
installed firmware described in [SCENE.md](SCENE.md).
Open `amber-components.json`, switch to **Raster simulator**, and click
**Export .bin & upload FPGA**. The button snapshots the current scene, including
unsaved edits, then the Python backend:

1. Renders the reference scanlines and shares identical complete row programs.
2. Writes `fpga/build/x-programs-<unique>.bin`.
3. Executes an argument array equivalent to:

   ```sh
   fpgatool program-data /absolute/path/to/x-programs.bin --board basys3 --offset 0x220000
   ```

4. Returns a download link and the upload result. The binary remains available
   when programming fails, including when no board is attached.

The CLI syntax is `program-data`, rather than a `--program-data` option in the
installed fpgatool. Programming uses its existing verified data-flash path and
reserves the touched user-data erase blocks beginning at `0x220000`.

Uploads are serialized, have a 180-second host timeout and leave the HTTP
server responsive. Unsupported scenes disable the button. The API validates
the scene again before invoking the programmer. Edits made during an upload
are reported as requiring another upload.

Export the default Amber scene without hardware:

```sh
python3 fpga/tool.py export
python3 fpga/tool.py export --scene scenes/amber-components.json
```

Amber uses **33,028 shared run records** and produces a **103,180-byte binary**.
Its palette indices match the reference exactly; RGB values use the upper
four bits of each source channel for the Basys 3 VGA DAC.

## Fixed flash ABI, version RX01

All multibyte values are little endian. Addresses below are physical flash
byte addresses, not FPGA process pointers.

| Address | File offset | Data |
| --- | --- | --- |
| `0x220000` | `0x0000` | Four 32-bit header words |
| `0x220100` | `0x0100` | 64 RGB444 palette values, two bytes each |
| `0x220200` | `0x0200` | 1,080 row starting addresses, two bytes each |
| **`0x221000`** | **`0x1000`** | **Linear X-program words, three bytes each** |

The four header words are magic `0x31305852` (bytes `RX01`),
`1920 | (1080 << 16)`, run count, and an unsigned 32-bit additive checksum.
The checksum is the sum of decoded palette values, row pointers and run
words, modulo 2^32; padding and the header are excluded. It detects accidental
corruption, not adversarial changes. fpgatool independently verifies the flash
write.

Each run word has `exclusive_end_x[16:6]` and `palette_index[5:0]`; all higher
bits are zero. It is stored in an 18-bit BRAM entry after loading. A row begins
at X=0, each following run begins at the preceding endpoint, and an endpoint
of 1920 terminates the row. Row pointers index run words, not bytes, and may
jump backward to share a complete row program. Palette, row and run offsets
are constants in `format.py`; the hardware does not depend on JSON or on any
host filesystem path.

## Hardware path

`top.py` generates a 148.5 MHz pixel clock from the board's 100 MHz oscillator.
The 100 MHz process contains only the MMCM clock generator. **SPI, the image
loader, every RAM write and read, and scanout share the 148.5 MHz clock.**
No image data or write enables cross clock domains, and no mailbox is needed.
The MMCM lock indication uses a two-register synchronizer. A single pixel-clock
register carries the loader output bundle into scanout, keeping checksum
validation off the scanout control path; this is ordinary pipelining, not CDC.

The inherited SPI transport is configured for fifteen pixel clocks per SCK
half period: **4.95 MHz SCK**. Startup and recovery delays are scaled to retain
the original physical timings, including 20 ms power-up and 100 us release
recovery. The slow transfer happens once at boot, not during video rendering.

`loader.py` checks header dimensions, count, palette and address ranges, run
fields and checksum while loading three memories. Word assembly, validation,
commit and the final checksum decision are staged. Display stays black until
loading succeeds and a frame boundary arrives. VGA sync continues while
loading or after an error. The center button requests a reload once the SPI
transport is idle.

`scanout.py` looks up the next row during horizontal blanking. It issues
sequential synchronous BRAM reads through an eight-entry run FIFO, with credits
covering both memory responses and queued records. A register separates the
large run memory's output from endpoint validation and FIFO writes. It stops offering records
at the row terminator and drains stale prefetched data before the next row.
The prefetcher checks endpoint range and ordering before consumption. The
consumer changes palette index when the beam reaches a run endpoint and
can consume one record every pixel clock. The selected index is registered
before palette lookup; active and sync follow the same two-clock pipeline.
Invalid endpoints or underruns blank the rest
of the row while timing continues.

The allocated run capacity is 65,536 × 18 logical bits, stored in parallel
8-bit, 8-bit and 2-bit RAM banks, each split into two 32K-entry halves to
avoid native 64K-depth cascades. The mapped banks use **36 BRAM blocks**;
the 2,048 × 16-bit row memory uses one more. The 64 × 12-bit palette is
small distributed RAM. No run payload uses BRAM parity pins. This reserves
capacity for scene changes; it is larger than Amber's actual payload.
There is no full-frame pixel buffer.

Diagnostics: LD0 = clock locked; LD11 = flash busy; LD12 = image ready;
LD13 = invalid image; LD14 = scanout fault detected. Other LEDs are zero.

## Validation

The original dual-clock version passed the HDL capture but produced missing
content on the physical board with LD0, LD12 and LD14 lit: clock lock and
loader success, plus a sticky scanout fault. Its bitstream, sources and report
are retained under ignored `fpga/build/dual-clock-debug/` for comparison.
The new version removes the image clock-domain crossing. Its final pin-constrained
route reached **159.49 MHz** for the required 148.5 MHz pixel clock. The updated
boot capture matches all **2,073,600** Amber pixels with no scanout fault.
Current build and programming results are recorded in `fpga/build/verification.json`.

```sh
python3 -m unittest fpga.test_image
bun test fpga/integration.test.js
python3 fpga/tool.py sim
```

The HDL capture harness uses the same exported binary and the same Pypeline
X interpreter, with initialized BRAM and an ideal pixel clock in place of
the board's boot-time SPI load and MMCM. It writes
`fpga/build/simulation.png`. This checks scanout separately from the physical
flash interface, then checks every captured RGB pixel against the binary.
Changes to both hardware source and image are included in the staged
entry point so fpgatool's simulation cache invalidates correctly.

Native hardware tests exercise the actual Pypeline loader and initially empty
scanout RAM on one clock, checksum rejection, one-pixel runs, row boundaries,
backward row-pointer jumps and palette/sync alignment. Run them with the
Pypeline runtime, compiler source and library on PYTHONPATH (as provided by
fpgatool's toolchain), using Python 3.13:

```sh
python3.13 -m unittest fpga.test_hardware -v
```

### Debug a board/capture mismatch

To reproduce the exact binary uploaded to the board, including its quantized
palette, run:

```sh
python3 fpga/tool.py sim --binary fpga/build/amber-components.bin
python3 fpga/tool.py sim --boot --binary fpga/build/amber-components.bin
```

The first command writes `fpga/build/simulation.png` using preinitialized
scanout RAM. The second writes `fpga/build/boot-simulation.png`: it starts
with empty scanout RAM, feeds the complete binary through the hardware loader
and exercises all RAM write ports before displaying.
Both commands compare every output pixel with the supplied binary. The boot
capture paints the output magenta if the loader or sticky scanout error fires,
so a fault before the captured frame also fails the pixel comparison.

The boot capture substitutes a fast byte ROM for the electrical SPI interface
and uses an ideal pixel clock in place of the MMCM. The loader and scanout
share that clock, matching the board architecture. Neither capture validates
physical MMCM behavior, routed timing, VGA voltage, or monitor compatibility.

### Read the first hardware fault over USB UART

The engine transmits repeating 115200-baud 8-N-1 diagnostic packets on the
Basys 3 USB UART. Read them with:

```sh
python3 fpga/debug.py --port /dev/cu.usbserial-2101837357871 --binary fpga/build/amber-components.bin
```

The host prints JSON and saves `fpga/build/uart-diagnostics.json`. The first
fault remains latched until reload: reason (`empty_fifo`, `invalid_run`, or
`full_fifo`), beam X/Y, row being prefetched, run address/word, previous
endpoint, and outstanding-read credits. The reader compares an invalid run
with the word at that address in the exported binary. It also compares the
checksum and counts of writes presented to RAM with the expected image.
These counts validate the write stream, not independent BRAM readback.
The fault and UART paths are pipelined separately from video output.

### Physical bit-8 fault and data-lane workaround

The single-clock build still produced missing content and LD14. The UART
recorder isolated the first error while prefetching row 240: run address
10,625 read as 1,089 instead of 1,345 (XOR 0x100). That changed endpoint X=21
to X=17, below the preceding X=20, correctly triggering the row blanking guard.
All 64 palette, 1,080 row and 33,028 run writes were counted, and the write-stream
checksum matched the exported binary. The original capture is preserved in
`fpga/build/parity-fault-debug/uart-diagnostics.json`.

The original 18-bit memory mapped to 9-bit physical BRAM ports, with logical
bit 8 on a parity lane. The replacement uses 8/8/2-bit banks so every payload
bit uses a data lane. It preserves the flash ABI, reserved bit, capacity,
one-cycle RAM latency and one-run-per-clock throughput. The exact underlying
OpenXC7 parity-path defect has not been isolated; this design avoids that path.
`tool.py` checks the actual mapped netlist for dynamic parity inputs,
consumers of parity outputs, and native cascade connections before accepting
a build or programming it.


The data-only bank build passes final timing at **159.49 MHz** and its full
boot capture matches all 2,073,600 pixels. On the physical board, the temporary
SRAM-loaded build reports image ready, the correct 64/1,080/33,028 write counts,
matching checksum 1,950,245,796, and **no scanout fault**. This removes the
previously observed invalid run. See `fpga/build/uart-sram-verification.json`.


The corrected engine has also been programmed persistently. A fresh five-second
UART check after reconfiguration returned image ready, matching checksum and
write counts, and no load or scanout fault. The exact binary is unchanged.
See `fpga/build/uart-diagnostics.json` and `fpga/build/verification.json`.

The user also visually confirmed that the corrected persistent build displays
the expected Amber image, with the missing content and black streaks gone.
