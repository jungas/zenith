/**
 * Fonts, reduced to the two questions text extraction actually asks:
 * *what character is this byte* and *how far does the pen move afterwards*.
 *
 * The second question matters as much as the first here. A statement is a
 * table, and the only thing separating "GROCERY STORE" from "1,240.00" in the
 * content stream is horizontal distance — so a run's width is what turns a
 * scatter of glyphs back into columns.
 */

import { isArray, isDict, isName, isStream } from './objects.ts';
import type { PdfDict, PdfObject } from './objects.ts';
import type { PdfDocument } from './document.ts';

export interface Glyph {
  code: number;
  text: string;
  /** Advance width in 1/1000 of the font size. */
  width: number;
  /** True for the single-byte code 32, which `Tw` word spacing applies to. */
  isWordSpace: boolean;
}

export interface PdfFont {
  decode(bytes: Uint8Array): Glyph[];
}

/**
 * cp1252's high range — where WinAnsiEncoding parts company with Latin-1. Keyed
 * by code rather than written as one 32-character literal, because that range
 * has holes in it and an off-by-one inside a string of accents is invisible.
 */
const WIN_ANSI_HIGH: Record<number, string> = {
  128: '\u20ac', 130: '\u201a', 131: '\u0192', 132: '\u201e', 133: '\u2026',
  134: '\u2020', 135: '\u2021', 136: '\u02c6', 137: '\u2030', 138: '\u0160',
  139: '\u2039', 140: '\u0152', 142: '\u017d', 145: '\u2018', 146: '\u2019',
  147: '\u201c', 148: '\u201d', 149: '\u2022', 150: '\u2013', 151: '\u2014',
  152: '\u02dc', 153: '\u2122', 154: '\u0161', 155: '\u203a', 156: '\u0153',
  158: '\u017e', 159: '\u0178',
};

/** MacRomanEncoding, codes 128–255. */
const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéè' +
  'êëíìîïñóòôöõúùûü' +
  '†°¢£§•¶ß®©™´¨≠ÆØ' +
  '∞±≤≥¥µ∂∑∏π∫ªºΩæø' +
  '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ' +
  '–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ' +
  '‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ' +
  'ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

/**
 * Glyph names that appear in `/Differences` arrays often enough to matter on a
 * statement. Anything else falls through to the `uniXXXX` forms or is dropped.
 */
const GLYPH_NAMES: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
  ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*',
  plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', colon: ':', semicolon: ';',
  less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
  backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`',
  braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  bullet: '•', endash: '–', emdash: '—', quoteleft: '‘',
  quoteright: '’', quotedblleft: '“', quotedblright: '”',
  sterling: '£', yen: '¥', cent: '¢', currency: '¤', Euro: '€',
  peso: '₱', dagger: '†', degree: '°', plusminus: '±',
  nbspace: ' ', fi: 'ﬁ', fl: 'ﬂ',
};

function glyphNameToText(name: string): string {
  const known = GLYPH_NAMES[name];
  if (known) return known;
  if (/^[A-Za-z]$/.test(name)) return name;
  const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni?.[1]) return String.fromCodePoint(Number.parseInt(uni[1], 16));
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u?.[1]) return String.fromCodePoint(Number.parseInt(u[1], 16));
  return '';
}

function baseEncodingTable(encoding: string | null): string[] {
  const table: string[] = [];
  for (let code = 0; code < 256; code++) {
    if (code >= 32 && code <= 126) table[code] = String.fromCharCode(code);
    else table[code] = '';
  }
  if (encoding === 'MacRomanEncoding') {
    for (let code = 128; code < 256; code++) table[code] = MAC_ROMAN_HIGH[code - 128] ?? '';
  } else {
    // WinAnsi is both the common case and the sane default: above 160 it is
    // Latin-1, which is also what a producer that names no encoding usually means.
    for (let code = 128; code < 160; code++) table[code] = WIN_ANSI_HIGH[code] ?? '';
    for (let code = 160; code < 256; code++) table[code] = String.fromCharCode(code);
  }
  return table;
}

/**
 * A `/ToUnicode` CMap: the producer's own statement of what its glyph codes
 * mean. When one is present it beats every other source, which is what makes
 * subsetted fonts (`ABCDEF+Helvetica`, codes starting at 1) readable at all.
 */
function parseToUnicode(data: Uint8Array): { map: Map<number, string>; twoByte: boolean } {
  const map = new Map<number, string>();
  let twoByte = false;
  let text = '';
  for (const byte of data) text += String.fromCharCode(byte);

  const hexToText = (hex: string): string => {
    let out = '';
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
      const unit = Number.parseInt(hex.slice(i, i + 4), 16);
      if (Number.isFinite(unit)) out += String.fromCharCode(unit);
    }
    // Surrogate pairs arrive as two units and `String.fromCharCode` already
    // joins them correctly, so nothing more is needed here.
    return out;
  };

  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    const first = /<([0-9A-Fa-f]+)>/.exec(block[1] ?? '');
    if ((first?.[1]?.length ?? 0) >= 4) twoByte = true;
  }

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const entry of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      const code = Number.parseInt(entry[1] ?? '', 16);
      if ((entry[1]?.length ?? 0) >= 4) twoByte = true;
      if (Number.isFinite(code)) map.set(code, hexToText(entry[2] ?? ''));
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? '';
    // Form 1: <lo> <hi> <start>
    for (const entry of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      const lo = Number.parseInt(entry[1] ?? '', 16);
      const hi = Number.parseInt(entry[2] ?? '', 16);
      if ((entry[1]?.length ?? 0) >= 4) twoByte = true;
      const startHex = entry[3] ?? '';
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo > 65535) continue;
      const prefix = startHex.slice(0, Math.max(0, startHex.length - 4));
      const tail = Number.parseInt(startHex.slice(-4), 16);
      for (let code = lo; code <= hi; code++) {
        const unit = (tail + (code - lo)).toString(16).padStart(4, '0');
        map.set(code, hexToText(prefix + unit));
      }
    }
    // Form 2: <lo> <hi> [ <a> <b> … ]
    for (const entry of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = Number.parseInt(entry[1] ?? '', 16);
      if (!Number.isFinite(lo)) continue;
      if ((entry[1]?.length ?? 0) >= 4) twoByte = true;
      let offset = 0;
      for (const item of (entry[3] ?? '').matchAll(/<([0-9A-Fa-f]*)>/g)) {
        map.set(lo + offset, hexToText(item[1] ?? ''));
        offset++;
      }
    }
  }

  return { map, twoByte };
}

/**
 * Advance widths for the standard 14 fonts, codes 32–126.
 *
 * A PDF may use these without embedding them and without a `/Widths` array,
 * because every reader is required to know them already. Assuming half an em
 * instead is not close enough to be useful: `PURCHASES/CHARGES` in
 * Helvetica-Bold is 1.36 em wide per character on average, so a column heading
 * comes out 26 points narrower than it is — and a heading whose right edge is
 * wrong stops matching the amounts underneath it, which is the whole mechanism
 * for telling a debit column from a credit one.
 */
const STANDARD_WIDTHS: Record<'helvetica' | 'helveticaBold' | 'times' | 'timesBold', number[]> = {
  helvetica: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  helveticaBold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
  times: [
    250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
    921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
    556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
    333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
    500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
  ],
  timesBold: [
    250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
    930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
    611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
    333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
    556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
  ],
};

/**
 * Match a base font name to one of the standard metric sets.
 *
 * The name may carry a subset prefix (`ABCDEF+Helvetica`) and is frequently a
 * near-relative rather than the font itself — Arial for Helvetica, Times New
 * Roman for Times. They share metrics, which is why the substitution is safe.
 */
function standardWidths(baseFont: string | null): number[] | null {
  if (!baseFont) return null;
  const name = baseFont.replace(/^[A-Z]{6}\+/, '').toLowerCase();
  const bold = /bold|black|heavy|semibold/.test(name);
  if (/courier|mono/.test(name)) return null; // fixed pitch, handled by its own default
  if (/times|serif|roman|georgia|garamond|book/.test(name)) {
    return STANDARD_WIDTHS[bold ? 'timesBold' : 'times'];
  }
  if (/helvetica|arial|verdana|tahoma|calibri|sans/.test(name)) {
    return STANDARD_WIDTHS[bold ? 'helveticaBold' : 'helvetica'];
  }
  return null;
}

/**
 * A `Type3` font whose every glyph is its own unlabeled bitmap.
 *
 * Rather than embed a real font program, this scheme draws each character as
 * a tiny inline image (`BI ... /IM true ... ID <bits> EI`) inside its
 * `CharProc`, and names the glyph after nothing more than its own code in hex
 * (`C40`, `Cd7`, …). There is no `/ToUnicode` and the glyph names carry no
 * meaning, so nothing here says a code is a "P" rather than a "7" — the
 * shapes still print correctly, but copying the text does not. Some
 * statement portals generate PDFs exactly this way specifically to defeat
 * copy-paste and naive text extraction; a BPI "Statement of Account"
 * downloaded from their web portal is the one this was recovered from.
 *
 * The table below maps that scheme's codes back to characters. It was
 * recovered by hand — cross-referencing every string a real statement drew
 * against what the rendered page actually shows, letter by letter — rather
 * than guessed from glyph shape. It held identically across every one of the
 * ten-plus font resources that one statement used (headers, table cells, the
 * address block, the fine print), which is what a single fixed substitution
 * table looks like rather than one re-rolled per document. Codes it does not
 * cover — a handful of rare letters this statement never happened to use —
 * decode to nothing rather than a guess, the same as any other undecodable
 * glyph.
 */
const TYPE3_BITMAP_GLYPH_NAME = /^c[0-9a-f]{2}$/i;

const TYPE3_BITMAP_CODE_TABLE: Record<number, string> = {
  64: ' ', 75: '.', 96: '-', 97: '/', 107: ',', 108: '%', 124: '@', 125: "'",
  129: 'a', 130: 'b', 131: 'c', 132: 'd', 133: 'e', 134: 'f', 135: 'g', 136: 'h',
  137: 'i', 146: 'k', 147: 'l', 148: 'm', 149: 'n', 150: 'o', 151: 'p', 152: 'q',
  153: 'r', 162: 's', 163: 't', 164: 'u', 165: 'v', 166: 'w', 167: 'x', 168: 'y', 169: 'z',
  193: 'A', 194: 'B', 195: 'C', 196: 'D', 197: 'E', 198: 'F', 199: 'G', 200: 'H',
  201: 'I', 209: 'J', 211: 'L', 212: 'M', 213: 'N', 214: 'O', 215: 'P', 217: 'R',
  226: 'S', 227: 'T', 228: 'U', 230: 'W', 232: 'Y',
  240: '0', 241: '1', 242: '2', 243: '3', 244: '4', 245: '5', 246: '6', 247: '7', 248: '8', 249: '9',
};

/**
 * Does this font's `/Differences` look like the scheme above rather than a
 * real glyph-name encoding?
 *
 * The naming convention (`C` + two hex digits) is cheap to recognise and does
 * not need a CharProc opened to check it — which matters, because a font can
 * carry hundreds of them. Requiring *every* named entry to match, over a
 * real sample size, is what keeps an ordinary font that happens to name one
 * glyph `Cfe` out of this path: a coincidence would have to repeat across
 * the whole `/Differences` array, not just once.
 */
function looksLikeType3BitmapEncoding(doc: PdfDocument, dict: PdfDict): boolean {
  const encoding = doc.resolve(dict.get('Encoding'));
  if (!isDict(encoding)) return false;
  const differences = doc.get(encoding, 'Differences');
  if (!isArray(differences)) return false;
  let named = 0;
  let matching = 0;
  for (const entry of differences) {
    const value = doc.resolve(entry);
    if (isName(value)) {
      named++;
      if (TYPE3_BITMAP_GLYPH_NAME.test(value.name)) matching++;
    }
  }
  return named >= 8 && matching === named;
}

/** Simple fonts: one byte per code, widths indexed from `/FirstChar`. */
function simpleFont(doc: PdfDocument, dict: PdfDict): PdfFont {
  const isType3Bitmap = doc.name(dict.get('Subtype')) === 'Type3' && looksLikeType3BitmapEncoding(doc, dict);
  const table = (() => {
    const encoding = doc.resolve(dict.get('Encoding'));
    const baseName = isName(encoding)
      ? encoding.name
      : isDict(encoding)
        ? doc.name(encoding.get('BaseEncoding'))
        : null;
    const built = baseEncodingTable(baseName);
    if (isDict(encoding)) {
      const differences = doc.get(encoding, 'Differences');
      if (isArray(differences)) {
        let code = 0;
        for (const entry of differences) {
          const value = doc.resolve(entry);
          if (typeof value === 'number') code = Math.round(value);
          else if (isName(value)) {
            built[code] = isType3Bitmap ? (TYPE3_BITMAP_CODE_TABLE[code] ?? '') : glyphNameToText(value.name);
            code++;
          }
        }
      }
    }
    return built;
  })();

  const toUnicode = (() => {
    const stream = doc.resolve(dict.get('ToUnicode'));
    return isStream(stream) ? parseToUnicode(doc.streamData(stream)).map : null;
  })();

  const firstChar = doc.num(dict.get('FirstChar'), 0);
  const widths = doc.array(dict.get('Widths')).map((entry) => doc.num(entry));
  const descriptor = doc.dict(dict.get('FontDescriptor'));
  const missingWidth = doc.num(descriptor?.get('MissingWidth'), 0);
  const baseFont = doc.name(dict.get('BaseFont'));
  const standard = standardWidths(baseFont);
  const fixedPitch = /courier|mono/i.test(baseFont ?? '');
  // Courier and its relatives are fixed pitch at 600; everything else with no
  // metrics at all falls back to half an em.
  const fallbackWidth = missingWidth || (fixedPitch ? 600 : 500);

  return {
    decode(bytes: Uint8Array): Glyph[] {
      const out: Glyph[] = [];
      for (const code of bytes) {
        const declared = widths[code - firstChar];
        const known = standard?.[code - 32];
        const width =
          typeof declared === 'number' && declared > 0
            ? declared
            : code >= 32 && code <= 126 && known
              ? known
              : fallbackWidth;
        out.push({
          code,
          text: toUnicode?.get(code) ?? table[code] ?? '',
          width,
          isWordSpace: code === 32,
        });
      }
      return out;
    },
  };
}

/** Composite (Type0) fonts: two-byte codes, widths from the descendant's `/W`. */
function compositeFont(doc: PdfDocument, dict: PdfDict): PdfFont {
  const descendant = doc.dict(doc.array(dict.get('DescendantFonts'))[0]);
  const defaultWidth = doc.num(descendant?.get('DW'), 1000) || 1000;

  const widths = new Map<number, number>();
  const w = doc.array(descendant?.get('W'));
  for (let i = 0; i < w.length; ) {
    const start = doc.num(w[i]);
    const next = doc.resolve(w[i + 1]);
    if (isArray(next)) {
      next.forEach((entry, offset) => widths.set(start + offset, doc.num(entry)));
      i += 2;
    } else {
      const end = doc.num(w[i + 1]);
      const value = doc.num(w[i + 2]);
      if (end >= start && end - start < 65536) {
        for (let cid = start; cid <= end; cid++) widths.set(cid, value);
      }
      i += 3;
    }
  }

  const toUnicode = (() => {
    const stream = doc.resolve(dict.get('ToUnicode'));
    return isStream(stream) ? parseToUnicode(doc.streamData(stream)).map : null;
  })();

  return {
    decode(bytes: Uint8Array): Glyph[] {
      const out: Glyph[] = [];
      for (let i = 0; i < bytes.length; i += 2) {
        const code = ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
        const width = widths.get(code);
        out.push({
          code,
          text: toUnicode?.get(code) ?? '',
          width: typeof width === 'number' && width > 0 ? width : defaultWidth,
          // Word spacing is defined not to apply to two-byte codes.
          isWordSpace: false,
        });
      }
      return out;
    },
  };
}

const NOT_A_FONT: PdfFont = {
  decode: (bytes) =>
    [...bytes].map((code) => ({
      code,
      text: code >= 32 && code < 127 ? String.fromCharCode(code) : '',
      width: 500,
      isWordSpace: code === 32,
    })),
};

/** Build a decoder for a font dictionary, caching per document run. */
export function loadFont(doc: PdfDocument, value: PdfObject | undefined): PdfFont {
  const dict = doc.dict(value);
  if (!dict) return NOT_A_FONT;
  return doc.name(dict.get('Subtype')) === 'Type0' ? compositeFont(doc, dict) : simpleFont(doc, dict);
}
