# Raster Engine

An experimental framebuffer-free **1280 × 720 HD (720p)** graphics engine built with Bun, JavaScript, HTML and Canvas.

## Run

```sh
bun run dev
```

Open http://localhost:3000.

Run tests with `bun test` and `python3 -m unittest discover -p "test_*.py"`.
The browser backend selector includes both JavaScript and pure Python. The Python
backend uses the system `python3` (or `RASTER_PYTHON=/path/to/python`), with no
third-party packages. `python_backend.py` accepts `{ "scene": ... }` on stdin
and returns the same JSON result as the JavaScript backend. `engine.py` provides
`compile_y(scene)`, `run_y_program(scene, program)`, `rasterize(scene)`,
`advance_y(machine, y)`, and the memory-efficient `iter_scanlines(scene)` generator.
Each scanline contains a mutable `bytearray` of 64-layer palette indices and a
per-line palette snapshot, suitable for feeding a Python text rasterizer.
`demo-scene.json` is a snapshot of `scene.js` and is parity-tested against it.

Run tests with `bun test`. The default Paint-style 720p demo scales the earlier
640 × 480 scene uniformly by 1.5 and centers it horizontally; the desktop fills
the entire 1280 × 720 frame. All geometry uses square pixels.

## Browser/server boundary

The browser imports **only `scene.js`** for viewport constants and the editable
sample scene. The Bun server imports `engine.js` and runs both reference
interpreters. The browser does not execute either interpreter.

- `GET /api/backends` lists available execution implementations.
- `POST /api/run` accepts `{ "backend": "javascript" | "python", "scene": { ... } }`.
  The response contains `width`, `height`, `backend`, the compiled Y `program`,
  `scanlines` (one entry per Y coordinate: indexed pixel arrays, X linked-list snapshots, palette,
  program counter and instruction/mutation trace), and aggregate statistics.
- The GUI renders the returned pixels and trace and allows Y-program inspection.
  The API is backend-neutral so a Pypeline simulator can later implement the
  same contract.

The reference VM still uses an incrementally generated, cached array of circle
insets. Replacing this with live per-rectangle Bresenham state is deferred until
we have cycle timing and a Pypeline implementation to measure. A possible
alternative is to populate an arc cache during vertical blanking.

## Architecture

The engine represents a scene as two cooperating raster programs:

- **X-program:** An X-sorted linked list of START_PAINT and STOP_PAINT instructions. Each instruction references one of 64 ordered palette layers. Reference counts allow overlapping shapes to share a layer; the highest active layer determines the pixel color.
- **Y-program:** A stream of transformations that changes the X-program between scanlines. Geometry may insert, delete, or move X instructions. Y events can also update palette entries.

The original shape primitive is a rectangle with a `radius` parameter; the Python reference backend also supports masked `TEXT` objects. A radius of zero produces square corners; positive radii produce quarter-circle corners. The radius supports CSS-style one-to-four-value shorthand in top-left, top-right, bottom-right, bottom-left order. Adjacent radii are proportionally scaled down if they would overlap. Rounded edges are sampled per scanline in JavaScript and represented as moving X instructions. The renderer produces an indexed pixel buffer for Canvas visualization.

## Browser workspaces

The browser has two distinct workspaces that share one editable JSON scene:

- **Scene editor:** fixed native-size 1280 × 720 visual editor using ordinary DOM `div`
  elements for rounded rectangles and clipped text regions. The scene scrolls
  horizontally in a narrower window rather than scaling the DOM or its font. Select objects on
  the canvas or from the searchable layer-sorted object list. Drag to move,
  drag the lower-right selection handle to resize, or edit integer coordinates,
  dimensions, four CSS-order corner radii and palette layer in the properties
  panel. Arrow keys move the selected object by one pixel (Shift: ten),
  and Delete or Backspace removes the selected object when no text field is
  active. The Objects list uses enlarged thumbnails with the actual rectangle
  proportions and CSS-order radii, rather than flat color swatches.
  Use **+ Rounded rectangle** and **+ Text** to create objects; text objects
  each get an independent editable byte-buffer handle. Duplicate creates a new
  text buffer (not an alias), and delete frees a buffer when no other object
  references it. Palette updates remain editable under the collapsible
  **Palette changes by Y** section.
- **Raster simulator:** backend-executed pixels, Y-program, persistent X-list,
  palette inspector and scanline timeline. Simulation runs on entering this
  workspace or when **Run simulation** is pressed, not during visual dragging.
  Return to editing without losing any scene edits. With text objects present,
  simulation automatically selects the Python backend if JavaScript was
  selected, because JavaScript currently has no mask-source support.

The DOM canvas is an **editing approximation**: it uses CSS rounded corners
and RED2's own OpenType web font (32px artwork scale, 36px line height, with
OpenType `calt` and `kern` enabled). The Objects-pane text thumbnails also use
that font at a reduced size. The web-font assets in `fonts/` are copied from
`../red2-font/dist/` (exported from `red2-font` commit `ddbe095`): regenerate
with `python export_web_font.py` in that repository and copy the generated
WOFF2, TTF, and stylesheet here after changing the artwork. Unlike the old
system-font preview, the RED2 font's glyph shapes and contextual kerning now
match the font source. Browser anti-aliasing and CSS text wrapping can still
differ from the pixel-accurate renderer.

The simulator renders authoritative palette pixels and exact 1-bit RED2 glyphs,
with differing corner-pixel details where CSS and the rasterizer's integer
circles diverge. **No background raster
rendering happens while dragging.** Scenes currently live in browser memory;
reloading the page resets to the demo scene.

## 1-bit RED2 text (Python backend prototype)

`TEXT` is a Y-program instruction. Each text object refers to its **own byte
buffer** through `buffer_ptr` (an allocation handle; not a process pointer in
the JSON simulator). Buffers are independent allocations in `textBuffers`;
there is no shared, globally concatenated text string. A text object's
`layer` controls both its palette color and its paint priority. The text
background is transparent.

```python
scene['textBuffers'] = {
    '4096': 'HELLO, WORLD!',
    '8192': 'P.O.\nSECOND LINE',
}
scene['texts'] = [
    {'id': 47, 'x': 352, 'y': 225, 'w': 450, 'h': 72,
     'layer': 30, 'buffer_ptr': 4096},
    {'id': 48, 'x': 350, 'y': 290, 'w': 450, 'h': 100,
     'layer': 12, 'buffer_ptr': 8192},
]
```

`compile_y()` emits `TEXT` alongside `ROUND_RECT`, `SET_PALETTE`, and
`WAIT_Y`. Executing `TEXT` activates a 1-bit glyph-row producer and inserts
just two persistent X-program nodes: `START_MASK` and `STOP_MASK`. The nodes
represent the text rectangle; they do **not** multiply with the number of
glyphs or pixel transitions. On each occupied scanline, the text producer
replays that buffer's bytes, decodes the compressed binary RED2 glyph-row ROM,
performs Pypeline's two-glyph-history kerning, and supplies a 1-bit ink mask.
The X interpreter chooses the highest covered palette layer, respecting
overlapping rectangles and other text objects. The buffer's contents are
snapshotted at source activation, and `buffer_length` can limit the snapshot.

The Python model uses the exact binary compressed ROM and kerning class data
from `fpgatool/examples/hardware/red2_row_data.py`, vendored as
`red2_font_data.py`, without runtime Aseprite/Pillow dependencies.
`test_binary_text.py` compares glyph rows, every supported kerning pair,
whole multiline/wrapped images, and clipped oversized glyphs with
`fpgatool`'s independently generated column-major font and reference renderer
when that checkout is available. The Python backend is selectable from the
browser, and its API accepts `texts` and `textBuffers`; **JavaScript currently
rejects scenes containing text** rather than silently omitting them. The
browser editor does not yet expose text object editing.

This is a functional **scanline reference model**, not a cycle-accurate FPGA
implementation. Its masks are temporarily represented by Python integers;
future hardware should use the binary Pypeline glyph-window/FIFO producer
and schedule active mask sources without allocating full-screen bitmaps.

## Current implementation versus target hardware

The current simulator **is not cycle accurate**. It executes the Y instructions scheduled for a scanline, then renders that scanline from the resulting X linked list. It does not yet simulate simultaneous X/Y interpreters, the consumed-prefix ownership frontier, BRAM read/write latency, linked-list pointer hazards, a run producer, or the 64-pixel read-ahead FIFO.

For rectangle-only scenes, the compiler emits a compact Y-program with WAIT_Y, ROUND_RECT, SET_PALETTE and HALT instructions. The Python backend also emits TEXT. The Y virtual machine executes that bytecode, keeps active rounded-rectangle generators, and materializes an X linked list for each scanline. This keeps program size proportional to scene complexity rather than to the number of curved scanlines. The VM still rebuilds X ordering after each scanline; it is not yet a streaming, frontier-constrained linked-list editor.

Palette changes apply atomically at scanline boundaries in the simulator. The eventual concurrent implementation will require versioning or staging so the next scanline's palette changes cannot affect the current scanline.

## Future goal: coverage-antialiased rounded rectangles

The current rasterizer uses hard, integer-pixel edges. A future optional
rendering mode should reproduce the visually appealing rounded corners in
[`golden-reference-aa-arcs.png`](golden-reference-aa-arcs.png), captured from
the native-size scene editor in Zen (Firefox/WebRender) on macOS. Preserve
that PNG as a golden reference for comparisons; it is a reference image,
not a specification of the browser's internal algorithms.

**Initial hypothesis:** fractional geometric pixel coverage with colors
interpolated directly in gamma-encoded sRGB channel space, rather than
converted to linear-light intensities. Preliminary analysis of the
color-profile-corrected screenshot favored sRGB-channel interpolation;
confirm this with reproducible tests before treating it as established.
For foreground RGB `F`, the effective underlying RGB `B`, and coverage
`alpha` from 0 to 1, blend each channel independently:

```
C = round((1 - alpha) * B + alpha * F)
```

Here `F`, `B`, and `C` are the usual 8-bit *encoded* RGB channel values,
not linear-light intensities. For a 4-bit coverage value `a` in `[0, 15]`,
start with integer arithmetic:

```
C = ( (15 - a) * B + a * F + 7 ) // 15
```

That gives 16 coverage levels including fully transparent and opaque.
Do not confuse **linear interpolation of encoded sRGB values** with
**linear-light blending**, which requires decoding sRGB, mixing physical
light intensities, and re-encoding. The two produce visibly different
edge brightness.

Suggested progression:

1. Build a software reference that calculates fractional coverage of each
   quarter-circle edge, initially via supersampling, and compares direct
   sRGB interpolation against linear-light and perceptual alternatives.
   Convert the reference PNG through its embedded ICC profile before
   comparing RGB values. Use the screenshot for visual and numeric
   regression tests, including nearest-neighbor enlargements.
2. Quantize the best coverage model to 4 bits, inspect banding and arc
   symmetry, and measure error against an 8-bit or high-precision reference.
   Keep the solid interiors and the radius-zero path fully opaque.
3. Fit the chosen coverage generator into the scanline/X-transition
   architecture without introducing a full framebuffer. Consider a small
   per-edge coverage state or table, generated during blanking if useful,
   instead of multiplying every pixel by expensive geometry calculations.
4. Work out correct compositing for overlapping shapes. Our existing
   highest-active-layer palette-index lookup is insufficient at a
   partially covered edge: a pixel must blend with the *effective color
   beneath that edge*, which might itself contain another antialiased
   edge. Respect layer priority, clipping, palette updates, and color
   changes between scanlines. Avoid assuming the background is simply
   palette entry zero.
5. Benchmark FPGA cost and timing (BRAM, LUTs, DSPs, pixel throughput)
   before deciding between on-the-fly channel blending, precomputed
   palette mixtures, and other resource-conscious representations.
   Explore antialiasing RED2 text separately once rounded rectangles work.

**Acceptance criteria:** the 1-bit/hard-edge mode remains available and
unchanged; the new mode has deterministic software tests for radii,
clipping, overlaps, and dynamic palettes; reference corners look comparably
smooth at native 1280x720 resolution; and the hardware design can emit one
pixel per clock without a full-frame color buffer.

## Next milestone

Build a cycle-stepped model with separate X and Y program counters, an explicit old-list read frontier, safe linked-list mutation, a bounded FIFO, horizontal blanking, and stall/underrun instrumentation. Compare its pixel output against the reference renderer and test adversarial scenes with dense edges and simultaneous inserts/deletes.
