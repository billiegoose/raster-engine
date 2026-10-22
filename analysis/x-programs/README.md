# Static X-program sizing and stress cases

Measured from `scenes/amber-components.json` at its native **1920 × 1080**.
The existing `compileScene()` resolves editor layers, and `iter_scanlines()`
renders the reference pixels, including RED2 text, clipping and overlaps.
These are functional measurements, not FPGA cycle simulations.

Regenerate metrics and initialization files with:

```sh
python3 scripts/analyze_x_programs.py
python3 -m unittest test_x_program_analysis
```

Use `--skip-stress` for a quick Amber-only run. Stress cases are generated in
`stress_scenes()` and can be swept with `--stress-count N` (default 128).
Full-width stripe density follows the scene width independently of this knob.

`metrics.json` contains the source-file hash, indexed-pixel hash, distributions,
peak row numbers, stress results and timing calculations. The emitted `.mem`
files use one hexadecimal word per line; their text-file sizes are not FPGA
memory requirements.

## Linear arrays

An X consumer needs only a sorted stream. If a producer rebuilds the next row
into a separate array, linked-list pointers serve no purpose in the emitted
program. A ring needs read/write ownership, capacity and row boundaries, but
does not require per-instruction links either. A mutable upstream geometry
structure can still use links independently of the output representation.

For a static scene, store a concatenated instruction array and one starting
address per row. The consumer can stream directly from ROM through a small
prefetch queue. Double-buffering whole row programs is optional.

## Representative metrics

Amber contains 86 rectangles, 51 text objects, 448 text-buffer bytes, and no
palette-change events. Its 1,080 rows use one palette version.

| Metric | Mean per row | 95th percentile | Maximum |
| --- | ---: | ---: | ---: |
| Original PAINT/MASK X entries | 17.98 | 42 | 48 |
| Final visible color runs | 33.86 | 103 | 179 |
| Active text windows | 1.67 | 5 | 6 |
| X-node changes from previous row | 1.60 | 8 | 20 |

Totals: **19,414 original entries**, including 15,806 PAINT entries and 3,608
START/STOP_MASK entries; **36,570 final visible runs**. The busiest visible
rows are zero-based Y=170 and Y=172. The maximum solid reference count within
one layer is 3. At most 2 original entries share one X coordinate.

The densest 64-pixel window contains 8 original edge entries or 23 visible-run
starts (these maxima can occur on different rows). Text masks make visible
color transitions substantially denser than the bounding-window edge lists.

## Two interpretations of storing all X programs

**Original PAINT/MASK programs:** At an illustrative 32 bits per entry,
19,414 entries occupy 77,656 bytes (**75.84 KiB**), before row pointers and
text/font/palette resources. For example, X:11, layer:6, opcode:2, source:8
fits within 32 bits for this scene. These programs still need a text engine
and source descriptors; storing them does not bake the glyph pixels. Source
row/byte-cursor information must be supplied without a Y interpreter if that
is the selected first hardware milestone.

**Fully baked visible programs:** Resolve all masks and overlaps on the host,
then emit only `(exclusive_end_x, palette_index)` runs. This removes runtime
geometry, masks, layer counters and text decoding. It preserves the exact
reference palette-index pixels and allows the palette colors to remain separate.

The implemented format is:

```text
17       16                          6 5                    0
+---------+---------------------------+---------------------+
| zero    | exclusive end X: 11 bits  | palette index: 6 bits |
+---------+---------------------------+---------------------+
```

Each run uses 17 meaningful bits in one 18-bit BRAM word. The first run starts
at X=0; subsequent runs start at the previous endpoint. An endpoint of 1920
ends the row, so no separate END opcode or length descriptor is needed. Every
row includes background runs and covers exactly the full width.

| Layout | Run records | Row-pointer records | Logical payload | BRAM reservation |
| --- | ---: | ---: | ---: | ---: |
| Separate program for every row | 36,570 | 1,080 | 82.73 KiB | 38 RAMB18 = 85.50 KiB |
| Share exact identical row programs | 33,028 | 1,080 | 74.94 KiB | 35 RAMB18 = 78.75 KiB |

There are **655 distinct visible row programs**. Sharing only reuses entire
identical rows; there is no suffix sharing or more elaborate compression.

The reservation assumes separate run and row-address memories, each using
1,024 × 18-bit RAMB18 configurations. This consumes approximately 38% or 35%
of the Basys 3's 100 RAMB18 equivalents. It is an allocation estimate, not a
synthesis utilization report. The palette adds 96 bytes at RGB444 or 192 bytes
at RGB888; a dedicated BRAM palette would consume a larger physical block.
Prefetch storage and logic are additional. The `.mem` files contain run and
row-address memories; the palette is the scene's existing palette.

Fixed-size per-row slots waste memory: 179 × 1,080 × 18 bits is **424.78 KiB**
before metadata. Concatenating variable-length rows is essential here.

`amber-static/flat-runs.mem` and `flat-rows.mem` implement independent rows;
`shared-runs.mem` and `shared-rows.mem` implement exact row sharing. Every
packed row is decoded and compared with the reference during analysis, and
both emitted pointer layouts are checked against each other. Tests also
reload the actual hexadecimal files and compare text-containing scanlines.

## Blanking budgets at 60 Hz

| Parameter | 1280 × 720 | 1920 × 1080 |
| --- | ---: | ---: |
| Pixel clock | 74.25 MHz | 148.5 MHz |
| Total clocks per line | 1,650 | 2,200 |
| Horizontal front/sync/back | 110 / 40 / 220 | 88 / 44 / 148 |
| **Horizontal blank per line** | **370 clocks** | **280 clocks** |
| Horizontal blank duration | 4.983 µs | 1.886 µs |
| Total lines per frame | 750 | 1,125 |
| Vertical front/sync/back | 5 / 5 / 20 lines | 4 / 5 / 36 lines |
| **Vertical blank** | **30 lines = 49,500 clocks** | **45 lines = 99,000 clocks** |
| Vertical blank duration | 666.667 µs | 666.667 µs |
| H blank on active rows | 266,400 clocks/frame | 302,400 clocks/frame |
| All blanking, without double counting | 315,900 clocks/frame | 401,400 clocks/frame |

Vertical blank includes the complete line time, including horizontal blank on
those lines. Therefore, total blanking is
`Vblank_lines × total_width + active_height × Hblank_clocks`.
The totals are distributed across the frame; they are not one contiguous
work interval. Counts are pixel clocks; another engine clock requires scaling
by `engine_hz / pixel_hz` and appropriate clock-domain handling.

At one instruction fetch per pixel clock, Amber's 179-record worst row leaves
101 clocks of the 1080p horizontal blank for setup and pipeline overhead.
That supports considering a preload-whole-row design, but does not establish
timing closure. With direct ROM streaming, long runs provide further slack.
A consumer with one-record-per-clock sustained throughput can also handle
one-pixel runs after prefetch; a two-cycle non-overlapped fetcher cannot.

## Generated stress cases

| Case | Peak original entries/row | Peak visible runs/row | What it exposes |
| --- | ---: | ---: | --- |
| 128 coincident full-screen rectangles | 256 | 1 | 128 edges at one X; same-layer counter reaches 128 |
| One-pixel stripes | 1,920 | 1,920 | One run per pixel; same program on every row |
| Dense, unique rows | 1,922 | 1,920 | Same maximum density with 1,080 distinct programs |
| Replace 128 rectangles on adjacent rows | 256 | 256 | 256 deletes plus 256 inserts at one row boundary |
| 128 staggered rounded rectangles | 256 | 115 | Up to 232 node changes in a row; moving-edge ordering |
| 128 overlapping independent text buffers | 256 | 1,211 | 128 simultaneous mask sources, including shared layers |
| Change all 64 palette entries every row | 2 | 1 | 69,120 palette writes per frame; row versioning |

The stripe case compiles to **2,073,600 run records** if every row is stored
independently, about **4.45 MiB** with 18-bit records and row addresses. Exact
row sharing reduces the repeated-stripe case to one 1,920-record program,
but does not help the dense unique-row variant. That variant exceeds the
board's BRAM capacity despite having a bounded one-run-per-pixel rate.

Raw edge counts have no finite scene-independent bound without an object
limit: arbitrarily many coincident shapes can produce one visible run.
Visible-run counts are bounded by width. Therefore, instruction throughput,
geometry-edit throughput, mask-source capacity, and static storage need
separate limits. For this measured Amber scene, a static visible-run ROM is
a practical first hardware milestone.

## Hardware references

- [Project F display parameters](https://github.com/projf/display_controller/blob/main/doc/display-params.md): progressive 60 Hz timing values and pixel clocks.
- [AMD RAMB18E1 reference](https://docs.amd.com/r/2022.2-English/ug953-vivado-7series-libraries/RAMB18E1): 1,024 × 18-bit and 512 × 36-bit configurations.
- [Digilent Basys 3 manual](https://digilent.com/reference/_media/reference/programmable-logic/basys-3/basys3_rm.pdf): device and board memory capacity.
