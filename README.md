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

- **Scene editor:** 1280 × 720 visual editor using ordinary DOM `div`
  elements for rounded rectangles and clipped text regions. Select objects on
  the canvas or from the searchable layer-sorted object list. Drag to move,
  drag the lower-right selection handle to resize, or edit integer coordinates,
  dimensions, four CSS-order corner radii and palette layer in the properties
  panel. Arrow keys move the selected object by one pixel (Shift: ten).
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
and the browser's normal font. The simulator renders authoritative palette
pixels and exact 1-bit RED2 glyphs, with differing corner-pixel details where
CSS and the rasterizer's integer circles diverge. **No background raster
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

## Next milestone

Build a cycle-stepped model with separate X and Y program counters, an explicit old-list read frontier, safe linked-list mutation, a bounded FIFO, horizontal blanking, and stall/underrun instrumentation. Compare its pixel output against the reference renderer and test adversarial scenes with dense edges and simultaneous inserts/deletes.
