#!/usr/bin/env python3
"""Generate Unicode RED2 glyphs from ../red2-font without repacking ASCII ROM.

The 2048-byte compressed ASCII ROM and its six-bit kerning classes stay fixed.
Unicode triangles and box drawing use independent 21x32 bitmaps and sparse
pair-kerning overrides. This avoids reassigning ASCII classes when glyph
widths or new Unicode characters change.
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
FONT_DIR = ROOT.parent / 'red2-font'
sys.path[:0] = [str(ROOT), str(FONT_DIR)]

from render_font import AutoKerning, load_glyphs
from red2_font_data import FONT_WORDS, METADATA, KERNING, KERNING_RIGHT_COUNT

TRIANGLES = (0x25B2, 0x25B6, 0x25BC, 0x25C0)
BOX_DRAWING = (0x2500, 0x2502, 0x250C, 0x2510, 0x2514, 0x2518,
               0x251C, 0x2524, 0x252C, 0x2534, 0x253C)


def rom_byte(addr):
    return (FONT_WORDS[addr >> 1] >> ((addr & 1) * 8)) & 255


def ascii_row(code, y):
    bits = METADATA[code]
    top, height, base = (bits >> 15) & 31, (bits >> 9) & 63, (bits >> 20) & 2047
    if y < top or y >= top + height:
        return 0
    i = rom_byte(base + y - top) * 3
    return rom_byte(i) | (rom_byte(i + 1) << 8) | (rom_byte(i + 2) << 16)


def fmt_tuple(name, data):
    lines = [name + ' = (']
    for index in range(0, len(data), 16):
        lines.append('    ' + ', '.join(str(v) for v in data[index:index + 16]) + ',')
    return '\n'.join(lines + [')', ''])


def fmt_dict(name, data):
    lines = [name + ' = {']
    for key, value in sorted(data.items()):
        if isinstance(key, tuple):
            lines.append(f'    (0x{key[0]:04X}, 0x{key[1]:04X}): {value},')
        else:
            lines.append(f'    0x{key:04X}: {value},')
    return '\n'.join(lines + ['}', ''])


def main():
    source = load_glyphs(FONT_DIR / 'RED2 Font.aseprite', 'aseprite')
    if 0 not in source:
        raise ValueError('Source font must contain reserved .notdef glyph at code 0')
    glyphs = {code: glyph for code, glyph in source.items() if code}
    unicode_codes = set(TRIANGLES) | set(BOX_DRAWING)
    if {code for code in glyphs if code >= 128} != unicode_codes:
        raise ValueError('Unexpected Unicode glyph set; inspect and update generator')
    alpha = {code: glyph.getchannel('A') for code, glyph in source.items()}
    for code, image in alpha.items():
        if image.width > 21 or image.height != 32:
            raise ValueError(f'U+{code:04X} exceeds 21x32 pixel renderer limit')

    kerning = AutoKerning(source, spacing=4)
    ascii_codes = [code for code in sorted(glyphs) if code < 128]
    # Verify every original ASCII glyph row and every ASCII-only kerning
    # adjustment. SPACE's source width changed from 12 to 13 pixels, but
    # the glyph is blank and the old immutable bitmap ROM remains valid.
    for code in ascii_codes:
        meta = METADATA[code]
        if not (meta & (1 << 8)):
            raise ValueError(f'U+{code:04X} no longer valid in ASCII ROM')
        rom_width, source_width = meta & 31, alpha[code].width
        if code == 32:
            if (rom_width, source_width) != (12, 13):
                raise ValueError('Unexpected SPACE width; inspect source font')
        elif rom_width != source_width:
            raise ValueError(f'ASCII glyph U+{code:04X} changed width')
        for y in range(32):
            row = sum(bool(alpha[code].getpixel((x, y))) << x for x in range(source_width))
            if ascii_row(code, y) != row:
                raise ValueError(f'ASCII glyph U+{code:04X} changed bitmap row {y}')
    for left in ascii_codes:
        left_class = (METADATA[left] >> 31) & 63
        for right in ascii_codes:
            right_class = (METADATA[right] >> 37) & 63
            old = KERNING[left_class * KERNING_RIGHT_COUNT + right_class]
            current = alpha[left].width + 4 - kerning.advance(left, right)
            if old != current:
                raise ValueError(f'ASCII pair U+{left:04X}/U+{right:04X} changed kerning')

    lines = ['"""Generated from ../red2-font/RED2 Font.aseprite.',
             '', 'Supplementary 1-bit glyph bitmaps and sparse Unicode pair',
             'adjustments. The original hardware-oriented ASCII ROM and',
             'its kerning classes remain unchanged.', '"""', '',
             f'ASCII_SPACE_WIDTH = {alpha[32].width}', '']

    def emit_glyphs(prefix, codes):
        metadata = {}
        rows = {}
        for code in codes:
            image = alpha[code]
            bounds = image.getbbox()
            top, height = (bounds[1], bounds[3] - bounds[1]) if bounds else (0, 0)
            metadata[code] = (image.width, top, height)
            rows[code] = [sum(bool(image.getpixel((x, y))) << x for x in range(image.width))
                          for y in range(32)]
        lines.append(prefix + '_METADATA = {')
        for code in codes:
            lines.append(f'    0x{code:04X}: {metadata[code]},')
        lines.extend(['}', '', prefix + '_ROWS = {'])
        for code in codes:
            lines.append(f'    0x{code:04X}: (')
            for offset in range(0, 32, 8):
                lines.append('        ' + ', '.join(str(v) for v in rows[code][offset:offset+8]) + ',')
            lines.append('    ),')
        lines.extend(['}', ''])

    emit_glyphs('UNICODE', TRIANGLES)
    emit_glyphs('BOX', BOX_DRAWING)

    triangles = set(TRIANGLES)
    boxes = set(BOX_DRAWING)
    sparse_triangle, sparse_box = {}, {}
    for left in sorted(glyphs):
        for right in sorted(glyphs):
            if left not in unicode_codes and right not in unicode_codes:
                continue
            adjustment = alpha[left].width + 4 - kerning.advance(left, right)
            if not 0 <= adjustment <= 15:
                raise ValueError(f'Kerning exceeds four-bit range: {left}, {right}, {adjustment}')
            if adjustment:
                target = sparse_box if left in boxes or right in boxes else sparse_triangle
                target[(left, right)] = adjustment
    lines.append(fmt_dict('UNICODE_KERNING', sparse_triangle))
    lines.append(fmt_dict('BOX_KERNING', sparse_box))

    # Missing-glyph advances indexed by exact codepoint, rather than an old
    # ASCII class index; this also covers the new triangle widths accurately.
    lines.append(fmt_tuple('NOTDEF_METADATA', [alpha[0].width,
        alpha[0].getbbox()[1], alpha[0].getbbox()[3] - alpha[0].getbbox()[1]]))
    lines.append(fmt_tuple('NOTDEF_ROWS', [
        sum(bool(alpha[0].getpixel((x, y))) << x for x in range(alpha[0].width))
        for y in range(32)]))
    lines.append(fmt_dict('NOTDEF_AS_LEFT_ADVANCES', {
        right: kerning.advance(0, right) for right in sorted(glyphs)}))
    lines.append(fmt_dict('NOTDEF_AS_RIGHT_ADVANCES', {
        left: kerning.advance(left, 0) for left in sorted(glyphs)}))
    lines.append(f'NOTDEF_SELF_ADVANCE = {kerning.advance(0, 0)}')
    output = ROOT / 'red2_unicode_data.py'
    output.write_text('\n'.join(lines) + '\n')
    print(f'Generated {len(TRIANGLES)} fixed-width triangles, {len(BOX_DRAWING)} box glyphs, '
          f'{len(sparse_triangle)} triangle and {len(sparse_box)} box pair adjustments: {output}')


if __name__ == '__main__':
    main()
