"""Pure-Python port of engine.js's two-stage, indexed-color rectangle rasterizer.

Y bytecode updates an active rectangle set; that set incrementally edits an
X-sorted linked list of paint transitions. Each emitted row contains palette
indices (0-63), not RGB pixels. ``iter_scanlines`` supports scanline consumers,
such as a later text compositor, without retaining a framebuffer.

The machine uses the same fixed 1280x720 / 64-layer configuration, integer
circle stepping, event ordering, and observable execution trace as engine.js.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import json
import math
from pathlib import Path
import re
from typing import Iterator

from binary_text import TextSource, normalize_text

WIDTH = 1280
HEIGHT = 720
LAYERS = 64


def initial_palette() -> list[str]:
    return ['#101827' if i == 0 else '#ffffff' for i in range(LAYERS)]


def demo_scene() -> dict:
    """An independent JSON snapshot of the JavaScript Paint demo."""
    return json.loads(Path(__file__).with_name('demo-scene.json').read_text())


def _number(value) -> float:
    """The finite portion of JS Number(value) || 0 used for geometry."""
    if value is None:
        return 0.0
    try:
        if isinstance(value, str) and not value.strip():
            return 0.0
        number = float(value)
        return number if math.isfinite(number) else 0.0
    except (TypeError, ValueError, OverflowError):
        return 0.0


def _round(value) -> int:
    # Unlike Python round(), Math.round() rounds positive half ties upward.
    return math.floor(_number(value) + 0.5)


def _clamp(n: int, low: int, high: int) -> int:
    return max(low, min(high, n))


def _expand_radii(radius) -> list[int]:
    if isinstance(radius, (list, tuple)):
        parts = radius
    elif isinstance(radius, str):
        parts = [v for v in re.split(r'[\s,]+', radius.strip()) if v]
    else:
        parts = [radius]
    values = [max(0, _round(v)) for v in parts]
    if not values:
        return [0, 0, 0, 0]
    if len(values) == 1:
        return values * 4
    if len(values) == 2:
        return [values[0], values[1], values[0], values[1]]
    if len(values) == 3:
        return [values[0], values[1], values[2], values[1]]
    return values[:4]


def normalize_rect(shape: dict) -> dict:
    x, y = _round(shape.get('x')), _round(shape.get('y'))
    w, h = max(0, _round(shape.get('w'))), max(0, _round(shape.get('h')))
    layer = _clamp(_round(shape.get('layer')), 1, LAYERS - 1)
    radius = shape.get('radius')
    if radius is None:
        radius = 0
    corners = _expand_radii(radius)
    tl, tr, br, bl = corners
    scale = 1.0
    for total, limit in ((tl + tr, w), (bl + br, w), (tl + bl, h), (tr + br, h)):
        if total > 0:
            scale = min(scale, limit / total)
    radii = [math.floor(r * scale) for r in corners]
    return dict(id=shape['id'], x=x, y=y, w=w, h=h,
                radius=radius, radii=radii, layer=layer)


@lru_cache(maxsize=None)
def _circle_insets(radius: int) -> tuple[int, ...]:
    radius = max(0, math.floor(radius))
    inset = radius
    x, y = 1, 2 * radius - 1
    error = 2 - 4 * radius
    output = []
    for _ in range(radius):
        while inset > 0 and error <= 0:
            inset -= 1
            error += 4 * x + 4
            x += 2
        output.append(inset)
        error += -4 * y + 4
        y -= 2
    return tuple(output)


def circle_insets(radius: int) -> list[int]:
    """Integer quarter-circle insets, in scanline order (a defensive copy)."""
    return list(_circle_insets(radius))


def _span_for_rect(rect: dict, y: int) -> tuple[int, int] | None:
    if y < rect['y'] or y >= rect['y'] + rect['h'] or rect['w'] <= 0 or rect['h'] <= 0:
        return None
    tl, tr, br, bl = rect['radii']
    local_y = y - rect['y']
    left = right = 0
    if local_y < tl:
        left = _circle_insets(tl)[local_y]
    elif local_y >= rect['h'] - bl:
        left = _circle_insets(bl)[rect['h'] - 1 - local_y]
    if local_y < tr:
        right = _circle_insets(tr)[local_y]
    elif local_y >= rect['h'] - br:
        right = _circle_insets(br)[rect['h'] - 1 - local_y]
    return rect['x'] + left, rect['x'] + rect['w'] - right


@dataclass
class XNode:
    key: str
    x: int = 0
    layer: int = 0
    delta: int = 0
    shape: int | None = None
    next: XNode | None = None
    op: str = 'PAINT'
    buffer_ptr: int | str | None = None

    def snapshot(self) -> dict:
        result = dict(key=self.key, x=self.x, layer=self.layer,
                      delta=self.delta, shape=self.shape)
        if self.op != 'PAINT':
            result.update(op=self.op, buffer_ptr=self.buffer_ptr)
        return result


@dataclass
class Machine:
    """Public interpreter state, useful for stepwise text/graphics integration."""
    head: XNode
    nodes: dict[str, XNode]
    active_rects: dict[int, dict]
    active_texts: dict[int, TextSource]
    text_buffers: dict
    text_masks: dict[int, int]
    palette: list[str]
    program: list[dict]
    pc: int = 0
    y: int = 0
    halted: bool = False


def make_machine(scene: dict, program: list[dict]) -> Machine:
    return Machine(head=XNode('HEAD'), nodes={}, active_rects={},
                   active_texts={}, text_buffers=scene.get('textBuffers', {}),
                   text_masks={}, palette=list(scene['palette']), program=program)


def list_edges(head: XNode) -> list[dict]:
    result = []
    node = head.next
    while node is not None:
        if len(result) >= 100000:
            raise ValueError('X linked-list cycle')
        result.append(node.snapshot())
        node = node.next
    return result


def _relink(machine: Machine) -> None:
    ordered = sorted(machine.nodes.values(),
                     key=lambda edge: (edge.x, edge.layer, edge.delta, edge.key))
    tail = machine.head
    for node in ordered:
        tail.next = node
        tail = node
    tail.next = None


def _sync_node(machine: Machine, key: str, edge: XNode, changes: list[dict]) -> None:
    existing = machine.nodes.get(key)
    if existing is None:
        machine.nodes[key] = edge
        changes.append(dict(op='INSERT', key=key, x=edge.x,
                            layer=edge.layer, shape=edge.shape))
    elif (existing.x, existing.layer, existing.delta, existing.op, existing.buffer_ptr) != (edge.x, edge.layer, edge.delta, edge.op, edge.buffer_ptr):
        changes.append(dict(op='MOVE', key=key, **{'from': existing.x}, to=edge.x,
                            layer=edge.layer, shape=edge.shape))
        existing.x, existing.layer, existing.delta, existing.shape = (
            edge.x, edge.layer, edge.delta, edge.shape)
        existing.op, existing.buffer_ptr = edge.op, edge.buffer_ptr


def _delete_node(machine: Machine, key: str, changes: list[dict]) -> None:
    node = machine.nodes.pop(key, None)
    if node is not None:
        changes.append(dict(op='DELETE', key=key, x=node.x,
                            layer=node.layer, shape=node.shape))


def _sync_active_rects(machine: Machine, y: int) -> list[dict]:
    changes = []
    finished = []
    for rect in machine.active_rects.values():
        start_key = f"{rect['id']}:start"
        stop_key = f"{rect['id']}:stop"
        if y < rect['y'] or y >= rect['y'] + rect['h']:
            _delete_node(machine, start_key, changes)
            _delete_node(machine, stop_key, changes)
            if y >= rect['y'] + rect['h']:
                finished.append(rect['id'])
            continue
        span = _span_for_rect(rect, y)
        if span is None:
            _delete_node(machine, start_key, changes)
            _delete_node(machine, stop_key, changes)
            continue
        left, right = (_clamp(_round(p), 0, WIDTH) for p in span)
        if right <= left:
            _delete_node(machine, start_key, changes)
            _delete_node(machine, stop_key, changes)
            continue
        _sync_node(machine, start_key, XNode(start_key, left, rect['layer'], 1, rect['id']), changes)
        _sync_node(machine, stop_key, XNode(stop_key, right, rect['layer'], -1, rect['id']), changes)
    for rect_id in finished:
        del machine.active_rects[rect_id]
    _relink(machine)
    return changes


def _sync_active_texts(machine: Machine, y: int) -> list[dict]:
    """Maintain one start/stop MASK pair per text region, regardless of glyphs.

    Only a one-bit row mask changes between scanlines; the X nodes do not.
    These are object-level X instructions, not character or pixel transitions.
    """
    changes = []
    finished = []
    machine.text_masks.clear()
    for text_id, source in machine.active_texts.items():
        spec = source.spec
        start_key = f'text:{text_id}:start_mask'
        stop_key = f'text:{text_id}:stop_mask'
        if y < spec['y'] or y >= spec['y'] + spec['h']:
            _delete_node(machine, start_key, changes)
            _delete_node(machine, stop_key, changes)
            if y >= spec['y'] + spec['h']:
                finished.append(text_id)
            continue
        left = _clamp(spec['x'], 0, WIDTH)
        right = _clamp(spec['x'] + spec['w'], 0, WIDTH)
        if left >= right:
            _delete_node(machine, start_key, changes)
            _delete_node(machine, stop_key, changes)
            continue
        machine.text_masks[text_id] = source.scanline_bits(y, WIDTH)
        _sync_node(machine, start_key, XNode(start_key, left, spec['layer'], 1,
                   text_id, op='START_MASK', buffer_ptr=spec['buffer_ptr']), changes)
        _sync_node(machine, stop_key, XNode(stop_key, right, spec['layer'], -1,
                   text_id, op='STOP_MASK', buffer_ptr=spec['buffer_ptr']), changes)
    for text_id in finished:
        del machine.active_texts[text_id]
    _relink(machine)
    return changes


def render_row(head: XNode, text_masks: dict[int, int] | None = None) -> tuple[bytearray, int]:
    """Execute a mixed PAINT/MASK X list into palette-layer indices.

    Rectangles contribute constant opacity to their layer. Active text mask
    objects contribute opacity only where their current scanline bit is set.
    Highest covered layer wins. The fast path still paints long solid runs;
    masks are interrogated only inside an active TEXT object's X interval.
    """
    text_masks = {} if text_masks is None else text_masks
    counts = [0] * LAYERS
    mask_sources: dict[int, set[int]] = {}
    row = bytearray(WIDTH)
    node = head.next
    events = top = x = 0

    def apply(edge: XNode, at_x: int) -> None:
        layer = edge.layer
        if not isinstance(layer, int) or not 1 <= layer < LAYERS:
            raise ValueError(f'Invalid paint layer {layer}')
        if edge.op == 'PAINT':
            counts[layer] += edge.delta
            if counts[layer] < 0:
                raise ValueError(f'Unbalanced STOP at x={at_x} layer={layer}')
        elif edge.op == 'START_MASK':
            mask_sources.setdefault(layer, set()).add(edge.shape)
        elif edge.op == 'STOP_MASK':
            active = mask_sources.get(layer)
            if active is None or edge.shape not in active:
                raise ValueError(f'Unbalanced STOP_MASK at x={at_x} layer={layer}')
            active.remove(edge.shape)
            if not active:
                del mask_sources[layer]
        else:
            raise ValueError(f'Unknown X opcode {edge.op}')

    while x < WIDTH:
        if node is not None and node.x <= x:
            while node is not None and node.x <= x:
                apply(node, x)
                node = node.next
                events += 1
            top = next((layer for layer in range(LAYERS - 1, 0, -1)
                        if counts[layer] > 0), 0)
        stop = min(node.x, WIDTH) if node is not None else WIDTH
        if stop <= x:
            raise ValueError('X list is not sorted')
        higher_masks = [(layer, tuple(text_masks.get(text_id, 0) for text_id in ids))
                        for layer, ids in sorted(mask_sources.items(), reverse=True)
                        if layer > top]
        # A solid layer occludes masks on its own and all lower layers.
        if not higher_masks:
            if top:
                row[x:stop] = bytes([top]) * (stop - x)
        else:
            combined = 0
            for _, masks in higher_masks:
                for bits in masks:
                    combined |= bits
            segment = ((1 << (stop - x)) - 1) << x
            if not (combined & segment):
                if top:
                    row[x:stop] = bytes([top]) * (stop - x)
            else:
                for pixel in range(x, stop):
                    layer_at_pixel = top
                    for layer, masks in higher_masks:
                        if any((bits >> pixel) & 1 for bits in masks):
                            layer_at_pixel = layer
                            break
                    row[pixel] = layer_at_pixel
        x = stop
    while node is not None and node.x == WIDTH:
        apply(node, WIDTH)
        node = node.next
        events += 1
    if node is not None:
        raise ValueError('X instruction beyond screen')
    for layer in range(1, LAYERS):
        if counts[layer] != 0:
            raise ValueError(f'Unbalanced layer {layer}')
    if mask_sources:
        raise ValueError('Unbalanced X mask regions')
    return row, events


def compile_y(scene: dict) -> list[dict]:
    buckets: dict[int, list[dict]] = {}

    def push(y: int, instruction: dict) -> None:
        if 0 <= y < HEIGHT:
            buckets.setdefault(y, []).append(instruction)

    for shape in scene.get('shapes', []):
        rect = normalize_rect(shape)
        if rect['w'] > 0 and rect['h'] > 0:
            push(rect['y'], dict(op='ROUND_RECT', rect=rect))
    for text in scene.get('texts', []):
        spec = normalize_text(text)
        if spec['w'] > 0 and spec['h'] > 0:
            push(spec['y'], dict(op='TEXT', text=spec))
    for event in scene.get('paletteEvents', []):
        y, layer = _round(event.get('y')), _round(event.get('layer'))
        if 0 <= y < HEIGHT and 0 <= layer < LAYERS:
            push(y, dict(op='SET_PALETTE', layer=layer, color=event.get('color')))
    program = []
    for y in sorted(buckets):
        program.append(dict(op='WAIT_Y', y=y))
        # JS sorts opcode names alphabetically, then rect id or layer.
        ins = sorted(buckets[y], key=lambda entry: (
            entry['op'], entry['rect']['id'] if entry['op'] == 'ROUND_RECT'
            else entry['text']['id'] if entry['op'] == 'TEXT'
            else entry['layer']))
        program.extend(ins)
    program.extend([dict(op='WAIT_Y', y=HEIGHT), dict(op='HALT')])
    return program


def _execute(machine: Machine, ins: dict) -> None:
    op = ins['op']
    if op == 'ROUND_RECT':
        rect = normalize_rect(ins['rect'])
        if rect['id'] in machine.active_rects:
            raise ValueError(f"Duplicate rounded rectangle {rect['id']}")
        machine.active_rects[rect['id']] = rect
    elif op == 'TEXT':
        spec = normalize_text(ins['text'])
        if spec['id'] in machine.active_texts:
            raise ValueError(f"Duplicate text object {spec['id']}")
        machine.active_texts[spec['id']] = TextSource.create(spec, machine.text_buffers)
    elif op == 'SET_PALETTE':
        layer = ins['layer']
        if not isinstance(layer, int) or not 0 <= layer < LAYERS:
            raise ValueError(f'Invalid palette layer {layer}')
        machine.palette[layer] = ins['color']
    else:
        raise ValueError(f'Unknown Y opcode {op}')


def advance_y(machine: Machine, y: int) -> dict:
    """Run bytecode through y and mutate the X linked list for that row."""
    if y < machine.y:
        raise ValueError('Y machine cannot rewind')
    machine.y = y
    executed = []
    while machine.pc < len(machine.program):
        ins = machine.program[machine.pc]
        if ins['op'] == 'WAIT_Y':
            if ins['y'] > y:
                break
            executed.append(dict(pc=machine.pc, ins=ins))
            machine.pc += 1
            continue
        if ins['op'] == 'HALT':
            machine.halted = True
            break
        _execute(machine, ins)
        executed.append(dict(pc=machine.pc, ins=ins))
        machine.pc += 1
    changes = _sync_active_rects(machine, y)
    changes.extend(_sync_active_texts(machine, y))
    return dict(executed=executed, changes=changes, pc=machine.pc)


def iter_scanlines(scene: dict, program: list[dict] | None = None) -> Iterator[dict]:
    """Yield full JS-compatible scanline dictionaries, one row at a time.

    ``scanline['row']`` is a mutable bytearray of palette-layer indices;
    ``scanline['palette']`` contains the colors at that scanline. A text renderer
    can consume/composite each row here without a full-screen framebuffer.
    """
    if program is None:
        program = compile_y(scene)
    machine = make_machine(scene, program)
    for y in range(HEIGHT):
        step = advance_y(machine, y)
        edges = list_edges(machine.head)
        row, events = render_row(machine.head, machine.text_masks)
        yield dict(y=y, row=row, edges=edges, palette=list(machine.palette),
                   events=events, edits=len(step['changes']), **step)


def run_y_program(scene: dict, program: list[dict]) -> dict:
    scanlines = list(iter_scanlines(scene, program))
    logs = [dict(y=f['y'], events=f['events'], edits=f['edits']) for f in scanlines]
    return dict(program=program, scanlines=scanlines, logs=logs,
                totalEvents=sum(f['events'] for f in scanlines),
                totalEdits=sum(f['edits'] for f in scanlines))


def compile(scene: dict) -> dict:
    return run_y_program(scene, compile_y(scene))


rasterize = compile


def reference_row(scene: dict, y: int) -> bytearray:
    """Independent geometry-only reference, for exact pixel tests."""
    row = bytearray(WIDTH)
    for raw in scene.get('shapes', []):
        span = _span_for_rect(normalize_rect(raw), y)
        if span is None:
            continue
        left, right = (_clamp(_round(p), 0, WIDTH) for p in span)
        if left < right:
            layer = _clamp(_round(raw.get('layer')), 1, LAYERS - 1)
            for x in range(left, right):
                if layer > row[x]:
                    row[x] = layer
    return row


# Familiar JS-shaped aliases, useful when reading the implementations side by side.
compileY = compile_y
runYProgram = run_y_program
advanceY = advance_y
circleInsets = circle_insets
referenceRow = reference_row
demoScene = demo_scene
initialPalette = initial_palette
