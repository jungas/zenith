/**
 * DEFLATE (RFC 1951) and zlib (RFC 1950) decoding.
 *
 * Nearly every PDF stream is FlateDecode, so reading one means inflating it.
 * The browser has `DecompressionStream`, but it is asynchronous and would push
 * that asynchrony through the whole parser; this is synchronous, which keeps
 * `core/` pure and directly testable under `node --test`.
 */

/** Extra bits and base values for the length codes 257–285. */
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
];
/** Code-length codes arrive in this order, not in numeric order. */
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman table: how many codes of each length, and the symbols. */
interface Huffman {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function buildHuffman(lengths: ArrayLike<number>): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i] ?? 0]++;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let len = 1; len < 16; len++) {
    offsets[len] = (offsets[len - 1] ?? 0) + (counts[len - 1] ?? 0);
  }
  const symbols = new Uint16Array(lengths.length);
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const len = lengths[symbol] ?? 0;
    if (len) symbols[offsets[len]++] = symbol;
  }
  return { counts, symbols };
}

const FIXED_LITERALS = buildHuffman(
  Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)),
);
const FIXED_DISTANCES = buildHuffman(new Uint8Array(30).fill(5));

export class InflateError extends Error {}

/**
 * Inflate a raw DEFLATE stream.
 *
 * PDF producers truncate streams more often than you would hope, so a stream
 * that runs out mid-block returns what was decoded rather than throwing: half a
 * page of text beats none.
 */
export function inflateRaw(input: Uint8Array): Uint8Array {
  let out = new Uint8Array(Math.max(1024, input.length * 4));
  let outLength = 0;
  let pos = 0;
  let bitBuffer = 0;
  let bitCount = 0;

  const grow = (needed: number): void => {
    if (outLength + needed <= out.length) return;
    let size = out.length;
    while (size < outLength + needed) size *= 2;
    const next = new Uint8Array(size);
    next.set(out.subarray(0, outLength));
    out = next;
  };

  /** Throws `RangeError` at end of input; callers turn that into a partial result. */
  const bits = (count: number): number => {
    while (bitCount < count) {
      if (pos >= input.length) throw new RangeError('deflate stream ended early');
      bitBuffer |= (input[pos++] ?? 0) << bitCount;
      bitCount += 8;
    }
    const value = bitBuffer & ((1 << count) - 1);
    bitBuffer >>>= count;
    bitCount -= count;
    return value;
  };

  const decode = ({ counts, symbols }: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = counts[len] ?? 0;
      if (code - first < count) return symbols[index + (code - first)] ?? 0;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new InflateError('invalid Huffman code');
  };

  const block = (literals: Huffman, distances: Huffman): void => {
    for (;;) {
      const symbol = decode(literals);
      if (symbol < 256) {
        grow(1);
        out[outLength++] = symbol;
        continue;
      }
      if (symbol === 256) return;
      const lengthIndex = symbol - 257;
      if (lengthIndex >= LENGTH_BASE.length) throw new InflateError('invalid length code');
      const length = (LENGTH_BASE[lengthIndex] ?? 0) + bits(LENGTH_EXTRA[lengthIndex] ?? 0);
      const distanceSymbol = decode(distances);
      if (distanceSymbol >= DIST_BASE.length) throw new InflateError('invalid distance code');
      const distance = (DIST_BASE[distanceSymbol] ?? 0) + bits(DIST_EXTRA[distanceSymbol] ?? 0);
      if (distance > outLength) throw new InflateError('distance runs before the output');
      grow(length);
      // Byte at a time: overlapping copies are legal and common (run-length
      // encoding falls out of a distance smaller than the length).
      let from = outLength - distance;
      for (let i = 0; i < length; i++) out[outLength++] = out[from++] ?? 0;
    }
  };

  try {
    for (;;) {
      const final = bits(1);
      const type = bits(2);
      if (type === 0) {
        // Stored: skip to the byte boundary, then LEN/NLEN and the raw bytes.
        bitBuffer = 0;
        bitCount = 0;
        if (pos + 4 > input.length) throw new RangeError('deflate stream ended early');
        const len = (input[pos] ?? 0) | ((input[pos + 1] ?? 0) << 8);
        pos += 4;
        const available = Math.min(len, input.length - pos);
        grow(available);
        out.set(input.subarray(pos, pos + available), outLength);
        outLength += available;
        pos += available;
        if (available < len) throw new RangeError('deflate stream ended early');
      } else if (type === 1) {
        block(FIXED_LITERALS, FIXED_DISTANCES);
      } else if (type === 2) {
        const literalCount = bits(5) + 257;
        const distanceCount = bits(5) + 1;
        const codeLengthCount = bits(4) + 4;
        const codeLengths = new Uint8Array(19);
        for (let i = 0; i < codeLengthCount; i++) {
          codeLengths[CLEN_ORDER[i] ?? 0] = bits(3);
        }
        const codeLengthTable = buildHuffman(codeLengths);

        const lengths = new Uint8Array(literalCount + distanceCount);
        let index = 0;
        while (index < lengths.length) {
          const symbol = decode(codeLengthTable);
          if (symbol < 16) {
            lengths[index++] = symbol;
          } else if (symbol === 16) {
            const previous = lengths[index - 1] ?? 0;
            let repeat = 3 + bits(2);
            while (repeat-- && index < lengths.length) lengths[index++] = previous;
          } else if (symbol === 17) {
            let repeat = 3 + bits(3);
            while (repeat-- && index < lengths.length) lengths[index++] = 0;
          } else {
            let repeat = 11 + bits(7);
            while (repeat-- && index < lengths.length) lengths[index++] = 0;
          }
        }
        block(
          buildHuffman(lengths.subarray(0, literalCount)),
          buildHuffman(lengths.subarray(literalCount)),
        );
      } else {
        throw new InflateError('invalid block type');
      }
      if (final) break;
    }
  } catch (error) {
    // A truncated stream still yields everything decoded up to the break. A
    // structurally invalid one does not — that means we misread the format.
    if (!(error instanceof RangeError)) throw error;
  }

  return out.subarray(0, outLength);
}

/**
 * Inflate a zlib-wrapped stream, tolerating a producer that wrote raw DEFLATE
 * under a /FlateDecode filter anyway.
 */
export function inflate(input: Uint8Array): Uint8Array {
  if (input.length < 2) return new Uint8Array(0);
  const cmf = input[0] ?? 0;
  const flg = input[1] ?? 0;
  const looksZlib = (cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0;
  if (!looksZlib) return inflateRaw(input);
  // FDICT (bit 5 of FLG) prepends a 4-byte dictionary id we cannot use.
  const start = flg & 0x20 ? 6 : 2;
  return inflateRaw(input.subarray(start));
}
