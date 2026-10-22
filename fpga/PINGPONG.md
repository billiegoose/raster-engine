# Runtime X programs: first two-buffer implementation

The working Amber RX01 flash engine remains the default. This development
target implements the producer/consumer pipeline for dynamic X programs. Its
procedural producers compute runs in hardware from Y and X coordinates;
they do not read baked row programs. The scene Y bytecode interpreter,
rounded-rectangle stepping, compositing and RED2 text are still to be ported.

Everything runs on the same 148.5 MHz pixel clock, including both RAM ports.
The VGA timing bundle is registered before scheduling to separate counter
carry propagation from the next-row ownership checks.
`scanout.py` retains its tested FIFO, endpoint checks and VGA pipeline. Its
`buffered=True` variant replaces the large ROM with two 2,048-entry arrays
and derives the row start address from Y parity. There is no pointer table or
linked list in this variant. The two arrays occupy 9 KiB logically at 18 bits
per entry; their byte/byte/two-bit banks retain the parity-lane workaround.

`pingpong.py` owns addresses, row tags, writes and publication. The producer
never selects a destination address. Even rows use buffer 0; odd rows use
buffer 1. There is one Y interpreter processing consecutive rows, overlapping
the X interpreter, rather than two independently advancing Y interpreters.

| Interval | X interpreter | Y interpreter |
| --- | --- | --- |
| Vertical blank | Blank | Generate row 0 into buffer 0 |
| Row 0 | Execute buffer 0 | Generate row 1 into buffer 1 |
| Row 1 | Execute buffer 1 | Generate row 2 into buffer 0 |
| Row 2 | Execute buffer 0 | Generate row 3 into buffer 1 |

The exact handoff is at X=1928 in the preceding row's horizontal blank. The
old consumer has flushed at X=1920, with eight clocks to drain in-flight
reads. At X=1928 it claims the completed next-row buffer and starts prefetch;
the old buffer becomes available for the following Y job. Consecutive
handoffs are **2,200 clocks apart**, so Y gets the entire line period rather
than only the 280 blanking clocks. This also gives X 272 clocks of prefetch
before the next active row.

A producer job is `{start, cancel, row, epoch}`. Start can accompany cancel
at a frame restart; cancel takes effect first, then start initializes the
new job. The producer returns zero or one `{valid, end_x, layer, row, epoch,
error}` record each clock. Endpoints must strictly increase from zero and
the final endpoint must be 1920. Idle cycles are allowed; backpressure is
unnecessary because RAM accepts one write per clock. After the terminator,
the producer must stop until the next start. The row and rolling frame tag
must match the job, including after cancellation.

Publication occurs on a separate clock after issuing the terminating write.
A register carries the write/status bundle and beam coordinates into scanout,
keeping ownership logic off its FIFO control path. The RAM accepts the final
write while the controller publishes; the next clock can claim the buffer.
A handoff uses readiness from before that clock's publication, so neither a
same-clock final write nor a same-clock commit can satisfy the deadline.
The supplied dense producer needs 1,920 write clocks plus startup and commit;
its buffer is claimable 1,923 clocks after start, leaving 277 clocks before
the next handoff. The geometry interpreter must fit its own work into this
budget; the dense producer proves stream throughput, not geometry throughput.

A missing row, invalid endpoint, extra word during commit, producer error or
wrong job tag blanks the rest of the frame while sync continues. Partial and
previous-frame buffers are never displayed. At the next vertical blank, tags
are invalidated and row 0 is regenerated. Deadline and producer-error flags
remain latched until the controller is disabled/reset.

## Exercise the actual HDL

```sh
python3 fpga/tool.py sim --dynamic rectangle
python3 fpga/tool.py sim --dynamic stripes
```

The rectangle changes its horizontal position and color with Y. The stress
producer emits 1,920 one-pixel runs, encodes Y in its first eleven pixels,
and alternates the remaining pixels with opposite phase on adjacent rows.
Every row is distinct, including rows sharing a buffer. Both start with empty X buffers. Each command captures a PNG
under `fpga/build/` and compares every pixel against an independent host
reference. Any buffer or consumer error paints the capture magenta.

Native tests use the same Pypeline simulation environment as the original
hardware tests:

```sh
python3.13 -m unittest fpga.test_pingpong.PingPongTests -v
```

They check actual overlapping writes and playback, distinct adjacent rows,
bank reuse, invalid/stale producer data, deadline boundary clocks and recovery.

## Build the separate development bitstream

```sh
python3 fpga/tool.py build --dynamic stripes
```

The output is `fpga/build/raster_dynamic.bit`, separate from `raster_rom.bit`.
The helper checks final routed timing and the physical BRAM data lanes.
The verified dense-producer build reaches **155.62 MHz** for the required
148.5 MHz clock and maps to **six RAMB18 blocks (13.5 KiB)**. The mapped
netlist has no payload on parity lanes and no native BRAM cascades. Both
final HDL captures match all **2,073,600 pixels**. Nine native buffer tests,
the eight existing hardware tests, seven host checks and four UI/API tests
pass. The dense cycle test measures publication at start+1922 and earliest
claim at start+1923. Build details are retained in the ignored
`fpga/build/dynamic-build.json`, logs and captures. This development target
has been routed and simulated; the physical board continues running the
verified Amber ROM engine.

For an explicit board test, `load --dynamic stripes` loads it into volatile
SRAM; `program --dynamic stripes` installs it persistently. Use the same
producer selection as the build; the helper verifies that selection and
the bitstream hash before loading. Development LEDs are LD0=clock lock,
LD12=display enabled, LD13=invalid producer output, LD14=X consumer fault,
LD15=missed Y deadline. This target does not load scene assets from flash.

The next stage plugs the real scene Y interpreter into this job/result
interface. Geometry and active-edge state can live upstream; emitted X
programs stay linear. Palette events will need their own per-buffer version
so generating the next row cannot change colors in the row being displayed.
