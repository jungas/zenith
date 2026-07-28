/**
 * The PDF object layer: eight value types and the lexer that reads them.
 *
 * A PDF is a graph of numbered objects built from booleans, numbers, strings,
 * names, arrays, dictionaries, streams and references to other objects. Every
 * higher layer — the page tree, fonts, content streams — is just those types
 * arranged differently.
 */

export interface PdfName {
  kind: 'name';
  name: string;
}

export interface PdfRef {
  kind: 'ref';
  num: number;
  gen: number;
}

/** Strings are bytes: their text encoding depends on where they are used. */
export interface PdfString {
  kind: 'string';
  bytes: Uint8Array;
}

export interface PdfStream {
  kind: 'stream';
  dict: PdfDict;
  /** Still filtered and, in an encrypted file, still encrypted. */
  raw: Uint8Array;
  num: number;
  gen: number;
}

export type PdfDict = Map<string, PdfObject>;

export type PdfObject =
  | null
  | boolean
  | number
  | PdfName
  | PdfString
  | PdfObject[]
  | PdfDict
  | PdfStream
  | PdfRef;

export const isName = (value: PdfObject | undefined, name?: string): value is PdfName =>
  typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'name' &&
  (name === undefined || value.name === name);

export const isRef = (value: PdfObject | undefined): value is PdfRef =>
  typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'ref';

export const isString = (value: PdfObject | undefined): value is PdfString =>
  typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'string';

export const isStream = (value: PdfObject | undefined): value is PdfStream =>
  typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'stream';

export const isDict = (value: PdfObject | undefined): value is PdfDict => value instanceof Map;

export const isArray = (value: PdfObject | undefined): value is PdfObject[] => Array.isArray(value);

const SPACE = 0x20;
const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, SPACE]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

export const isWhitespace = (byte: number): boolean => WHITESPACE.has(byte);
export const isDelimiter = (byte: number): boolean => DELIMITERS.has(byte);
const isRegular = (byte: number): boolean => !WHITESPACE.has(byte) && !DELIMITERS.has(byte);

/** A bare keyword such as `obj`, `stream` or a content-stream operator. */
export interface PdfKeyword {
  kind: 'keyword';
  word: string;
}

export const isKeyword = (value: unknown, word?: string): value is PdfKeyword =>
  typeof value === 'object' && value !== null && 'kind' in value &&
  (value as PdfKeyword).kind === 'keyword' &&
  (word === undefined || (value as PdfKeyword).word === word);

/**
 * A cursor over PDF bytes.
 *
 * `parseObject` returns `undefined` at a closing bracket or end of input, which
 * is how the array and dictionary readers know they are done.
 */
export class Lexer {
  bytes: Uint8Array;
  pos: number;

  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }

  atEnd(): boolean {
    return this.pos >= this.bytes.length;
  }

  peek(offset = 0): number {
    return this.bytes[this.pos + offset] ?? -1;
  }

  /** Whitespace and `%` comments, which are legal anywhere a token may start. */
  skipWhitespace(): void {
    while (this.pos < this.bytes.length) {
      const byte = this.bytes[this.pos] ?? 0;
      if (WHITESPACE.has(byte)) {
        this.pos++;
      } else if (byte === 0x25) {
        while (this.pos < this.bytes.length) {
          const next = this.bytes[this.pos] ?? 0;
          if (next === 0x0a || next === 0x0d) break;
          this.pos++;
        }
      } else {
        return;
      }
    }
  }

  readKeyword(): string {
    let word = '';
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos] ?? 0)) {
      word += String.fromCharCode(this.bytes[this.pos] ?? 0);
      this.pos++;
    }
    return word;
  }

  /**
   * Read the next value. Keywords other than `true`/`false`/`null` come back as
   * `PdfKeyword` so content streams can pick their operators out of the stream.
   */
  parseObject(): PdfObject | PdfKeyword | undefined {
    this.skipWhitespace();
    if (this.atEnd()) return undefined;
    const byte = this.peek();

    if (byte === 0x2f) return this.readName();
    if (byte === 0x28) return this.readLiteralString();
    if (byte === 0x5b) {
      this.pos++;
      return this.readArray();
    }
    if (byte === 0x3c) {
      if (this.peek(1) === 0x3c) {
        this.pos += 2;
        return this.readDict();
      }
      return this.readHexString();
    }
    // Closing brackets end the enclosing collection.
    if (byte === 0x5d || byte === 0x3e || byte === 0x29 || byte === 0x7d) {
      this.pos++;
      if (byte === 0x3e && this.peek() === 0x3e) this.pos++;
      return undefined;
    }
    if (byte === 0x7b) {
      this.pos++;
      return this.parseObject();
    }
    if ((byte >= 0x30 && byte <= 0x39) || byte === 0x2b || byte === 0x2d || byte === 0x2e) {
      return this.readNumberOrRef();
    }

    const word = this.readKeyword();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (!word) {
      // An unexpected delimiter: step over it rather than spinning forever.
      this.pos++;
      return this.parseObject();
    }
    return { kind: 'keyword', word };
  }

  private readName(): PdfName {
    this.pos++;
    let name = '';
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos] ?? 0)) {
      const byte = this.bytes[this.pos] ?? 0;
      if (byte === 0x23 && this.pos + 2 < this.bytes.length) {
        const hex = String.fromCharCode(this.bytes[this.pos + 1] ?? 0, this.bytes[this.pos + 2] ?? 0);
        const value = Number.parseInt(hex, 16);
        if (Number.isFinite(value)) {
          name += String.fromCharCode(value);
          this.pos += 3;
          continue;
        }
      }
      name += String.fromCharCode(byte);
      this.pos++;
    }
    return { kind: 'name', name };
  }

  private readLiteralString(): PdfString {
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.bytes.length) {
      let byte = this.bytes[this.pos++] ?? 0;
      if (byte === 0x5c) {
        byte = this.bytes[this.pos++] ?? 0;
        switch (byte) {
          case 0x6e: out.push(0x0a); break;
          case 0x72: out.push(0x0d); break;
          case 0x74: out.push(0x09); break;
          case 0x62: out.push(0x08); break;
          case 0x66: out.push(0x0c); break;
          case 0x0a: break; // line continuation
          case 0x0d:
            if (this.peek() === 0x0a) this.pos++;
            break;
          default:
            if (byte >= 0x30 && byte <= 0x37) {
              let code = byte - 0x30;
              for (let i = 0; i < 2; i++) {
                const next = this.peek();
                if (next < 0x30 || next > 0x37) break;
                code = code * 8 + (next - 0x30);
                this.pos++;
              }
              out.push(code & 0xff);
            } else {
              out.push(byte);
            }
        }
        continue;
      }
      if (byte === 0x28) depth++;
      else if (byte === 0x29 && --depth === 0) break;
      out.push(byte);
    }
    return { kind: 'string', bytes: Uint8Array.from(out) };
  }

  private readHexString(): PdfString {
    this.pos++;
    const out: number[] = [];
    let digits = '';
    while (this.pos < this.bytes.length) {
      const byte = this.bytes[this.pos++] ?? 0;
      if (byte === 0x3e) break;
      const char = String.fromCharCode(byte);
      if (/[0-9a-fA-F]/.test(char)) {
        digits += char;
        if (digits.length === 2) {
          out.push(Number.parseInt(digits, 16));
          digits = '';
        }
      }
    }
    // An odd trailing digit is padded with zero, per the specification.
    if (digits) out.push(Number.parseInt(`${digits}0`, 16));
    return { kind: 'string', bytes: Uint8Array.from(out) };
  }

  private readArray(): PdfObject[] {
    const out: PdfObject[] = [];
    for (;;) {
      const value = this.parseObject();
      if (value === undefined) break;
      if (isKeyword(value)) continue; // stray junk inside an array
      out.push(value);
      if (this.atEnd()) break;
    }
    return out;
  }

  private readDict(): PdfDict {
    const dict: PdfDict = new Map();
    for (;;) {
      this.skipWhitespace();
      if (this.atEnd()) break;
      if (this.peek() === 0x3e && this.peek(1) === 0x3e) {
        this.pos += 2;
        break;
      }
      const key = this.parseObject();
      if (key === undefined) break;
      if (!isName(key as PdfObject)) continue; // a malformed key: skip its value too
      const value = this.parseObject();
      if (value === undefined) break;
      if (isKeyword(value)) continue;
      dict.set((key as PdfName).name, value);
    }
    return dict;
  }

  private readNumber(): number {
    const start = this.pos;
    if (this.peek() === 0x2b || this.peek() === 0x2d) this.pos++;
    while (this.pos < this.bytes.length) {
      const byte = this.bytes[this.pos] ?? 0;
      if ((byte >= 0x30 && byte <= 0x39) || byte === 0x2e || byte === 0x2d || byte === 0x2b) this.pos++;
      else break;
    }
    let text = '';
    for (let i = start; i < this.pos; i++) text += String.fromCharCode(this.bytes[i] ?? 0);
    const value = Number.parseFloat(text);
    return Number.isFinite(value) ? value : 0;
  }

  /** `12 0 R` is a reference; a bare `12` is a number. Only lookahead tells them apart. */
  private readNumberOrRef(): number | PdfRef {
    const value = this.readNumber();
    if (!Number.isInteger(value) || value < 0) return value;
    const save = this.pos;
    this.skipWhitespace();
    const byte = this.peek();
    if (byte >= 0x30 && byte <= 0x39) {
      const gen = this.readNumber();
      if (Number.isInteger(gen) && gen >= 0) {
        this.skipWhitespace();
        if (this.peek() === 0x52 && !isRegular(this.peek(1))) {
          this.pos++;
          return { kind: 'ref', num: value, gen };
        }
      }
    }
    this.pos = save;
    return value;
  }
}

/** Find every occurrence of an ASCII marker in a byte range. */
export function findAll(bytes: Uint8Array, marker: string, from = 0): number[] {
  const needle = new Uint8Array(marker.length);
  for (let i = 0; i < marker.length; i++) needle[i] = marker.charCodeAt(i);
  const hits: number[] = [];
  outer: for (let i = from; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    hits.push(i);
  }
  return hits;
}

/** ASCII text of a byte range, for keyword sniffing. */
export function asciiAt(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  const end = Math.min(bytes.length, start + length);
  for (let i = Math.max(0, start); i < end; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}
