"""Hardware-oriented, 1-bit RED2 text scanline source.

Consumes the same compressed ROM, kerning classes and two-glyph history as
fpgatool/examples/hardware/vga_uart_pixels.py. Unlike an image compositor, it
replays a distinct byte buffer for each active text object on every glyph row.
The result is a single bit mask of screen pixels, not glyph-sized X nodes or a
framebuffer. No Aseprite, Pillow, or Pypeline dependency at runtime.

A buffer pointer is a logical allocation handle: ``textBuffers`` maps its
numeric/string key to an independent byte array or ASCII/UTF-8 string.
"""

from __future__ import annotations

from dataclasses import dataclass

from red2_font_data import FONT_WORDS, METADATA, KERNING, KERNING_RIGHT_COUNT
from red2_unicode_data import (
    UNICODE_METADATA, UNICODE_ROWS, UNICODE_KERNING,
    BOX_METADATA, BOX_ROWS, BOX_KERNING, ASCII_SPACE_WIDTH,
    NOTDEF_METADATA, NOTDEF_ROWS, NOTDEF_AS_LEFT_ADVANCES,
    NOTDEF_AS_RIGHT_ADVANCES, NOTDEF_SELF_ADVANCE)


GLYPH_HEIGHT = 32
LINE_ADVANCE = 36
SPACING = 4


def _rom_byte(address: int) -> int:
    word = FONT_WORDS[address >> 1]
    return (word >> (8 * (address & 1))) & 0xff


def metadata(code: int) -> dict:
    if code == 0:
        width, top, height = NOTDEF_METADATA
        return dict(valid=True, code=0, missing=True, width=width, top=top,
                    height=height, backtrack=0, base=0)
    if code in BOX_METADATA:
        width, top, height = BOX_METADATA[code]
        return dict(valid=True, code=code, box=True, width=width,
                    top=top, height=height, backtrack=0, base=0)
    if code in UNICODE_METADATA:
        width, top, height = UNICODE_METADATA[code]
        return dict(valid=True, code=code, unicode=True, width=width,
                    backtrack=0, height=height, top=top, base=0)
    if not 0 <= code < 128:
        return dict(valid=False)
    bits = METADATA[code]
    return dict(valid=bool((bits >> 8) & 1), code=code,
                width=ASCII_SPACE_WIDTH if code == 32 else bits & 31,
                backtrack=(bits >> 5) & 7, height=(bits >> 9) & 63,
                top=(bits >> 15) & 31, base=(bits >> 20) & 2047,
                left_class=(bits >> 31) & 63,
                right_class=(bits >> 37) & 63)


def glyph_row(code: int, y: int) -> int:
    """Decode one 21-bit binary glyph row from its cropped dictionary entry."""
    meta = metadata(code)
    if not meta['valid'] or y < meta['top'] or y >= meta['top'] + meta['height']:
        return 0
    if code == 0:
        return NOTDEF_ROWS[y]
    if code in UNICODE_ROWS:
        return UNICODE_ROWS[code][y]
    if code in BOX_ROWS:
        return BOX_ROWS[code][y]
    index = _rom_byte(meta['base'] + y - meta['top'])
    address = index * 3
    return _rom_byte(address) | (_rom_byte(address + 1) << 8) | (_rom_byte(address + 2) << 16)


def kerning_adjustment(left: dict, right: dict) -> int:
    if left.get('missing'):
        step = (NOTDEF_SELF_ADVANCE if right.get('missing') else
                NOTDEF_AS_LEFT_ADVANCES[right['code']])
        return left['width'] + SPACING - step
    if right.get('missing'):
        return left['width'] + SPACING - NOTDEF_AS_RIGHT_ADVANCES[left['code']]
    if left.get('box') or right.get('box'):
        return BOX_KERNING.get((left['code'], right['code']), 0)
    if left.get('unicode') or right.get('unicode'):
        return UNICODE_KERNING.get((left['code'], right['code']), 0)
    return KERNING[left['left_class'] * KERNING_RIGHT_COUNT + right['right_class']]


def pair_advance(previous: int, current: int) -> int:
    left, right = metadata(previous), metadata(current)
    return left['width'] + SPACING - kerning_adjustment(left, right)


def decode_utf8(data: bytes, index: int) -> tuple[int | None, int]:
    """Decode a UTF-8 scalar with byte-based offsets; skip malformed bytes.

    Invalid lead bytes advance one byte so a following valid glyph or LF is
    never swallowed. A snapshot cut in the middle of a scalar is ignored.
    """
    first = data[index]
    if first < 0x80:
        return first, index + 1
    if 0xC2 <= first <= 0xDF:
        length, minimum = 2, 0x80
        scalar = first & 0x1F
    elif 0xE0 <= first <= 0xEF:
        length, minimum = 3, 0x800
        scalar = first & 0x0F
    elif 0xF0 <= first <= 0xF4:
        length, minimum = 4, 0x10000
        scalar = first & 0x07
    else:
        return None, index + 1
    if index + length > len(data):
        return None, index + 1
    for byte in data[index + 1:index + length]:
        if byte & 0xC0 != 0x80:
            return None, index + 1
        scalar = (scalar << 6) | (byte & 0x3F)
    if scalar < minimum or 0xD800 <= scalar <= 0xDFFF or scalar > 0x10FFFF:
        return None, index + 1
    return scalar, index + length


def buffer_bytes(data) -> bytes:
    if isinstance(data, str):
        return data.encode('utf-8')
    if isinstance(data, (bytes, bytearray)):
        return bytes(data)
    if isinstance(data, list) and all(isinstance(value, int) and 0 <= value <= 255
                                      for value in data):
        return bytes(data)
    raise ValueError('Text buffer must be a string or sequence of bytes')


def normalize_text(raw: dict) -> dict:
    """Validate an independent text object's geometry and buffer reference."""
    x, y = int(raw['x']), int(raw['y'])
    w, h = int(raw.get('w', raw.get('width', 0))), int(raw.get('h', raw.get('height', 0)))
    layer = int(raw['layer'])
    if not 1 <= layer < 64 or w < 0 or h < 0:
        raise ValueError('Invalid TEXT layer or bounds')
    if 'buffer_ptr' not in raw:
        raise ValueError('TEXT requires buffer_ptr')
    return dict(id=raw['id'], x=x, y=y, w=w, h=h, layer=layer,
                buffer_ptr=raw['buffer_ptr'], buffer_length=raw.get('buffer_length'))


@dataclass
class TextSource:
    """A scanline-replayed text object with its own character-buffer snapshot."""
    spec: dict
    data: bytes
    line_start: int = 0
    line_end: int = 0
    line_number: int = -1
    forced_oversized_index: int = -1
    next_forced_oversized_index: int = -1

    @classmethod
    def create(cls, spec: dict, buffers: dict) -> TextSource:
        key = str(spec['buffer_ptr'])
        if key not in buffers:
            raise ValueError(f'TEXT buffer_ptr {key!r} does not exist')
        content = buffer_bytes(buffers[key])
        length = spec['buffer_length']
        if length is None:
            length = len(content)
        if not isinstance(length, int) or not 0 <= length <= len(content):
            raise ValueError(f'TEXT buffer_length invalid for {key!r}')
        return cls(spec, content[:length])

    def scanline_bits(self, y: int, screen_width: int) -> int:
        """Advance text-line state and return screen-space ink bits for Y.

        Bit x corresponds to screen pixel x. Bits are constructed from row ROM
        words with integer shifts and OR, as in Pypeline's 64-bit window.
        Text outside the object's rectangle is transparent; no background is
        filled. Newline and overflow advance only on glyph-line boundaries.
        """
        spec = self.spec
        local_y = y - spec['y']
        if not 0 <= local_y < spec['h'] or not spec['w']:
            return 0
        line_number, glyph_y = divmod(local_y, LINE_ADVANCE)
        if line_number != self.line_number:
            if line_number < self.line_number:
                raise ValueError('TEXT source cannot rewind')
            while self.line_number < line_number:
                if self.line_number >= 0:
                    self.line_start = self.line_end
                    self.forced_oversized_index = self.next_forced_oversized_index
                self.line_number += 1
                if self.line_number < line_number:
                    _, self.line_end = self._compose_line(0, emit=False)
        if glyph_y >= GLYPH_HEIGHT:
            return 0
        bits, self.line_end = self._compose_line(glyph_y, emit=True)
        left = spec['x']
        if left >= 0:
            bits <<= left
        else:
            bits >>= -left
        return bits & ((1 << screen_width) - 1)

    def _compose_line(self, glyph_y: int, *, emit: bool) -> tuple[int, int]:
        spec = self.spec
        data = self.data
        index = self.line_start
        history: list[tuple[int, int, dict]] = []
        bits = 0
        self.next_forced_oversized_index = -1
        while index < len(data):
            code_index = index
            code, index = decode_utf8(data, index)
            if code == 10:  # LF consumed; a separate line begins next.
                return bits, index
            if code is None:
                continue
            meta = metadata(code)
            if not meta['valid']:
                code = 0  # Render the reserved RED2 .notdef bitmap for unsupported Unicode.
                meta = metadata(code)
            origin = 0
            for prev_code, prev_origin, prev_meta in history:
                delta = prev_meta['width'] + SPACING - kerning_adjustment(prev_meta, meta)
                origin = max(origin, prev_origin + delta)
            if origin + meta['width'] > spec['w']:
                # A glyph wider than the entire region can never fit. The
                # independent UART-column renderer wraps it once, then draws
                # its clipped pixels at the start of the following line. Keep
                # that byte pending throughout the current glyph scanlines;
                # otherwise repeated row replays would retry it too soon.
                # This glyph was wrapped by the *preceding* logical text
                # line. Draw it clipped once, even if it can never fit the box;
                # all glyph-row replays of this line must make the same choice.
                if meta['width'] > spec['w'] and code_index == self.forced_oversized_index:
                    origin = 0
                else:
                    if meta['width'] > spec['w']:
                        self.next_forced_oversized_index = code_index
                    return bits, code_index
            if emit:
                # An oversized glyph is clipped to the region's right edge.
                # Never let its excess ink spill into other scene objects.
                visible_width = max(0, spec['w'] - origin)
                bits |= (glyph_row(code, glyph_y) & ((1 << visible_width) - 1)) << origin
            history = (history + [(code, origin, meta)])[-2:]
        return bits, len(data)
