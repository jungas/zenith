/**
 * Stream filters. A PDF stream declares a chain of them in `/Filter`, and the
 * bytes have to come back through that chain in order before anything can read
 * them.
 *
 * Image filters (DCT, JPX, JBIG2, CCITT) are deliberately not decoded: this
 * parser only reads text, and a statement's logo is not text.
 */

import { inflate } from './inflate.ts';

/** Filters whose output we have no use for; they decode to nothing. */
const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode', 'CCF']);

/** `/DecodeParms`, with the defaults the specification gives each entry. */
export interface DecodeParams {
  predictor: number;
  colors: number;
  bitsPerComponent: number;
  columns: number;
  /** LZW only: whether the code width grows one code early. */
  earlyChange: number;
}

export function applyFilter(
  name: string,
  data: Uint8Array,
  params: DecodeParams | null,
): Uint8Array {
  switch (name) {
    case 'FlateDecode':
    case 'Fl':
      return undoPredictor(inflate(data), params);
    case 'LZWDecode':
    case 'LZW':
      return undoPredictor(lzwDecode(data, params?.earlyChange ?? 1), params);
    case 'ASCIIHexDecode':
    case 'AHx':
      return asciiHexDecode(data);
    case 'ASCII85Decode':
    case 'A85':
      return ascii85Decode(data);
    case 'RunLengthDecode':
    case 'RL':
      return runLengthDecode(data);
    case 'Crypt':
      return data;
    default:
      return IMAGE_FILTERS.has(name) ? new Uint8Array(0) : data;
  }
}

function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let digits = '';
  for (const byte of data) {
    if (byte === 0x3e) break;
    const char = String.fromCharCode(byte);
    if (!/[0-9a-fA-F]/.test(char)) continue;
    digits += char;
    if (digits.length === 2) {
      out.push(Number.parseInt(digits, 16));
      digits = '';
    }
  }
  if (digits) out.push(Number.parseInt(`${digits}0`, 16));
  return Uint8Array.from(out);
}

function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let tuple: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] ?? 0;
    if (byte === 0x7e) break; // '~' begins the end marker
    if (byte === 0x7a && tuple.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (byte < 0x21 || byte > 0x75) continue;
    tuple.push(byte - 0x21);
    if (tuple.length === 5) {
      let value = 0;
      for (const digit of tuple) value = value * 85 + digit;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      tuple = [];
    }
  }
  if (tuple.length > 1) {
    const count = tuple.length;
    while (tuple.length < 5) tuple.push(84);
    let value = 0;
    for (const digit of tuple) value = value * 85 + digit;
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...bytes.slice(0, count - 1));
  }
  return Uint8Array.from(out);
}

function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const length = data[i++] ?? 128;
    if (length === 128) break;
    if (length < 128) {
      for (let n = 0; n <= length; n++) out.push(data[i++] ?? 0);
    } else {
      const byte = data[i++] ?? 0;
      for (let n = 0; n < 257 - length; n++) out.push(byte);
    }
  }
  return Uint8Array.from(out);
}

/**
 * LZW as PDF uses it: 8-bit input, codes growing from 9 to 12 bits, with an
 * `earlyChange` of 1 by default (the code width grows one code sooner than a
 * strict reading of the algorithm would).
 */
function lzwDecode(data: Uint8Array, earlyChange: number): Uint8Array {
  const out: number[] = [];
  const dictionary: number[][] = [];
  const reset = (): void => {
    dictionary.length = 0;
    for (let i = 0; i < 256; i++) dictionary.push([i]);
    dictionary.push([], []); // 256 = clear, 257 = end of data
  };
  reset();

  let codeWidth = 9;
  let previous: number[] | null = null;
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i <= data.length; i++) {
    if (i < data.length) {
      buffer = (buffer << 8) | (data[i] ?? 0);
      bits += 8;
    } else if (bits < codeWidth) {
      break;
    }
    while (bits >= codeWidth) {
      const code = (buffer >> (bits - codeWidth)) & ((1 << codeWidth) - 1);
      bits -= codeWidth;
      if (code === 256) {
        reset();
        codeWidth = 9;
        previous = null;
        continue;
      }
      if (code === 257) return Uint8Array.from(out);

      let entry: number[];
      if (code < dictionary.length) {
        entry = dictionary[code] ?? [];
        if (previous) dictionary.push([...previous, entry[0] ?? 0]);
      } else if (previous) {
        entry = [...previous, previous[0] ?? 0];
        dictionary.push(entry);
      } else {
        return Uint8Array.from(out);
      }
      out.push(...entry);
      previous = entry;

      if (dictionary.length + earlyChange >= 1 << codeWidth && codeWidth < 12) codeWidth++;
    }
  }
  return Uint8Array.from(out);
}

/**
 * Undo a PNG or TIFF predictor. Predictors make a stream compress better by
 * storing each row as a delta from the one above; cross-reference streams
 * always use one.
 */
function undoPredictor(data: Uint8Array, params: DecodeParams | null): Uint8Array {
  const predictor = params?.predictor ?? 1;
  if (predictor <= 1) return data;

  const colors = Math.max(1, params?.colors ?? 1);
  const bpc = Math.max(1, params?.bitsPerComponent ?? 8);
  const columns = Math.max(1, params?.columns ?? 1);
  const pixelBytes = Math.ceil((colors * bpc) / 8);
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);

  if (predictor === 2) {
    // TIFF predictor: horizontal differencing. Only the 8-bit case is defined
    // in a way that matters here.
    if (bpc !== 8) return data;
    const out = new Uint8Array(data);
    for (let row = 0; row + rowBytes <= out.length; row += rowBytes) {
      for (let i = pixelBytes; i < rowBytes; i++) {
        out[row + i] = ((out[row + i] ?? 0) + (out[row + i - pixelBytes] ?? 0)) & 0xff;
      }
    }
    return out;
  }

  // PNG predictors: each row is prefixed with a filter-type byte.
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  let previousRow = new Uint8Array(rowBytes);
  for (let row = 0; row < rows; row++) {
    const type = data[row * (rowBytes + 1)] ?? 0;
    const source = data.subarray(row * (rowBytes + 1) + 1, (row + 1) * (rowBytes + 1));
    const current = new Uint8Array(rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const raw = source[i] ?? 0;
      const left = i >= pixelBytes ? current[i - pixelBytes] ?? 0 : 0;
      const up = previousRow[i] ?? 0;
      const upLeft = i >= pixelBytes ? previousRow[i - pixelBytes] ?? 0 : 0;
      switch (type) {
        case 0: current[i] = raw; break;
        case 1: current[i] = (raw + left) & 0xff; break;
        case 2: current[i] = (raw + up) & 0xff; break;
        case 3: current[i] = (raw + ((left + up) >> 1)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const best = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          current[i] = (raw + best) & 0xff;
          break;
        }
        default: current[i] = raw;
      }
    }
    out.set(current, row * rowBytes);
    previousRow = current;
  }
  return out;
}
