/**
 * The cryptographic primitives a password-protected PDF needs: MD5, SHA-2,
 * RC4 and AES.
 *
 * Hand-rolled rather than delegated to WebCrypto for three reasons: WebCrypto
 * has no MD5 or RC4 at all (both are still required by PDF revisions 2–4), its
 * AES-CBC always applies PKCS#7 padding while the revision 6 key derivation
 * needs raw CBC, and every call is asynchronous — which would spread `await`
 * through a parser that is otherwise pure and synchronous.
 *
 * None of this is used to *protect* anything. It only opens files the user
 * already has the password for, on their own device.
 */

/* ── Bytes ────────────────────────────────────────────────────────────── */

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Latin-1 bytes: the encoding PDF passwords and names use. */
export function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/* ── MD5 (RFC 1321) ───────────────────────────────────────────────────── */

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_SINE = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296),
);

export function md5(message: Uint8Array): Uint8Array {
  const bitLength = message.length * 8;
  const padded = new Uint8Array((((message.length + 8) >> 6) + 1) * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    const words = new Uint32Array(16);
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(chunk + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + (MD5_SINE[i] ?? 0) + (words[g] ?? 0)) >>> 0;
      const shift = MD5_SHIFTS[i] ?? 0;
      a = d;
      d = c;
      c = b;
      b = (b + (((sum << shift) | (sum >>> (32 - shift))) >>> 0)) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const digest = new Uint8Array(16);
  const out = new DataView(digest.buffer);
  out.setUint32(0, a0, true);
  out.setUint32(4, b0, true);
  out.setUint32(8, c0, true);
  out.setUint32(12, d0, true);
  return digest;
}

/* ── SHA-256 (FIPS 180-4) ─────────────────────────────────────────────── */

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export function sha256(message: Uint8Array): Uint8Array {
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const bitLength = message.length * 8;
  const padded = new Uint8Array((((message.length + 8) >> 6) + 1) * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const w = new Uint32Array(64);
  const rotr = (value: number, by: number): number => (value >>> by) | (value << (32 - by));

  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(chunk + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] ?? 0;
      const b = w[i - 2] ?? 0;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, hh = 0] = hash;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) hash[i] = ((hash[i] ?? 0) + (next[i] ?? 0)) >>> 0;
  }

  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) out.setUint32(i * 4, hash[i] ?? 0);
  return digest;
}

/* ── SHA-384 / SHA-512 ────────────────────────────────────────────────── */

/**
 * 64-bit words, so this one uses BigInt. Only revision 6's key derivation
 * reaches it, and only over inputs of a few kilobytes, so the cost is invisible
 * next to the clarity of not hand-rolling 64-bit arithmetic out of pairs.
 */
const SHA512_K = [
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc',
  '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118',
  'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2',
  '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
  'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65',
  '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
  '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4',
  'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
  '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df',
  '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
  'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30',
  'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8',
  '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec',
  '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
  'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178',
  '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
  '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c',
  '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817',
].map((hex) => BigInt(`0x${hex}`));

const MASK64 = (1n << 64n) - 1n;

function sha512Core(message: Uint8Array, initial: bigint[], outputBytes: number): Uint8Array {
  const hash = [...initial];
  const blockCount = Math.floor((message.length + 16) / 128) + 1;
  const padded = new Uint8Array(blockCount * 128);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  // Length is 128 bits; a message that needs the high half is not reachable here.
  view.setBigUint64(padded.length - 8, BigInt(message.length) * 8n);

  const rotr = (value: bigint, by: bigint): bigint =>
    ((value >> by) | (value << (64n - by))) & MASK64;

  const w = new Array<bigint>(80);
  for (let chunk = 0; chunk < padded.length; chunk += 128) {
    for (let i = 0; i < 16; i++) w[i] = view.getBigUint64(chunk + i * 8);
    for (let i = 16; i < 80; i++) {
      const a = w[i - 15] ?? 0n;
      const b = w[i - 2] ?? 0n;
      const s0 = rotr(a, 1n) ^ rotr(a, 8n) ^ (a >> 7n);
      const s1 = rotr(b, 19n) ^ rotr(b, 61n) ^ (b >> 6n);
      w[i] = ((w[i - 16] ?? 0n) + s0 + (w[i - 7] ?? 0n) + s1) & MASK64;
    }

    let [a = 0n, b = 0n, c = 0n, d = 0n, e = 0n, f = 0n, g = 0n, hh = 0n] = hash;
    for (let i = 0; i < 80; i++) {
      const s1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n);
      const ch = (e & f) ^ (~e & MASK64 & g);
      const temp1 = (hh + s1 + ch + (SHA512_K[i] ?? 0n) + (w[i] ?? 0n)) & MASK64;
      const s0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) & MASK64;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) & MASK64;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & MASK64;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) hash[i] = ((hash[i] ?? 0n) + (next[i] ?? 0n)) & MASK64;
  }

  const digest = new Uint8Array(64);
  const out = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) out.setBigUint64(i * 8, hash[i] ?? 0n);
  return digest.subarray(0, outputBytes);
}

export function sha512(message: Uint8Array): Uint8Array {
  return sha512Core(
    message,
    [
      0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
      0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
    ],
    64,
  );
}

export function sha384(message: Uint8Array): Uint8Array {
  return sha512Core(
    message,
    [
      0xcbbb9d5dc1059ed8n, 0x629a292a367cd507n, 0x9159015a3070dd17n, 0x152fecd8f70e5939n,
      0x67332667ffc00b31n, 0x8eb44a8768581511n, 0xdb0c2e0d64f98fa7n, 0x47b5481dbefa4fa4n,
    ],
    48,
  );
}

/* ── RC4 ──────────────────────────────────────────────────────────────── */

/** Symmetric: the same call encrypts and decrypts. */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + (s[i] ?? 0) + (key[i % key.length] ?? 0)) & 0xff;
    const swap = s[i] ?? 0;
    s[i] = s[j] ?? 0;
    s[j] = swap;
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 0xff;
    b = (b + (s[a] ?? 0)) & 0xff;
    const swap = s[a] ?? 0;
    s[a] = s[b] ?? 0;
    s[b] = swap;
    out[k] = (data[k] ?? 0) ^ (s[((s[a] ?? 0) + (s[b] ?? 0)) & 0xff] ?? 0);
  }
  return out;
}

/* ── AES ──────────────────────────────────────────────────────────────── */

/** Log/antilog tables over GF(2^8) with generator 3, used for S-box and MixColumns. */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    // value *= 3, i.e. value ^ xtime(value)
    const doubled = ((value << 1) ^ (value & 0x80 ? 0x1b : 0)) & 0xff;
    value = (value ^ doubled) & 0xff;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255] ?? 0;
}

function gmul(a: number, b: number): number {
  if (!a || !b) return 0;
  return GF_EXP[((GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)) % 255] ?? 0;
}

const AES_SBOX = new Uint8Array(256);
const AES_INV_SBOX = new Uint8Array(256);
{
  for (let i = 0; i < 256; i++) {
    const inverse = i === 0 ? 0 : GF_EXP[255 - (GF_LOG[i] ?? 0)] ?? 0;
    let s = inverse;
    let r = inverse;
    for (let n = 0; n < 4; n++) {
      r = ((r << 1) | (r >>> 7)) & 0xff;
      s ^= r;
    }
    s ^= 0x63;
    AES_SBOX[i] = s;
    AES_INV_SBOX[s] = i;
  }
}

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d];

interface AesKey {
  /** Flattened round keys: 16 bytes per round, `rounds + 1` of them. */
  schedule: Uint8Array;
  rounds: number;
}

export function expandAesKey(key: Uint8Array): AesKey {
  const nk = key.length / 4;
  if (nk !== 4 && nk !== 6 && nk !== 8) throw new Error('AES key must be 16, 24 or 32 bytes');
  const rounds = nk + 6;
  const words = 4 * (rounds + 1);
  const schedule = new Uint8Array(words * 4);
  schedule.set(key);

  for (let i = nk; i < words; i++) {
    let t0 = schedule[(i - 1) * 4] ?? 0;
    let t1 = schedule[(i - 1) * 4 + 1] ?? 0;
    let t2 = schedule[(i - 1) * 4 + 2] ?? 0;
    let t3 = schedule[(i - 1) * 4 + 3] ?? 0;
    if (i % nk === 0) {
      const rotated = [t1, t2, t3, t0];
      t0 = (AES_SBOX[rotated[0] ?? 0] ?? 0) ^ (RCON[i / nk - 1] ?? 0);
      t1 = AES_SBOX[rotated[1] ?? 0] ?? 0;
      t2 = AES_SBOX[rotated[2] ?? 0] ?? 0;
      t3 = AES_SBOX[rotated[3] ?? 0] ?? 0;
    } else if (nk === 8 && i % nk === 4) {
      t0 = AES_SBOX[t0] ?? 0;
      t1 = AES_SBOX[t1] ?? 0;
      t2 = AES_SBOX[t2] ?? 0;
      t3 = AES_SBOX[t3] ?? 0;
    }
    schedule[i * 4] = (schedule[(i - nk) * 4] ?? 0) ^ t0;
    schedule[i * 4 + 1] = (schedule[(i - nk) * 4 + 1] ?? 0) ^ t1;
    schedule[i * 4 + 2] = (schedule[(i - nk) * 4 + 2] ?? 0) ^ t2;
    schedule[i * 4 + 3] = (schedule[(i - nk) * 4 + 3] ?? 0) ^ t3;
  }
  return { schedule, rounds };
}

function addRoundKey(state: Uint8Array, schedule: Uint8Array, round: number): void {
  const offset = round * 16;
  for (let i = 0; i < 16; i++) state[i] = (state[i] ?? 0) ^ (schedule[offset + i] ?? 0);
}

/**
 * Copy bytes out of a view. `slice` would do it for a `Uint8Array` but returns
 * a *view* on a Node `Buffer`, so a caller passing one would have its input
 * overwritten in place.
 */
const copyOf = (source: Uint8Array, start = 0, end = source.length): Uint8Array =>
  new Uint8Array(source.subarray(start, end));

/** State bytes are column-major: byte `4c + r` is row r of column c. */
function shiftRows(state: Uint8Array, inverse: boolean): void {
  const copy = copyOf(state);
  for (let row = 1; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const from = inverse ? (col - row + 4) % 4 : (col + row) % 4;
      state[4 * col + row] = copy[4 * from + row] ?? 0;
    }
  }
}

function subBytes(state: Uint8Array, inverse: boolean): void {
  const table = inverse ? AES_INV_SBOX : AES_SBOX;
  for (let i = 0; i < 16; i++) state[i] = table[state[i] ?? 0] ?? 0;
}

function mixColumns(state: Uint8Array, inverse: boolean): void {
  const [m0, m1, m2, m3] = inverse ? [14, 11, 13, 9] : [2, 3, 1, 1];
  for (let col = 0; col < 4; col++) {
    const a0 = state[4 * col] ?? 0;
    const a1 = state[4 * col + 1] ?? 0;
    const a2 = state[4 * col + 2] ?? 0;
    const a3 = state[4 * col + 3] ?? 0;
    state[4 * col] = gmul(a0, m0) ^ gmul(a1, m1) ^ gmul(a2, m2) ^ gmul(a3, m3);
    state[4 * col + 1] = gmul(a0, m3) ^ gmul(a1, m0) ^ gmul(a2, m1) ^ gmul(a3, m2);
    state[4 * col + 2] = gmul(a0, m2) ^ gmul(a1, m3) ^ gmul(a2, m0) ^ gmul(a3, m1);
    state[4 * col + 3] = gmul(a0, m1) ^ gmul(a1, m2) ^ gmul(a2, m3) ^ gmul(a3, m0);
  }
}

function encryptBlock(key: AesKey, block: Uint8Array): Uint8Array {
  const state = copyOf(block);
  addRoundKey(state, key.schedule, 0);
  for (let round = 1; round < key.rounds; round++) {
    subBytes(state, false);
    shiftRows(state, false);
    mixColumns(state, false);
    addRoundKey(state, key.schedule, round);
  }
  subBytes(state, false);
  shiftRows(state, false);
  addRoundKey(state, key.schedule, key.rounds);
  return state;
}

function decryptBlock(key: AesKey, block: Uint8Array): Uint8Array {
  const state = copyOf(block);
  addRoundKey(state, key.schedule, key.rounds);
  for (let round = key.rounds - 1; round > 0; round--) {
    shiftRows(state, true);
    subBytes(state, true);
    addRoundKey(state, key.schedule, round);
    mixColumns(state, true);
  }
  shiftRows(state, true);
  subBytes(state, true);
  addRoundKey(state, key.schedule, 0);
  return state;
}

/** CBC encryption with no padding — `data` must be a whole number of blocks. */
export function aesCbcEncryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const expanded = expandAesKey(key);
  const out = new Uint8Array(data.length - (data.length % 16));
  let previous = copyOf(iv, 0, 16);
  for (let offset = 0; offset + 16 <= out.length; offset += 16) {
    const block = copyOf(data, offset, offset + 16);
    for (let i = 0; i < 16; i++) block[i] = (block[i] ?? 0) ^ (previous[i] ?? 0);
    const encrypted = encryptBlock(expanded, block);
    out.set(encrypted, offset);
    previous = encrypted;
  }
  return out;
}

export function aesCbcDecryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const expanded = expandAesKey(key);
  const out = new Uint8Array(data.length - (data.length % 16));
  let previous = copyOf(iv, 0, 16);
  for (let offset = 0; offset + 16 <= out.length; offset += 16) {
    const block = copyOf(data, offset, offset + 16);
    const decrypted = decryptBlock(expanded, block);
    for (let i = 0; i < 16; i++) decrypted[i] = (decrypted[i] ?? 0) ^ (previous[i] ?? 0);
    out.set(decrypted, offset);
    previous = block;
  }
  return out;
}

/**
 * The shape PDF uses for AESV2/AESV3: a 16-byte initialisation vector in front
 * of the ciphertext, and PKCS#7 padding at the end.
 */
export function aesDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length <= 16) return new Uint8Array(0);
  const plain = aesCbcDecryptNoPad(key, data.subarray(0, 16), data.subarray(16));
  const padding = plain[plain.length - 1] ?? 0;
  // Trust the padding byte only when it could be padding; a stream whose last
  // byte happens to be 0x04 but is not padded should not lose four bytes.
  if (padding >= 1 && padding <= 16 && padding <= plain.length) {
    for (let i = plain.length - padding; i < plain.length; i++) {
      if (plain[i] !== padding) return plain;
    }
    return plain.subarray(0, plain.length - padding);
  }
  return plain;
}

export function aesEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const padding = 16 - (data.length % 16);
  const padded = new Uint8Array(data.length + padding);
  padded.set(data);
  padded.fill(padding, data.length);
  return concatBytes(copyOf(iv, 0, 16), aesCbcEncryptNoPad(key, iv, padded));
}
