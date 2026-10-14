# Raster Engine

An experimental framebuffer-free graphics engine built with Bun, JavaScript, HTML and Canvas.

## Run

```sh
bun run dev
```

Open http://localhost:3000.

Run tests with `bun test`.

## Architecture

The engine represents a scene as two cooperating raster programs:

- **X-program:** An X-sorted linked list of START_PAINT and STOP_PAINT instructions. Each instruction references one of 64 ordered palette layers. Reference counts allow overlapping shapes to share a layer; the highest active layer determines the pixel color.
- **Y-program:** A stream of transformations that changes the X-program between scanlines. Geometry may insert, delete, or move X instructions. Y events can also update palette entries.

The only shape primitive is a rectangle with a `radius` parameter. A radius of zero produces square corners; positive radii produce quarter-circle corners, capped at half the smaller rectangle dimension. Rounded edges are sampled per scanline in JavaScript and represented as moving X instructions. The renderer produces an indexed pixel buffer for Canvas visualization.

## Current implementation versus target hardware

The current simulator **is not cycle accurate**. It executes the Y instructions scheduled for a scanline, then renders that scanline from the resulting X linked list. It does not yet simulate simultaneous X/Y interpreters, the consumed-prefix ownership frontier, BRAM read/write latency, linked-list pointer hazards, a run producer, or the 64-pixel read-ahead FIFO.

The compiler now emits a compact Y-program with WAIT_Y, ROUND_RECT, SET_PALETTE and HALT instructions. The Y virtual machine executes that bytecode, keeps active rounded-rectangle generators, and materializes an X linked list for each scanline. This keeps program size proportional to scene complexity rather than to the number of curved scanlines. The VM still rebuilds X ordering after each scanline; it is not yet a streaming, frontier-constrained linked-list editor.

Palette changes apply atomically at scanline boundaries in the simulator. The eventual concurrent implementation will require versioning or staging so the next scanline's palette changes cannot affect the current scanline.

## Next milestone

Build a cycle-stepped model with separate X and Y program counters, an explicit old-list read frontier, safe linked-list mutation, a bounded FIFO, horizontal blanking, and stall/underrun instrumentation. Compare its pixel output against the reference renderer and test adversarial scenes with dense edges and simultaneous inserts/deletes.
