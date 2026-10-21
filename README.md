# Raster Engine

An experimental framebuffer-free graphics engine supporting **1280 × 720 (720p)** and **1920 × 1080 (1080p)** scenes, built with Bun, JavaScript, HTML and Canvas.

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

- **Scene editor:** A native-resolution 720p or 1080p visual editor built from DOM
  rectangles and clipped text. The canvas scrolls in narrower windows rather
  than scaling the artwork or font. Select objects on the canvas or from
  the independent, searchable **Objects** hierarchy. Objects can be nested
  arbitrarily inside named groups without changing their paint layer. Use
  **+ Group** to wrap selected objects in a new group, or to add a nested
  group when one is selected. Single-click a group title to select it and
  double-click to rename. **− Group** removes the selected group without
  deleting its contents. Drag objects or nested groups into another group or
  to the root drop target to reparent them. Clicking an object on the canvas
  selects only that object; selecting a group in the Objects tree selects its
  descendants across paint layers. Groups move their contents together.
  The tree lists objects in descending paint-layer order within each group.
  No Group/Ungroup context commands or per-group action buttons are needed.

  The separate **Palette / Layers** inspector manages paint order and layer
  names/colors. Drag layers to reorder physical palette slots (the background
  remains at the bottom); use the inline color picker to edit a layer's color.
  The selected object's **Properties** panel assigns its paint layer with a
  named dropdown, not a color picker. A multi-selection can also be reassigned
  together. Removing a paint layer reassigns its objects and palette overrides
  to an adjacent layer rather than deleting them. Advanced scanline palette
  overrides remain in this inspector.

  Scenes persist independent groups in the backward-compatible `objectFolders` (each with `id`, `name` and an
  optional `parentId`) and object `parentId` references. Paint layers remain
  a flat, bottom-to-top `layers` array with stable `id`, `name` and `color`;
  object `layerId` references do not depend on composition. At most 64 paint
  layers, including background, compile to physical palette slots. These
  groups do not consume any slots or appear in the rasterized representation.
  Legacy paint-layer grouping structures are flattened on open, preserving
  their layer ordering and colors; legacy `group_id` object memberships are
  imported as independent object groups. The raster output is unchanged.
  All editing operations participate in undo/redo.

The DOM canvas is an **editing approximation**: it uses CSS rounded corners
and RED2's own OpenType web font (32px artwork scale, 36px line height, with
OpenType `calt` and `kern` enabled). The Objects-pane text thumbnails also use
that font at a reduced size. The web-font assets originate from `../red2-font/dist/`. After exporting
updated artwork with `python export_web_font.py` in that repository, run
`../red2-font/.venv/bin/python scripts/sync_red2_font.py` here. The script
copies the WOFF2, TTF, and `supported-characters.txt`, generates
`red2-supported-characters.js`, adds an internal U+E000 mapping to a copy of
the source `.notdef` pixel-art box (without changing the upstream font), and
cache-busts the font URLs and CSS link. The supported-characters manifest
represents actual source Unicode characters; U+E000 is **not** listed as
supported. Glyphs and contextual kerning match RED2, including Unicode
▲ (U+25B2), ▶ (U+25B6), ▼ (U+25BC), and ◀ (U+25C0), along with all 11 light
box-drawing characters (`─│┌┐└┘├┤┬┴┼`). Browser anti-aliasing
and CSS text wrapping can still differ from the pixel-accurate renderer.

The scene editor and Objects-list previews render only RED2 glyphs: unsupported
codepoints are shown as the source pixel-art missing-glyph box, **not** by
letting the browser substitute a system font. The editor tooltip lists missing
Unicode codepoints; the original scene text remains unchanged. The text buffer
may contain UTF-8 strings or byte arrays. Font coverage comes from the
generated manifest so updating the font also updates preview validation.

The simulator renders authoritative palette pixels and exact 1-bit RED2 glyphs,
with differing corner-pixel details where CSS and the rasterizer's integer
circles diverge. **No background raster rendering happens while dragging.**
Scenes can be saved and reopened as JSON files in the local `scenes/` folder
through the editor's native scene-file toolbar.

## Canvas resolution

Each scene stores its own `width` and `height` in JSON. Use the **Canvas** selector
in the scene-file toolbar to switch the current scene between **720p (1280 × 720)**
and **1080p (1920 × 1080)**. The change is undoable, and saving the scene
persists the dimensions; opening another scene restores that scene's resolution.
The editor and simulator operate at the scene's real pixel dimensions, rather
than scaling pixels or RED2 glyphs. Resizing only expands or clips the visible
canvas: existing rectangles, text, and coordinates retain their original sizes
and positions. New scenes default to 720p, while old JSON files without
`width`/`height` are read as 720p for backward compatibility. The reference
backends also accept positive integer custom dimensions up to 1920 × 1080.

The included `amber-components.json` showcase uses **1920 × 1080** with a
semantic palette legend and four aligned columns of vertically stacked examples:
**Buttons**, **Text Fields**, **Choices** (checkboxes, radio buttons and switches),
and **Values** (progress and volume). Controls remain at their native pixel
sizes, with no image scaling. The compact sidebar documents the four semantic palette roles without repeating
the column titles. The original component panels sit above a compact
three-tab example and a four-item list. Tabs reuse the primary/standard button
styling but have flat bottom edges connected by a continuous bottom bar;
selected tabs and list rows use inverse video. The list rows are 40 pixels
tall with one-pixel dim separators, and both demo panels retain the rounded
corners of the original component panels. The volume label uses the primary (active) ink color.
`amber-os.json`, Paint, and other older scene files continue to use 720p unless
resized in the editor.

## Local scene files

The editor starts with a **blank, untitled 1280 × 720 scene** (no rectangles or
text). Its conventional file toolbar provides:

- **Scene selector:** choosing a saved scene opens it directly; changing scenes
  prompts before discarding unsaved edits.
- **New:** starts another blank, untitled canvas; asks before discarding edits.
- **Save:** updates the currently open JSON file, or opens Save As for an untitled scene.
- **Save As…:** opens a filename dialog, creates a new scene file, and asks before
  replacing an existing file with a different name. The current scene then
  becomes the newly saved file.
- **Refresh:** discovers scene files added outside the browser.

Opening or saving a named scene also updates the URL, for example
`?scene=amber-components.json`. Reloading that URL automatically opens the
same saved scene. **New** clears the scene parameter. This remembers the
filename, not unsaved scene edits; save those before reloading.

Scenes are stored as pretty-printed JSON under `./scenes/<name>.json` in the Bun
server's repository. There is no browser download/upload, cloud storage,
autosave, or database. The selector shows the current scene; unsaved changes
are indicated in the status text. Loading or creating a scene resets its undo
history and invalidates the simulator's output.

The local API is `GET /api/scenes` (names), `GET /api/scenes/:name` (one scene),
and `PUT /api/scenes/:name` (replace/create from the scene JSON body). Only
simple filenames are permitted; writes are atomic and limited to 1 MiB.
The repository includes editable example scenes, including `breakout.json`
and `paint.json`.


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

The Python model decodes UTF-8 text-buffer bytes (including the four
triangles and 11 box-drawing characters above). `buffer_length` is a **byte count**, and truncated or invalid
UTF-8 sequences are ignored without swallowing subsequent valid bytes.
Unsupported code points are rendered as RED2's source `.notdef` box,
with matching pixel rows and advance metrics. Malformed UTF-8 bytes are
ignored; the original ASCII font remains in its
2048-byte hardware-compatible compressed ROM, vendored from
`fpgatool/examples/hardware/red2_row_data.py` as `red2_font_data.py`.
The triangle bitmaps, 11 box-drawing glyphs, `.notdef` box, and kerning
extensions are stored separately in `red2_unicode_data.py`, generated from
`../red2-font/RED2 Font.aseprite` by
`../red2-font/.venv/bin/python scripts/generate_red2_unicode.py`. Generation
asserts that all original ASCII glyphs, positions, and kerning classes remain
unchanged. The 11 box glyphs use sparse pair-kerning overrides, keeping the original
six-bit hardware kerning classes and compressed ASCII ROM untouched. SPACE's
new 13-pixel advance width is applied as a metadata override; the original
reference ROM still stores its previous 12-pixel width. The file-tree scene
uses native RED2 `├─`, `│`, and `└─` glyphs rather than rectangle connectors.
Rendering requires no Aseprite/Pillow dependency.
`test_binary_text.py` compares glyph rows, every supported kerning pair,
whole multiline/wrapped images, and clipped oversized glyphs with
`fpgatool`'s independently generated column-major font and reference renderer
when that checkout is available. The Python backend is selectable from the
browser, and its API accepts `texts` and `textBuffers`; **JavaScript currently
rejects scenes containing text** rather than silently omitting them. The
browser scene editor supports editing text objects.

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
