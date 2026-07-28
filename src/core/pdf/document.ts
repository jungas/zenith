/**
 * A readable document assembled out of raw PDF bytes.
 *
 * Objects are found by **scanning** for `N G obj` from the start of the file
 * rather than by following the cross-reference table. That is unusual, and
 * deliberate: statements arrive as whatever a bank's reporting system emitted,
 * and a broken or absent xref is the single most common way a PDF resists being
 * read. A sequential scan does not care — it also handles incremental updates
 * correctly, because a later definition of an object number simply overwrites
 * the earlier one, which is exactly what an update means.
 *
 * Objects packed inside `/ObjStm` object streams are expanded afterwards, since
 * reaching them needs the decryption key that the scan itself provides.
 */

import {
  Lexer, asciiAt, findAll, isArray, isDict, isKeyword, isName, isRef, isStream, isString,
} from './objects.ts';
import type { PdfDict, PdfObject, PdfRef, PdfStream } from './objects.ts';
import { applyFilter } from './filters.ts';
import type { DecodeParams } from './filters.ts';
import { createDecryptor, PdfPasswordError } from './security.ts';
import type { Cipher, Decryptor, EncryptionDict } from './security.ts';

export { PdfPasswordError };

export interface PdfPage {
  dict: PdfDict;
  resources: PdfDict | null;
  /** [x0, y0, x1, y1] in PDF units. */
  mediaBox: [number, number, number, number];
  rotate: number;
}

const isDigit = (byte: number): boolean => byte >= 0x30 && byte <= 0x39;
const isWs = (byte: number): boolean =>
  byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x00 || byte === 0x0c;

/** How many pages we will read before deciding the page tree is a loop. */
const PAGE_LIMIT = 500;

export class PdfDocument {
  readonly bytes: Uint8Array;
  readonly trailer: PdfDict = new Map();
  readonly encrypted: boolean;
  /** Which password opened it, once it is open. */
  readonly openedWith: 'user' | 'owner' | 'empty' | 'none';

  private objects = new Map<number, PdfObject>();
  private generations = new Map<number, number>();
  private decryptor: Decryptor | null = null;
  private streamCache = new WeakMap<PdfStream, Uint8Array>();
  private endstreamHits: number[] | null = null;

  constructor(bytes: Uint8Array, password = '') {
    this.bytes = bytes;
    this.scanObjects();
    this.collectTrailer();

    const encryptDict = this.dict(this.trailer.get('Encrypt'));
    this.encrypted = Boolean(encryptDict);
    if (encryptDict) {
      this.decryptor = createDecryptor(this.readEncryptionDict(encryptDict), this.firstFileId(), password);
      this.openedWith = this.decryptor.openedWith;
    } else {
      this.openedWith = 'none';
    }

    this.expandObjectStreams();
  }

  /* ── Object access ──────────────────────────────────────────────────── */

  /** Follow references until a direct value falls out. */
  resolve(value: PdfObject | undefined, depth = 0): PdfObject | undefined {
    if (!isRef(value) || depth > 32) return value;
    const target = this.objects.get((value as PdfRef).num);
    return this.resolve(target, depth + 1);
  }

  /** A dictionary entry, resolved. Streams answer to their own dictionary. */
  get(dict: PdfDict | null | undefined, key: string): PdfObject | undefined {
    if (!dict) return undefined;
    return this.resolve(dict.get(key));
  }

  dict(value: PdfObject | undefined): PdfDict | null {
    const resolved = this.resolve(value);
    if (isDict(resolved)) return resolved;
    if (isStream(resolved)) return resolved.dict;
    return null;
  }

  num(value: PdfObject | undefined, fallback = 0): number {
    const resolved = this.resolve(value);
    return typeof resolved === 'number' ? resolved : fallback;
  }

  name(value: PdfObject | undefined): string | null {
    const resolved = this.resolve(value);
    return isName(resolved) ? resolved.name : null;
  }

  array(value: PdfObject | undefined): PdfObject[] {
    const resolved = this.resolve(value);
    if (isArray(resolved)) return resolved;
    return resolved === undefined ? [] : [resolved];
  }

  /** Decrypted and fully un-filtered stream bytes. */
  streamData(stream: PdfStream): Uint8Array {
    const cached = this.streamCache.get(stream);
    if (cached) return cached;

    let data = stream.raw;
    // Cross-reference streams are never encrypted — they have to be readable
    // before the key is known.
    if (this.decryptor && this.name(stream.dict.get('Type')) !== 'XRef') {
      data = this.decryptor.decryptStream(data, stream.num, stream.gen);
    }

    const filters = this.array(stream.dict.get('Filter'));
    const parms = this.array(stream.dict.get('DecodeParms') ?? stream.dict.get('DP'));
    for (const [index, filter] of filters.entries()) {
      const filterName = this.name(filter);
      if (!filterName) continue;
      data = applyFilter(filterName, data, this.decodeParams(parms[index]));
    }

    this.streamCache.set(stream, data);
    return data;
  }

  private decodeParams(value: PdfObject | undefined): DecodeParams | null {
    const dict = this.dict(value);
    if (!dict) return null;
    return {
      predictor: this.num(dict.get('Predictor'), 1),
      colors: this.num(dict.get('Colors'), 1),
      bitsPerComponent: this.num(dict.get('BitsPerComponent'), 8),
      columns: this.num(dict.get('Columns'), 1),
      earlyChange: this.num(dict.get('EarlyChange'), 1),
    };
  }

  /* ── Pages ──────────────────────────────────────────────────────────── */

  pages(): PdfPage[] {
    const catalog = this.catalog();
    const root = this.dict(catalog?.get('Pages'));
    const pages: PdfPage[] = [];

    if (root) {
      const seen = new Set<PdfDict>();
      const walk = (node: PdfDict, inherited: Partial<PdfPage>): void => {
        if (pages.length >= PAGE_LIMIT || seen.has(node)) return;
        seen.add(node);
        const own: Partial<PdfPage> = {
          resources: this.dict(node.get('Resources')) ?? inherited.resources ?? null,
          mediaBox: this.readBox(node.get('MediaBox')) ?? inherited.mediaBox,
          rotate: node.has('Rotate') ? this.num(node.get('Rotate')) : inherited.rotate,
        };
        const kids = this.get(node, 'Kids');
        if (isArray(kids)) {
          for (const kid of kids) {
            const kidDict = this.dict(kid);
            if (kidDict) walk(kidDict, own);
          }
          return;
        }
        pages.push({
          dict: node,
          resources: own.resources ?? null,
          mediaBox: own.mediaBox ?? [0, 0, 612, 792],
          rotate: own.rotate ?? 0,
        });
      };
      walk(root, {});
    }

    // No usable page tree: fall back to every object that calls itself a page.
    if (!pages.length) {
      for (const num of [...this.objects.keys()].sort((a, b) => a - b)) {
        const value = this.objects.get(num);
        if (!isDict(value) || this.name(value.get('Type')) !== 'Page') continue;
        pages.push({
          dict: value,
          resources: this.dict(value.get('Resources')),
          mediaBox: this.readBox(value.get('MediaBox')) ?? [0, 0, 612, 792],
          rotate: this.num(value.get('Rotate')),
        });
        if (pages.length >= PAGE_LIMIT) break;
      }
    }

    return pages;
  }

  /** A page's content streams, concatenated as the specification requires. */
  pageContent(page: PdfPage): Uint8Array {
    const contents = this.resolve(page.dict.get('Contents'));
    const streams: PdfStream[] = [];
    if (isStream(contents)) streams.push(contents);
    else if (isArray(contents)) {
      for (const part of contents) {
        const resolved = this.resolve(part);
        if (isStream(resolved)) streams.push(resolved);
      }
    }
    const chunks = streams.map((stream) => this.streamData(stream));
    const total = chunks.reduce((sum, chunk) => sum + chunk.length + 1, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
      out[offset++] = 0x0a; // a newline between streams, so tokens cannot merge
    }
    return out;
  }

  private catalog(): PdfDict | null {
    const root = this.dict(this.trailer.get('Root'));
    if (root?.has('Pages')) return root;
    for (const value of this.objects.values()) {
      if (isDict(value) && this.name(value.get('Type')) === 'Catalog') return value;
    }
    return root;
  }

  private readBox(value: PdfObject | undefined): [number, number, number, number] | undefined {
    const box = this.resolve(value);
    if (!isArray(box) || box.length < 4) return undefined;
    const [x0, y0, x1, y1] = box.map((entry) => this.num(entry));
    return [x0 ?? 0, y0 ?? 0, x1 ?? 612, y1 ?? 792];
  }

  /* ── Scanning ───────────────────────────────────────────────────────── */

  private scanObjects(): void {
    const bytes = this.bytes;
    let skipUntil = 0;

    for (const hit of findAll(bytes, 'obj')) {
      if (hit < skipUntil) continue;
      const after = bytes[hit + 3] ?? 0x20;
      if (!isWs(after) && after !== 0x3c && after !== 0x5b && after !== 0x2f) continue;

      // Walk backwards over "<num> <gen> " to name the object.
      let i = hit - 1;
      while (i >= 0 && isWs(bytes[i] ?? 0)) i--;
      const genEnd = i + 1;
      while (i >= 0 && isDigit(bytes[i] ?? 0)) i--;
      const genStart = i + 1;
      if (genStart === genEnd) continue;
      if (i < 0 || !isWs(bytes[i] ?? 0)) continue;
      while (i >= 0 && isWs(bytes[i] ?? 0)) i--;
      const numEnd = i + 1;
      while (i >= 0 && isDigit(bytes[i] ?? 0)) i--;
      const numStart = i + 1;
      if (numStart === numEnd) continue;

      const num = Number.parseInt(asciiAt(bytes, numStart, numEnd - numStart), 10);
      const gen = Number.parseInt(asciiAt(bytes, genStart, genEnd - genStart), 10);
      if (!Number.isFinite(num) || !Number.isFinite(gen)) continue;

      const parsed = this.parseIndirectObject(hit + 3, num, gen);
      if (!parsed) continue;
      this.objects.set(num, parsed.value);
      this.generations.set(num, gen);
      if (parsed.skipTo > skipUntil) skipUntil = parsed.skipTo;
    }
  }

  private parseIndirectObject(
    start: number,
    num: number,
    gen: number,
  ): { value: PdfObject; skipTo: number } | null {
    const lexer = new Lexer(this.bytes, start);
    const value = lexer.parseObject();
    if (value === undefined || isKeyword(value)) return null;

    if (!isDict(value)) return { value, skipTo: lexer.pos };

    lexer.skipWhitespace();
    if (asciiAt(this.bytes, lexer.pos, 6) !== 'stream') return { value, skipTo: lexer.pos };

    let dataStart = lexer.pos + 6;
    if (this.bytes[dataStart] === 0x0d) dataStart++;
    if (this.bytes[dataStart] === 0x0a) dataStart++;

    const end = this.findStreamEnd(dataStart, value);
    const stream: PdfStream = {
      kind: 'stream',
      dict: value,
      raw: this.bytes.subarray(dataStart, end),
      num,
      gen,
    };
    return { value: stream, skipTo: end };
  }

  /**
   * Where a stream's data stops.
   *
   * `/Length` is authoritative when it is a direct number that lands on an
   * `endstream`, but it is very often an indirect reference to an object that
   * has not been scanned yet — and sometimes it is simply wrong. Both cases fall
   * back to finding the next `endstream`, which is what every reader does.
   */
  private findStreamEnd(dataStart: number, dict: PdfDict): number {
    const declared = dict.get('Length');
    if (typeof declared === 'number' && declared >= 0 && dataStart + declared <= this.bytes.length) {
      const candidate = dataStart + declared;
      if (/^\s*endstream/.test(asciiAt(this.bytes, candidate, 12))) return candidate;
    }

    if (!this.endstreamHits) this.endstreamHits = findAll(this.bytes, 'endstream');
    const next = this.endstreamHits.find((position) => position >= dataStart);
    let end = next ?? this.bytes.length;
    // The EOL introducing `endstream` is not part of the data.
    if (this.bytes[end - 1] === 0x0a) end--;
    if (this.bytes[end - 1] === 0x0d) end--;
    return Math.max(dataStart, end);
  }

  /**
   * Merge every trailer in the file. Later ones win, which matches how an
   * incrementally updated PDF is meant to be read. Cross-reference streams
   * carry the same keys in their own dictionary, so they count as trailers too.
   */
  private collectTrailer(): void {
    const merge = (dict: PdfDict | null): void => {
      if (!dict) return;
      for (const key of ['Root', 'Encrypt', 'ID', 'Info'] as const) {
        const value = dict.get(key);
        if (value !== undefined) this.trailer.set(key, value);
      }
    };

    for (const hit of findAll(this.bytes, 'trailer')) {
      const lexer = new Lexer(this.bytes, hit + 7);
      const value = lexer.parseObject();
      if (isDict(value as PdfObject)) merge(value as PdfDict);
    }
    for (const value of this.objects.values()) {
      if (isStream(value) && this.name(value.dict.get('Type')) === 'XRef') merge(value.dict);
    }
  }

  private firstFileId(): Uint8Array {
    const id = this.resolve(this.trailer.get('ID'));
    const first = isArray(id) ? this.resolve(id[0]) : undefined;
    return isString(first) ? first.bytes : new Uint8Array(0);
  }

  private readEncryptionDict(dict: PdfDict): EncryptionDict {
    const string = (key: string): Uint8Array => {
      const value = this.resolve(dict.get(key));
      return isString(value) ? value.bytes : new Uint8Array(0);
    };
    const v = this.num(dict.get('V'), 0);
    const r = this.num(dict.get('R'), v >= 5 ? 6 : 2);

    let length = this.num(dict.get('Length'), 40);
    let streamCipher: Cipher = v >= 5 ? 'aes256' : 'rc4';
    let stringCipher: Cipher = streamCipher;

    if (v === 4 || v === 5) {
      const cf = this.dict(dict.get('CF'));
      const pick = (which: 'StmF' | 'StrF'): Cipher => {
        const filterName = this.name(dict.get(which)) ?? 'Identity';
        if (filterName === 'Identity') return 'none';
        const entry = this.dict(cf?.get(filterName));
        const method = this.name(entry?.get('CFM')) ?? 'None';
        // A crypt filter states its length in bytes; the encryption dictionary
        // states it in bits. Small numbers are therefore bytes.
        const entryLength = this.num(entry?.get('Length'), 0);
        if (entryLength) length = entryLength <= 40 ? entryLength * 8 : entryLength;
        if (method === 'AESV2') return 'aes128';
        if (method === 'AESV3') return 'aes256';
        if (method === 'V2') return 'rc4';
        return 'none';
      };
      streamCipher = pick('StmF');
      stringCipher = pick('StrF');
    }

    if (streamCipher === 'aes128') length = 128;
    if (streamCipher === 'aes256' || v >= 5) length = 256;

    return {
      filter: this.name(dict.get('Filter')) ?? 'Standard',
      v,
      r,
      length,
      o: string('O'),
      u: string('U'),
      oe: string('OE'),
      ue: string('UE'),
      p: this.num(dict.get('P'), -1),
      encryptMetadata: this.resolve(dict.get('EncryptMetadata')) !== false,
      streamCipher,
      stringCipher,
    };
  }

  /**
   * Unpack `/ObjStm` streams. Objects inside one are not encrypted individually
   * — the container already was — so they are simply parsed out of the decoded
   * bytes.
   */
  private expandObjectStreams(): void {
    const containers = [...this.objects.values()].filter(
      (value): value is PdfStream => isStream(value) && this.name(value.dict.get('Type')) === 'ObjStm',
    );

    for (const container of containers) {
      let data: Uint8Array;
      try {
        data = this.streamData(container);
      } catch {
        continue; // one unreadable container should not lose the whole document
      }
      const count = this.num(container.dict.get('N'));
      const first = this.num(container.dict.get('First'));
      if (!count || !first) continue;

      const header = new Lexer(data.subarray(0, first));
      const entries: Array<{ num: number; offset: number }> = [];
      for (let i = 0; i < count; i++) {
        const num = header.parseObject();
        const offset = header.parseObject();
        if (typeof num !== 'number' || typeof offset !== 'number') break;
        entries.push({ num, offset });
      }

      for (const entry of entries) {
        // A top-level definition of the same number is newer than the container.
        if (this.objects.has(entry.num)) continue;
        const lexer = new Lexer(data, first + entry.offset);
        const value = lexer.parseObject();
        if (value === undefined || isKeyword(value)) continue;
        this.objects.set(entry.num, value);
        this.generations.set(entry.num, 0);
      }
    }
  }
}

/**
 * Is this file encrypted? Answered without a password, so the UI can ask for
 * one before trying to open anything.
 */
export function pdfIsEncrypted(bytes: Uint8Array): boolean {
  for (const hit of findAll(bytes, 'trailer')) {
    const lexer = new Lexer(bytes, hit + 7);
    const value = lexer.parseObject();
    if (isDict(value as PdfObject) && (value as PdfDict).has('Encrypt')) return true;
  }
  // Cross-reference streams keep `/Encrypt` in the stream dictionary instead.
  return findAll(bytes, '/Encrypt').length > 0;
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  return asciiAt(bytes, 0, 1024).includes('%PDF-');
}
