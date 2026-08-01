/**
 * The PDF reader: primitives against published vectors, then whole encrypted
 * documents end to end.
 *
 * The fixtures in `tests/fixtures/` were produced by ReportLab and encrypted by
 * pypdf — deliberately *not* by this repo's own code, so that a matching pair of
 * bugs in the encryption and decryption directions cannot cancel out and pass.
 * They cover the four security handlers a bank statement is likely to arrive
 * with, plus one that is not encrypted at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync, deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { inflate, inflateRaw } from '../src/core/pdf/inflate.ts';
import {
  aesCbcDecryptNoPad, aesCbcEncryptNoPad, latin1Bytes, md5, rc4, sha256, sha384, sha512,
} from '../src/core/pdf/crypt.ts';
import { readPdfText, PdfPasswordError, pdfIsEncrypted, looksLikePdf } from '../src/core/pdf/read.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures', name)));

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/* ── Hashes ───────────────────────────────────────────────────────────── */

test('md5 matches RFC 1321 vectors', () => {
  assert.equal(hex(md5(new Uint8Array(0))), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(hex(md5(latin1Bytes('abc'))), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(
    hex(md5(latin1Bytes('message digest'))),
    'f96b697d7cb7938d525a2f31aaf161d0',
  );
});

test('md5 handles inputs that straddle the block padding boundary', () => {
  // 55, 56 and 64 bytes are where the length field does or does not fit in the
  // final block — the classic place a hash implementation goes wrong.
  for (const length of [54, 55, 56, 57, 63, 64, 65, 1000]) {
    const input = 'a'.repeat(length);
    assert.equal(
      hex(md5(latin1Bytes(input))),
      createHash('md5').update(input).digest('hex'),
      `md5 of ${length} bytes`,
    );
  }
});

test('sha-2 matches the reference implementations', () => {
  assert.equal(
    hex(sha256(latin1Bytes('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  for (const length of [0, 111, 112, 127, 128, 500]) {
    const input = 'x'.repeat(length);
    assert.equal(hex(sha256(latin1Bytes(input))), createHash('sha256').update(input).digest('hex'));
    assert.equal(hex(sha384(latin1Bytes(input))), createHash('sha384').update(input).digest('hex'));
    assert.equal(hex(sha512(latin1Bytes(input))), createHash('sha512').update(input).digest('hex'));
  }
});

/* ── Ciphers ──────────────────────────────────────────────────────────── */

test('rc4 matches its published test vector', () => {
  assert.equal(hex(rc4(latin1Bytes('Key'), latin1Bytes('Plaintext'))), 'bbf316e8d940af0ad3');
  // Symmetric: running it twice returns the input.
  const key = latin1Bytes('secret');
  const message = latin1Bytes('the quick brown fox');
  assert.deepEqual(rc4(key, rc4(key, message)), message);
});

test('aes matches the FIPS-197 worked examples', () => {
  const plain = Uint8Array.from(Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
  const zeroIv = new Uint8Array(16);

  const key128 = Uint8Array.from({ length: 16 }, (_, i) => i);
  assert.equal(hex(aesCbcEncryptNoPad(key128, zeroIv, plain)), '69c4e0d86a7b0430d8cdb78070b4c55a');

  const key192 = Uint8Array.from({ length: 24 }, (_, i) => i);
  assert.equal(hex(aesCbcEncryptNoPad(key192, zeroIv, plain)), 'dda97ca4864cdfe06eaf70a0ec0d7191');

  const key256 = Uint8Array.from({ length: 32 }, (_, i) => i);
  assert.equal(hex(aesCbcEncryptNoPad(key256, zeroIv, plain)), '8ea2b7ca516745bfeafc49904b496089');

  assert.deepEqual(aesCbcDecryptNoPad(key256, zeroIv, aesCbcEncryptNoPad(key256, zeroIv, plain)), plain);
});

test('aes does not modify the buffer it was given', () => {
  // `slice` on a Node Buffer returns a view rather than a copy, so a careless
  // implementation overwrites its caller's data in place.
  const key = Uint8Array.from({ length: 16 }, (_, i) => i);
  const original = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const copy = Buffer.from(original);
  aesCbcEncryptNoPad(key, new Uint8Array(16), original);
  assert.deepEqual(original, copy, 'input was mutated');
});

/* ── Inflate ──────────────────────────────────────────────────────────── */

test('inflate round-trips zlib, raw and stored streams', () => {
  const data = Buffer.from('BDO statement 18 June 2026. '.repeat(80));
  assert.deepEqual(Buffer.from(inflate(new Uint8Array(deflateSync(data)))), data);
  assert.deepEqual(Buffer.from(inflate(new Uint8Array(deflateRawSync(data)))), data);
  assert.deepEqual(
    Buffer.from(inflate(new Uint8Array(deflateSync(data, { level: 0 })))),
    data,
    'stored (uncompressed) blocks',
  );
});

test('a truncated stream yields what was decoded rather than nothing', () => {
  // Deliberately poorly-compressible, so that half the compressed stream is
  // still well past the block header and carries real output. A run of one
  // repeated byte would compress to ~20 bytes, and half of that is only a
  // partial header — nothing could be recovered from it, truncation handling or
  // not.
  let text = '';
  for (let i = 0; i < 4000; i++) text += String.fromCharCode(33 + ((i * 7919) % 90));
  const data = Buffer.from(text);
  const compressed = new Uint8Array(deflateRawSync(data));
  const half = inflateRaw(compressed.subarray(0, Math.floor(compressed.length / 2)));
  assert.ok(half.length > 0, 'expected a partial result');
  assert.ok(half.length < data.length);
});

/* ── Whole documents ──────────────────────────────────────────────────── */

const ENCRYPTED: Array<[string, string, string]> = [
  ['bdo-card-aes256.pdf', '7788', 'AES-256 (revision 6)'],
  ['bpi-card-rc4.pdf', '0620', 'RC4 128-bit (revision 4)'],
  ['unionbank-card-aes128.pdf', '1140', 'AES-128 (revision 4)'],
  ['rcbc-savings-aes256.pdf', 'mypassword', 'AES-256 (revision 6)'],
];

for (const [file, password, handler] of ENCRYPTED) {
  test(`${file} opens with its password — ${handler}`, () => {
    const bytes = fixture(file);
    assert.ok(looksLikePdf(bytes));
    assert.ok(pdfIsEncrypted(bytes), 'fixture should be encrypted');

    const text = readPdfText(bytes, password);
    assert.ok(text.encrypted);
    assert.equal(text.openedWith, 'user');
    assert.ok(text.lines.length > 5, 'expected readable lines');
  });

  test(`${file} refuses the wrong password`, () => {
    assert.throws(
      () => readPdfText(fixture(file), 'not-the-password'),
      (error: unknown) => error instanceof PdfPasswordError && error.tried,
    );
  });

  test(`${file} refuses no password at all`, () => {
    assert.throws(
      () => readPdfText(fixture(file), ''),
      (error: unknown) => error instanceof PdfPasswordError && !error.tried,
    );
  });
}

test('an owner password opens the document too', () => {
  // The user password is recoverable from the owner password, which is why a
  // "restricted" statement opens with either.
  const text = readPdfText(fixture('bdo-card-owner-rc4.pdf'), 'letmein');
  assert.equal(text.openedWith, 'owner');
  assert.ok(text.lines.some((line) => /BDO/i.test(line.text)));
});

test('an unencrypted statement needs no password', () => {
  const bytes = fixture('bank-statement-plain.pdf');
  assert.equal(pdfIsEncrypted(bytes), false);
  const text = readPdfText(bytes);
  assert.equal(text.encrypted, false);
  assert.equal(text.openedWith, 'none');
});

test('text comes back positioned, in reading order', () => {
  const text = readPdfText(fixture('bdo-card-aes256.pdf'), '7788');
  const joined = text.lines.map((line) => line.text);
  assert.ok(joined.some((line) => line.includes('BDO Unibank')));
  assert.ok(
    joined.some((line) => line.startsWith('05/21/2026') && line.endsWith('2,845.60')),
    'a transaction row should read date-first, amount-last',
  );

  // Every run knows where it sits, and the offsets map back into the joined
  // text — that mapping is what tells a debit column from a credit one.
  for (const line of text.lines) {
    assert.equal(line.items.length, line.offsets.length);
    for (const [index, item] of line.items.entries()) {
      assert.equal(line.text.slice(line.offsets[index], (line.offsets[index] ?? 0) + item.text.length), item.text);
      assert.ok(item.endX >= item.x);
    }
  }
});

test('standard-14 font widths are used when a font declares none', () => {
  // Helvetica-Bold column headings carry no /Widths array. With a flat 500/em
  // guess they come out ~25% narrow, and stop lining up with their column.
  const text = readPdfText(fixture('bpi-card-rc4.pdf'), '0620');
  const header = text.lines.find((line) => line.text.includes('PURCHASES/CHARGES'));
  assert.ok(header, 'expected the column header row');
  const heading = header.items.find((item) => item.text === 'PURCHASES/CHARGES');
  assert.ok(heading);
  // ReportLab right-aligned this heading at x=430.
  assert.ok(Math.abs(heading.endX - 430) < 2, `heading ends at ${heading.endX}, expected ~430`);
});

test('a file that is not a PDF is rejected before anything else', () => {
  assert.throws(() => readPdfText(latin1Bytes('just some text')), /not look like a PDF/);
});

/**
 * A minimal PDF whose only font is `Type3` with an `/Encoding` naming its one
 * glyph something Zenith cannot resolve to a character (no `/ToUnicode`, and
 * the `/Differences` name matches nothing in `glyphNameToText`).
 *
 * Some banks generate statements exactly this way — every glyph drawn as its
 * own tiny vector program rather than referencing a real font — specifically
 * because it defeats copy-paste and naive text extraction. The page still
 * draws a glyph, so this is not the "scanned image" case: a page with genuine
 * text-drawing operators that all decode to nothing needs to say so, not
 * blame a scan that never happened.
 */
function undecodableType3Pdf(): Uint8Array {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type3 /FontBBox [0 0 10 10] /FontMatrix [1 0 0 1 0 0] /Encoding << /Differences [65 /Cx1] >> /FirstChar 65 /LastChar 65 /Widths [500] >>
endobj
5 0 obj
<< >>
stream
BT /F1 12 Tf 10 100 Td (A) Tj ET
endstream
endobj
trailer
<< /Root 1 0 R >>
%%EOF
`;
  return latin1Bytes(pdf);
}

test('a page whose glyphs all decode to nothing is not called a scan', () => {
  assert.throws(
    () => readPdfText(undecodableType3Pdf()),
    /shapes Zenith cannot decode/,
  );
});

test('a page with no text-drawing operators at all is still called a scan', () => {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>
endobj
4 0 obj
<< >>
stream
0 0 1 1 re f
endstream
endobj
trailer
<< /Root 1 0 R >>
%%EOF
`;
  assert.throws(() => readPdfText(latin1Bytes(pdf)), /may be a scan/);
});
