import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {RED2_SUPPORTED_CODEPOINTS,RED2_MISSING_CODEPOINT} from './red2-supported-characters.js';
import {red2Text,red2PreviewText,unsupportedRED2Characters,missingGlyph} from './red2-text.js';

const manifest = readFileSync(new URL('./fonts/supported-characters.txt',import.meta.url),'utf8');
const sourceCodes = [...manifest.matchAll(/^U\+([0-9A-F]+)\t/gm)].map(m=>parseInt(m[1],16));

test('editor glyph support is generated from actual RED2 webfont manifest',()=>{
  expect(sourceCodes).toHaveLength(84);
  expect(new Set(sourceCodes)).toEqual(RED2_SUPPORTED_CODEPOINTS);
  expect(RED2_SUPPORTED_CODEPOINTS.has(RED2_MISSING_CODEPOINT)).toBe(false);
  expect([...('◀▶▲▼')].every(c=>RED2_SUPPORTED_CODEPOINTS.has(c.codePointAt(0)))).toBe(true);
  expect(RED2_SUPPORTED_CODEPOINTS.has('a'.codePointAt(0))).toBe(false);
});

test('unsupported Unicode and lowercase are always displayed as RED2 missing glyphs',()=>{
  expect(red2PreviewText('UTF-8: ◀ ▶ ▲ ▼')).toBe('UTF-8: ◀ ▶ ▲ ▼');
  expect(red2PreviewText('A★b🌼B')).toBe('A'+missingGlyph.repeat(3)+'B');
  expect(red2PreviewText('A\n★B')).toBe('A\n'+missingGlyph+'B');
  expect(unsupportedRED2Characters('A★★b🌼B')).toEqual(['★','b','🌼']);
  expect(missingGlyph).toBe(String.fromCodePoint(0xe000));
});

test('UTF-8 byte buffers decode as Unicode, matching string buffers without mutation',()=>{
  const content='UTF-8: ◀ ▶ ▲ ▼';
  const bytes=[...new TextEncoder().encode(content)];
  expect(red2Text(bytes)).toBe(content);
  expect(red2PreviewText(bytes)).toBe(content);
  expect(bytes).toEqual([...new TextEncoder().encode(content)]);
  expect(red2Text([0x41,0xe2,0x98,0x83,0x42])).toBe('A☃B');
  expect(red2PreviewText([0x41,0xe2,0x98,0x83,0x42])).toBe('A'+missingGlyph+'B');
});
