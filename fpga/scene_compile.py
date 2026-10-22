"""Lower RECT/TEXT scenes to Y events and a reusable binary glyph ROM.

Text layout (UTF-8, wrapping and kerning) is a compiler operation. The FPGA
fetches glyph rows, clips masks, composites layers and builds X programs.
No visible scanlines or X programs are stored in this representation.
"""
from dataclasses import dataclass
import heapq
import struct
from fpga.format import WIDTH, HEIGHT
from fpga.image import rgb444

MAGIC = 0x32305952  # RY02
PALETTE_OFFSET = 0x100
ROWS_OFFSET = 0x200
EVENTS_OFFSET = 0x1000
FONT_OFFSET = 0xb000
EVENT_CAPACITY = 4096
FONT_CAPACITY = 8192
LANES = 64


def pack_event(lane, p):
    font_start = 0 if p.solid else p.glyph+p.top-p.glyph_y
    return (p.left | (p.right << 11) | (p.top << 22) | (p.bottom << 33) |
            (p.layer << 44) | (int(p.solid) << 50) | (font_start << 51) |
            (p.shift << 64) | (lane << 69))


def square_scene(scene):
    return dict(scene, shapes=[dict(s, radius=0) for s in scene.get('shapes', [])], paletteEvents=[])


def placed_glyphs(spec, buffers):
    from binary_text import (TextSource, decode_utf8, metadata,
                             kerning_adjustment, SPACING, LINE_ADVANCE)
    source = TextSource.create(spec, buffers)
    index, forced, line = 0, -1, 0
    while index < len(source.data) and line*LINE_ADVANCE < spec['h']:
        history, following_forced = [], -1
        while index < len(source.data):
            byte_index = index
            code, index = decode_utf8(source.data, index)
            if code == 10:
                break
            if code is None:
                continue
            meta = metadata(code)
            if not meta['valid']:
                code, meta = 0, metadata(0)
            origin = max([0]+[old_x+old_meta['width']+SPACING-kerning_adjustment(old_meta, meta)
                              for _, old_x, old_meta in history])
            if origin+meta['width'] > spec['w']:
                if meta['width'] > spec['w'] and byte_index == forced:
                    origin = 0
                else:
                    index = byte_index
                    if meta['width'] > spec['w']:
                        following_forced = byte_index
                    break
            yield code, spec['x']+origin, spec['y']+line*LINE_ADVANCE
            history = (history+[(code, origin, meta)])[-2:]
        forced = following_forced
        line += 1


@dataclass(frozen=True)
class Primitive:
    top: int
    bottom: int
    left: int
    right: int
    layer: int
    solid: bool
    glyph: int = 0
    glyph_y: int = 0
    shift: int = 0


@dataclass(frozen=True)
class SceneProgram:
    palette: tuple
    primitives: tuple
    events: tuple
    rows: tuple
    font: tuple
    lanes: int
    metrics: dict

    def to_bytes(self):
        sections = [(PALETTE_OFFSET, struct.pack('<64H', *self.palette)),
                    (ROWS_OFFSET, struct.pack('<1081H', *self.rows)),
                    (EVENTS_OFFSET, b''.join(pack_event(lane, p).to_bytes(10, 'little') for lane, p in self.events)),
                    (FONT_OFFSET, b''.join(row.to_bytes(3, 'little') for row in self.font))]
        data = bytearray(FONT_OFFSET+3*len(self.font))
        checksum = sum(sum(raw) for _, raw in sections) & 0xffffffff
        struct.pack_into('<8I', data, 0, MAGIC, WIDTH | (HEIGHT << 16),
                         len(self.events), len(self.font), checksum, self.lanes, 0, 0)
        for offset, raw in sections:
            data[offset:offset+len(raw)] = raw
        return bytes(data)


def compile_scene(scene):
    from binary_text import normalize_text, metadata, glyph_row
    from engine import canvas_size, normalize_rect
    if canvas_size(scene) != (WIDTH, HEIGHT):
        raise ValueError('Dynamic engine requires 1920 × 1080')
    palette = tuple(rgb444(c) for c in scene['palette'])
    if len(palette) != 64:
        raise ValueError('Expected 64 palette entries')
    codes, font, primitives = {}, [], []
    for shape in scene.get('shapes', []):
        r = normalize_rect(shape)
        if not 0 <= r['y'] < HEIGHT:
            continue
        left, right = max(0, r['x']), min(WIDTH, r['x']+r['w'])
        bottom = min(HEIGHT, r['y']+r['h'])
        if left < right and r['y'] < bottom:
            primitives.append(Primitive(r['y'], bottom, left, right, r['layer'], True))
    for raw in scene.get('texts', []):
        spec = normalize_text(raw)
        if not 0 <= spec['y'] < HEIGHT or not spec['w'] or not spec['h']:
            continue
        for code, x, y in placed_glyphs(spec, scene.get('textBuffers', {})):
            m = metadata(code)
            top, bottom = max(0, y+m['top']), min(HEIGHT, spec['y']+spec['h'], y+m['top']+m['height'])
            left, right = max(0, x), min(WIDTH, spec['x']+spec['w'], x+21)
            if top >= bottom or left >= right:
                continue
            if code not in codes:
                codes[code] = len(font)
                font.extend(glyph_row(code, row) for row in range(32))
            primitives.append(Primitive(top, bottom, left, right, spec['layer'], False,
                                        codes[code], y, left-x))
    # Interval coloring assigns a physical lane only for the rows on which
    # a primitive is alive. Glyph overlap remains independent and transparent.
    active, free, lanes = [], [], 0
    buckets = [[] for _ in range(HEIGHT+1)]
    for p in sorted(primitives, key=lambda p: p.top):
        while active and active[0][0] <= p.top:
            _, lane = heapq.heappop(active)
            heapq.heappush(free, lane)
        if free:
            lane = heapq.heappop(free)
        else:
            lane, lanes = lanes, lanes+1
        heapq.heappush(active, (p.bottom, lane))
        buckets[p.top].append((lane, p))
        # Expiry is checked from bottom in hardware; no CLEAR instructions.
    events, rows = [], []
    for bucket in buckets:
        rows.append(len(events))
        events.extend(bucket)
    row_active = [sum(p.top <= y < p.bottom for p in primitives) for y in range(HEIGHT)]
    metrics = dict(primitives=len(primitives), glyphs=len(font)//32, lanes=lanes,
                   peak_events=max(map(len, buckets)), peak_active=max(row_active, default=0))
    if lanes > LANES or len(events) > EVENT_CAPACITY or len(font) > FONT_CAPACITY:
        raise ValueError('Dynamic scene exceeds 64 active primitives, 4,096 events or 256 glyphs')
    metrics['worst_setup_records'] = max((len(b)+LANES for b in buckets), default=LANES)
    return SceneProgram(palette, tuple(primitives), tuple(events), tuple(rows), tuple(font), max(1, lanes), metrics)


def decode_scene(data):
    if len(data) < FONT_OFFSET:
        raise ValueError('Truncated Y program')
    magic, dimensions, event_count, font_count, checksum, lanes, reserved0, reserved1 = struct.unpack_from('<8I', data)
    if (magic != MAGIC or dimensions != WIDTH | (HEIGHT << 16) or reserved0 or reserved1 or
            not 0 <= event_count <= EVENT_CAPACITY or not 0 <= font_count <= FONT_CAPACITY or
            not 1 <= lanes <= LANES or len(data) != FONT_OFFSET+3*font_count):
        raise ValueError('Invalid Y-program header')
    palette = struct.unpack_from('<64H', data, PALETTE_OFFSET)
    rows = struct.unpack_from('<1081H', data, ROWS_OFFSET)
    events = tuple(int.from_bytes(data[EVENTS_OFFSET+10*i:EVENTS_OFFSET+10*i+10], 'little') for i in range(event_count))
    font = tuple(int.from_bytes(data[FONT_OFFSET+3*i:FONT_OFFSET+3*i+3], 'little') for i in range(font_count))
    sections = ((PALETTE_OFFSET, 128), (ROWS_OFFSET, 2162), (EVENTS_OFFSET, 10*event_count), (FONT_OFFSET, 3*font_count))
    if sum(sum(data[o:o+n]) for o, n in sections) & 0xffffffff != checksum:
        raise ValueError('Y-program checksum mismatch')
    if (any(c > 4095 for c in palette) or rows[0] != 0 or rows[-1] != event_count or
            any(a > b or b > event_count for a, b in zip(rows, rows[1:])) or
            any(word >> 21 for word in font)):
        raise ValueError('Invalid Y-program resources')
    for y in range(HEIGHT):
        seen = set()
        for word in events[rows[y]:rows[y+1]]:
            left, right = word & 2047, (word >> 11) & 2047
            top, bottom = (word >> 22) & 2047, (word >> 33) & 2047
            layer, solid = (word >> 44) & 63, (word >> 50) & 1
            base, shift, lane = (word >> 51) & 8191, (word >> 64) & 31, (word >> 69) & 63
            if (word >> 75 or not 0 <= left < right <= WIDTH or top != y or not top < bottom <= HEIGHT or
                    not layer or shift > 20 or lane >= lanes or lane in seen or
                    (not solid and base+bottom-top > font_count)):
                raise ValueError('Invalid RECT/TEXT event')
            seen.add(lane)
    return palette, rows, events, font
