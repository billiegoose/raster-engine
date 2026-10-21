/* Match editor glyph coverage to the generated RED2 manifest, not fonts on
 * the viewer's computer. The substituted U+E000 is a *mapped copy* of the
 * source font's .notdef box. Never modify or sanitize saved scene text. */
import {RED2_SUPPORTED_CODEPOINTS, RED2_MISSING_CODEPOINT} from './red2-supported-characters.js';

export const missingGlyph = String.fromCodePoint(RED2_MISSING_CODEPOINT);
export const red2Text = raw => typeof raw === 'string' ? raw :
  Array.isArray(raw) ? new TextDecoder().decode(Uint8Array.from(raw)) : '';
export const red2PreviewText = raw => [...red2Text(raw)].map(character =>
  character === '\n' || RED2_SUPPORTED_CODEPOINTS.has(character.codePointAt(0))
    ? character : missingGlyph).join('');
export const unsupportedRED2Characters = raw => [...new Set(
  [...red2Text(raw)].filter(character =>
    character !== '\n' && !RED2_SUPPORTED_CODEPOINTS.has(character.codePointAt(0)))
)];
