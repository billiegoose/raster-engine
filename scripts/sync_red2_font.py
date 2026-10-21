#!/usr/bin/env python3
"""Sync RED2 webfont assets and browser glyph coverage from ../red2-font.

The font contains a proper glyph-zero .notdef, but browser font fallback
normally hides it. Map a COPY of that outline to reserved U+E000 in our web
assets, allowing our preview to explicitly substitute missing characters.
The canonical upstream dist files and scene text remain unchanged.

Requires fontTools in ../red2-font/.venv at generation time, never runtime.
"""
from pathlib import Path
from hashlib import sha256
import copy
import shutil
import re
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / 'red2-font' / 'dist'
DEST = ROOT / 'fonts'
SENTINEL = 0xE000


def main():
    lines = (SOURCE / 'supported-characters.txt').read_text(encoding='utf-8').splitlines()
    codes = []
    for line in lines:
        if line.startswith('U+'):
            code = int(line.split('\t', 1)[0][2:], 16)
            codes.append(code)
    if not codes or len(set(codes)) != len(codes) or SENTINEL in codes:
        raise ValueError('Unexpected supported-codepoint manifest; inspect updated font')
    DEST.mkdir(exist_ok=True)
    for name in ('RED2-Regular.ttf', 'RED2-Regular.woff2'):
        file = DEST / name
        shutil.copyfile(SOURCE / name, file)
        font = TTFont(file)
        source_codes = set(font.getBestCmap())
        if set(codes) != source_codes:
            raise ValueError(f'{name}: manifest differs from actual font cmap')
        if font['glyf']['.notdef'].numberOfContours == 0:
            raise ValueError(f'{name}: source font has no .notdef artwork')
        missing = 'RED2Missing'
        if missing in font.getGlyphOrder():
            raise ValueError(f'{name}: reserved internal glyph name already in source')
        original_order = list(font.getGlyphOrder())
        font['glyf'][missing] = copy.deepcopy(font['glyf']['.notdef'])
        font['hmtx'].metrics[missing] = font['hmtx'].metrics['.notdef']
        updated_order = original_order + [missing]
        font.setGlyphOrder(updated_order)
        # glyf caches its own ordering independently of TTFont's glyph order.
        font['glyf'].glyphOrder = updated_order
        font['maxp'].numGlyphs = len(updated_order)
        for table in font['cmap'].tables:
            if table.isUnicode():
                table.cmap[SENTINEL] = missing
        print(f'{name}: glyphOrder={len(updated_order)}, glyphDict={len(font["glyf"].glyphs)}, duplicateNames={len(updated_order) - len(set(updated_order))}')
        assert len(updated_order)==len(font['glyf'].glyphs)==len(set(updated_order))
        font.save(file)
        font.close()
        verify = TTFont(file)
        assert set(verify.getBestCmap()) == source_codes | {SENTINEL}
        assert verify['glyf'][verify.getBestCmap()[SENTINEL]].numberOfContours > 0
        verify.close()
        print('Updated', file.relative_to(ROOT), 'with mapped internal missing-glyph outline')
    shutil.copyfile(SOURCE / 'supported-characters.txt', DEST / 'supported-characters.txt')
    modules = [
        '// Generated from ../red2-font/dist/supported-characters.txt.',
        '// U+E000 is a private internal missing-glyph alias, NOT a supported character.',
        'export const RED2_MISSING_CODEPOINT = 0xE000;',
        'export const RED2_SUPPORTED_CODEPOINTS = new Set([',
    ]
    for index in range(0, len(codes), 12):
        modules.append('  ' + ', '.join(f'0x{code:04X}' for code in codes[index:index+12]) + ',')
    modules.extend([']);', ''])
    (ROOT / 'red2-supported-characters.js').write_text('\n'.join(modules), encoding='utf-8')
    css = (SOURCE / 'red2-font.css').read_text(encoding='utf-8')
    for name in ('RED2-Regular.ttf', 'RED2-Regular.woff2'):
        digest = sha256((DEST / name).read_bytes()).hexdigest()[:12]
        css = css.replace(f'./{name}', f'./{name}?v={digest}')
    css = css.replace('"RED2", monospace', '"RED2"')
    (DEST / 'red2-font.css').write_text(css, encoding='utf-8')
    css_version = sha256(css.encode('utf-8')).hexdigest()[:12]
    index = ROOT / 'index.html'
    page = index.read_text(encoding='utf-8')
    pattern = r'(/fonts/red2-font\.css)(?:\?v=[a-f0-9]+)?'
    next_page, replaced = re.subn(pattern, lambda match: match.group(1) + '?v=' + css_version, page)
    if replaced != 1:
        raise ValueError('Expected one font stylesheet reference in index.html')
    index.write_text(next_page, encoding='utf-8')
    print(f'Synced {len(codes)} public codepoints, reserved sentinel U+{SENTINEL:04X}; css version {css_version}')


if __name__ == '__main__':
    main()
