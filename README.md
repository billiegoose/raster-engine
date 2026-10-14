# Raster Engine

An experimental framebuffer-free **1280 × 720 HD (720p)** graphics engine built with Bun, JavaScript, HTML and Canvas.

## Run

```sh
bun run dev
```

Open http://localhost:3000.

Run tests with `bun test`. The default Paint-style 720p demo scales the earlier
640 × 480 scene uniformly by 1.5 and centers it horizontally; the desktop fills
the entire 1280 × 720 frame. All geometry uses square pixels.

## Browser/server boundary

The browser imports **only `scene.js`** for viewport constants and the editable
sample scene. The Bun server imports `engine.js` and runs both reference
interpreters. The browser does not execute either interpreter.

- `GET /api/backends` lists available execution implementations.
- `POST /api/run` accepts `{ "backend": "javascript", "scene": { ... } }`.
  The response contains `width`, `height`, `backend`, the compiled Y `program`,
  scanline `frames` (indexed pixel arrays, X linked-list snapshots, palette,
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

The only shape primitive is a rectangle with a `radius` parameter. A radius of zero produces square corners; positive radii produce quarter-circle corners. The radius supports CSS-style one-to-four-value shorthand in top-left, top-right, bottom-right, bottom-left order. Adjacent radii are proportionally scaled down if they would overlap. Rounded edges are sampled per scanline in JavaScript and represented as moving X instructions. The renderer produces an indexed pixel buffer for Canvas visualization.

## Current implementation versus target hardware

The current simulator **is not cycle accurate**. It executes the Y instructions scheduled for a scanline, then renders that scanline from the resulting X linked list. It does not yet simulate simultaneous X/Y interpreters, the consumed-prefix ownership frontier, BRAM read/write latency, linked-list pointer hazards, a run producer, or the 64-pixel read-ahead FIFO.

The compiler now emits a compact Y-program with WAIT_Y, ROUND_RECT, SET_PALETTE and HALT instructions. The Y virtual machine executes that bytecode, keeps active rounded-rectangle generators, and materializes an X linked list for each scanline. This keeps program size proportional to scene complexity rather than to the number of curved scanlines. The VM still rebuilds X ordering after each scanline; it is not yet a streaming, frontier-constrained linked-list editor.

Palette changes apply atomically at scanline boundaries in the simulator. The eventual concurrent implementation will require versioning or staging so the next scanline's palette changes cannot affect the current scanline.

## Next milestone

Build a cycle-stepped model with separate X and Y program counters, an explicit old-list read frontier, safe linked-list mutation, a bounded FIFO, horizontal blanking, and stall/underrun instrumentation. Compare its pixel output against the reference renderer and test adversarial scenes with dense edges and simultaneous inserts/deletes.
