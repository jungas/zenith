/**
 * Content stream interpretation: the step that turns drawing instructions back
 * into lines of text.
 *
 * A PDF does not contain lines, paragraphs or table cells. It contains
 * instructions to place runs of glyphs at coordinates, in whatever order the
 * producer found convenient — a statement's amount column is frequently drawn
 * before the description beside it. Recovering the table means tracking the
 * text matrix well enough to know where each run *landed*, then grouping runs
 * by baseline and sorting them by x.
 */

import { Lexer, isKeyword, isName, isString } from './objects.ts';
import type { PdfKeyword, PdfObject } from './objects.ts';
import { loadFont } from './fonts.ts';
import type { PdfFont } from './fonts.ts';
import type { PdfDocument, PdfPage } from './document.ts';

/** One run of glyphs, positioned in page space. */
export interface TextItem {
  /** Left edge of the run, in PDF units from the page's left edge. */
  x: number;
  /** Right edge — where the pen ended up. */
  endX: number;
  /** Baseline, in PDF units from the page's bottom edge. */
  y: number;
  /** Effective font size after the text and transformation matrices. */
  size: number;
  text: string;
}

/** Runs sharing a baseline, joined into readable text. */
export interface TextLine {
  page: number;
  y: number;
  text: string;
  items: TextItem[];
  /**
   * Where each item's text starts in `text`, parallel to `items`. Recorded
   * while joining rather than searched for afterwards, so a caller can map a
   * position in the line back to the run — and therefore to its x coordinate —
   * exactly.
   */
  offsets: number[];
}

/** A 2×3 affine matrix [a b c d e f]. */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

interface TextState {
  font: PdfFont | null;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  /** Horizontal scaling, as a fraction rather than the percentage `Tz` takes. */
  scale: number;
  leading: number;
  rise: number;
}

function freshState(): TextState {
  return { font: null, size: 0, charSpacing: 0, wordSpacing: 0, scale: 1, leading: 0, rise: 0 };
}

/**
 * Run one page's content streams and collect every positioned run of text.
 *
 * Only the operators that move or draw text are implemented. Paths, colours,
 * shading and images are parsed as operands and dropped — they cannot affect
 * where a glyph lands.
 */
export interface PageItems {
  items: TextItem[];
  /**
   * Glyphs the content stream actually drew, decoded or not. Zero here means
   * the page never asked to paint text at all — the scanned-image case. A
   * positive count with no items means glyphs were drawn but every one of
   * them decoded to nothing, which is a font Zenith cannot read rather than
   * a page with nothing on it, and the two deserve different error messages.
   */
  glyphsDrawn: number;
}

export function extractPageItems(doc: PdfDocument, page: PdfPage): PageItems {
  const content = doc.pageContent(page);
  const items: TextItem[] = [];
  let glyphsDrawn = 0;
  const fontCache = new Map<string, PdfFont>();
  const fonts = doc.dict(page.resources?.get('Font'));
  const xObjects = doc.dict(page.resources?.get('XObject'));

  const lookupFont = (name: string): PdfFont => {
    const cached = fontCache.get(name);
    if (cached) return cached;
    const font = loadFont(doc, fonts?.get(name));
    fontCache.set(name, font);
    return font;
  };

  const run = (bytes: Uint8Array, initialCtm: Matrix, depth: number): void => {
    if (depth > 8) return; // form XObjects can nest; they should not recurse
    const lexer = new Lexer(bytes);
    const stack: Matrix[] = [];
    let ctm: Matrix = initialCtm;
    let textMatrix: Matrix = IDENTITY;
    let lineMatrix: Matrix = IDENTITY;
    let state = freshState();
    const stateStack: TextState[] = [];
    let operands: PdfObject[] = [];

    const numberAt = (index: number): number => {
      const value = operands[index];
      return typeof value === 'number' ? value : 0;
    };

    /** Draw a string at the current matrices, advancing the pen as it goes. */
    const show = (bytes_: Uint8Array): void => {
      const font = state.font;
      if (!font) return;
      const glyphs = font.decode(bytes_);
      glyphsDrawn += glyphs.length;
      const trm = multiply(
        [state.size * state.scale, 0, 0, state.size, 0, state.rise],
        multiply(textMatrix, ctm),
      );
      const startX = trm[4];
      const y = trm[5];
      // The rendered size is the text matrix's vertical scale, which is what
      // makes a heading cluster apart from body text.
      const size = Math.abs(state.size * Math.hypot(textMatrix[2], textMatrix[3])) ||
        Math.abs(state.size) || 1;

      let text = '';
      let advance = 0;
      for (const glyph of glyphs) {
        text += glyph.text;
        advance +=
          ((glyph.width / 1000) * state.size +
            state.charSpacing +
            (glyph.isWordSpace ? state.wordSpacing : 0)) *
          state.scale;
      }

      // The advance is in text space; scale it the way the matrices would.
      const horizontal = Math.hypot(textMatrix[0], textMatrix[1]) * Math.hypot(ctm[0], ctm[1]);
      if (text.trim()) {
        items.push({ x: startX, endX: startX + advance * horizontal, y, size, text });
      }
      textMatrix = multiply([1, 0, 0, 1, advance, 0], textMatrix);
    };

    for (;;) {
      const token = lexer.parseObject();
      if (token === undefined && lexer.atEnd()) break;
      if (token === undefined) continue;
      if (!isKeyword(token)) {
        operands.push(token as PdfObject);
        if (operands.length > 32) operands.shift();
        continue;
      }

      const op = (token as PdfKeyword).word;
      switch (op) {
        case 'q':
          stack.push(ctm);
          stateStack.push({ ...state });
          break;
        case 'Q':
          ctm = stack.pop() ?? ctm;
          state = stateStack.pop() ?? state;
          break;
        case 'cm':
          ctm = multiply(
            [numberAt(0), numberAt(1), numberAt(2), numberAt(3), numberAt(4), numberAt(5)],
            ctm,
          );
          break;
        case 'BT':
          textMatrix = IDENTITY;
          lineMatrix = IDENTITY;
          break;
        case 'ET':
          break;
        case 'Tf': {
          const name = operands[0];
          state.font = isName(name) ? lookupFont(name.name) : null;
          state.size = numberAt(1);
          break;
        }
        case 'Td':
          lineMatrix = multiply([1, 0, 0, 1, numberAt(0), numberAt(1)], lineMatrix);
          textMatrix = lineMatrix;
          break;
        case 'TD':
          state.leading = -numberAt(1);
          lineMatrix = multiply([1, 0, 0, 1, numberAt(0), numberAt(1)], lineMatrix);
          textMatrix = lineMatrix;
          break;
        case 'Tm':
          lineMatrix = [numberAt(0), numberAt(1), numberAt(2), numberAt(3), numberAt(4), numberAt(5)];
          textMatrix = lineMatrix;
          break;
        case 'T*':
          lineMatrix = multiply([1, 0, 0, 1, 0, -state.leading], lineMatrix);
          textMatrix = lineMatrix;
          break;
        case 'TL':
          state.leading = numberAt(0);
          break;
        case 'Tc':
          state.charSpacing = numberAt(0);
          break;
        case 'Tw':
          state.wordSpacing = numberAt(0);
          break;
        case 'Tz':
          state.scale = (numberAt(0) || 100) / 100;
          break;
        case 'Ts':
          state.rise = numberAt(0);
          break;
        case 'Tj': {
          const value = operands[0];
          if (isString(value)) show(value.bytes);
          break;
        }
        case "'": {
          lineMatrix = multiply([1, 0, 0, 1, 0, -state.leading], lineMatrix);
          textMatrix = lineMatrix;
          const value = operands[0];
          if (isString(value)) show(value.bytes);
          break;
        }
        case '"': {
          state.wordSpacing = numberAt(0);
          state.charSpacing = numberAt(1);
          lineMatrix = multiply([1, 0, 0, 1, 0, -state.leading], lineMatrix);
          textMatrix = lineMatrix;
          const value = operands[2];
          if (isString(value)) show(value.bytes);
          break;
        }
        case 'TJ': {
          const array = operands[0];
          if (Array.isArray(array)) {
            for (const element of array) {
              if (isString(element)) {
                show(element.bytes);
              } else if (typeof element === 'number') {
                // A negative number nudges the pen forward: this is how a
                // producer kerns, and how it fakes a space between columns.
                const shift = (-element / 1000) * state.size * state.scale;
                textMatrix = multiply([1, 0, 0, 1, shift, 0], textMatrix);
              }
            }
          }
          break;
        }
        case 'Do': {
          // A form XObject is a nested content stream sharing this state.
          const name = operands[0];
          const target = isName(name) ? doc.resolve(xObjects?.get(name.name)) : undefined;
          if (target && typeof target === 'object' && 'kind' in target && target.kind === 'stream') {
            if (doc.name(target.dict.get('Subtype')) === 'Form') {
              const matrix = doc.array(target.dict.get('Matrix')).map((entry) => doc.num(entry));
              const formMatrix: Matrix =
                matrix.length === 6
                  ? [matrix[0] ?? 1, matrix[1] ?? 0, matrix[2] ?? 0, matrix[3] ?? 1, matrix[4] ?? 0, matrix[5] ?? 0]
                  : IDENTITY;
              run(doc.streamData(target), multiply(formMatrix, ctm), depth + 1);
            }
          }
          break;
        }
        case 'BI':
          skipInlineImage(lexer);
          break;
        default:
          break;
      }
      operands = [];
    }
  };

  run(content, IDENTITY, 0);
  return { items, glyphsDrawn };
}

/**
 * Inline images embed raw bytes in the middle of a content stream, so the
 * lexer has to be walked past them by hand rather than tokenised through.
 */
function skipInlineImage(lexer: Lexer): void {
  const bytes = lexer.bytes;
  for (let i = lexer.pos; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0x45 || bytes[i + 1] !== 0x49) continue; // 'EI'
    const before = bytes[i - 1] ?? 0x20;
    const after = bytes[i + 2] ?? 0x20;
    const isBoundary = (byte: number): boolean =>
      byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x00;
    if (isBoundary(before) && isBoundary(after)) {
      lexer.pos = i + 2;
      return;
    }
  }
  lexer.pos = bytes.length;
}

/**
 * Group positioned runs into lines.
 *
 * Two runs belong to the same line when their baselines are within a fraction
 * of the text size — a tolerance rather than equality, because a producer will
 * shift a superscript or a differently-sized column by a fraction of a point
 * and still mean "the same row".
 */
export function itemsToLines(items: TextItem[], pageNumber: number): TextLine[] {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: TextLine[] = [];
  let bucket: TextItem[] = [];
  let bucketY = sorted[0]?.y ?? 0;

  const flush = (): void => {
    if (!bucket.length) return;
    const ordered = [...bucket].sort((a, b) => a.x - b.x);
    const joined = joinItems(ordered);
    lines.push({
      page: pageNumber,
      y: bucketY,
      text: joined.text,
      items: ordered,
      offsets: joined.offsets,
    });
    bucket = [];
  };

  for (const item of sorted) {
    const tolerance = Math.max(1.5, item.size * 0.4);
    if (bucket.length && Math.abs(item.y - bucketY) > tolerance) {
      flush();
      bucketY = item.y;
    } else if (!bucket.length) {
      bucketY = item.y;
    }
    bucket.push(item);
  }
  flush();

  return lines;
}

/**
 * Join a line's runs, inserting a space where the gap between them is wide
 * enough to be one. Column gaps become a single space rather than a run of
 * them: the statement parser reads structure from the runs' own coordinates,
 * which survive intact, rather than from counted whitespace, which does not.
 */
function joinItems(items: TextItem[]): { text: string; offsets: number[] } {
  let text = '';
  const offsets: number[] = [];
  let previousEnd: number | null = null;
  for (const item of items) {
    if (previousEnd !== null) {
      const gap = item.x - previousEnd;
      const needsSpace = gap > item.size * 0.18;
      if (needsSpace && !/\s$/.test(text) && !/^\s/.test(item.text)) text += ' ';
    }
    offsets.push(text.length);
    text += item.text;
    previousEnd = item.endX;
  }
  // Trimming the ends would shift every offset, so leading and trailing space
  // is prevented above rather than removed here.
  return { text, offsets };
}
