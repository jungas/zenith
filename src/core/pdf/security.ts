/**
 * The PDF standard security handler — the part that turns "this file is
 * password protected" into readable bytes.
 *
 * Five generations of it are still in circulation and banks use all of them, so
 * all five are here:
 *
 * | Revision | Cipher            | Key derivation            |
 * |----------|-------------------|---------------------------|
 * | 2        | RC4, 40-bit       | one MD5                   |
 * | 3        | RC4, up to 128    | MD5 iterated 50×          |
 * | 4        | RC4 or AES-128    | as revision 3, per filter |
 * | 5        | AES-256           | one SHA-256 (deprecated)  |
 * | 6        | AES-256           | the 2.B hardening loop    |
 *
 * Both passwords a PDF can carry are accepted. The *user* password opens the
 * document; the *owner* password lifts restrictions, and — because the user
 * password is recoverable from it — opens the document too. A statement mailed
 * out by a bank is typically protected with a user password derived from your
 * birthday or card number.
 */

import {
  aesCbcDecryptNoPad, aesCbcEncryptNoPad, aesDecrypt, bytesEqual, concatBytes, latin1Bytes,
  md5, rc4, sha256, sha384, sha512,
} from './crypt.ts';

/** Thrown when the file is encrypted and the supplied password is not the one. */
export class PdfPasswordError extends Error {
  /** True once a password has been tried and rejected, false when none was given. */
  readonly tried: boolean;
  constructor(message: string, tried: boolean) {
    super(message);
    this.name = 'PdfPasswordError';
    this.tried = tried;
  }
}

/** Thrown for a security handler we cannot open at all, password or not. */
export class PdfUnsupportedEncryptionError extends Error {}

export type Cipher = 'none' | 'rc4' | 'aes128' | 'aes256';

/** The /Encrypt dictionary, already resolved to plain values by the parser. */
export interface EncryptionDict {
  filter: string;
  v: number;
  r: number;
  /** Key length in bits. */
  length: number;
  o: Uint8Array;
  u: Uint8Array;
  oe: Uint8Array | null;
  ue: Uint8Array | null;
  p: number;
  encryptMetadata: boolean;
  streamCipher: Cipher;
  stringCipher: Cipher;
}

export interface Decryptor {
  decryptStream(data: Uint8Array, num: number, gen: number): Uint8Array;
  decryptString(data: Uint8Array, num: number, gen: number): Uint8Array;
  /** Which password opened the file, for the UI to report. */
  openedWith: 'user' | 'owner' | 'empty';
}

/** The 32-byte padding string from Algorithm 2. */
const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56,
  0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** Truncate to 32 bytes, or top up from the padding string. */
function padPassword(password: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  const take = Math.min(password.length, 32);
  out.set(password.subarray(0, take));
  out.set(PAD.subarray(0, 32 - take), take);
  return out;
}

function int32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value | 0, true);
  return out;
}

/** Algorithm 2: the file encryption key, from an already-padded password. */
function legacyFileKey(padded: Uint8Array, dict: EncryptionDict, id0: Uint8Array): Uint8Array {
  const parts = [padded, dict.o.subarray(0, 32), int32le(dict.p), id0];
  // Revision 4 with metadata left in the clear folds an extra marker in, and
  // omitting it yields a key that decrypts to noise.
  if (dict.r >= 4 && !dict.encryptMetadata) {
    parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  }
  let hash = md5(concatBytes(...parts));
  const keyLength = dict.r === 2 ? 5 : Math.min(16, Math.max(5, Math.floor(dict.length / 8) || 5));
  if (dict.r >= 3) {
    for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, keyLength));
  }
  return hash.subarray(0, keyLength);
}

/** Algorithms 4 and 5, run in reverse: does this key reproduce /U? */
function legacyKeyOpensFile(key: Uint8Array, dict: EncryptionDict, id0: Uint8Array): boolean {
  if (dict.r === 2) return bytesEqual(rc4(key, PAD), dict.u.subarray(0, 32));
  let value = rc4(key, md5(concatBytes(PAD, id0)));
  for (let i = 1; i <= 19; i++) {
    const roundKey = new Uint8Array(key.length);
    for (let b = 0; b < key.length; b++) roundKey[b] = (key[b] ?? 0) ^ i;
    value = rc4(roundKey, value);
  }
  // Only the first 16 bytes are meaningful; the rest is arbitrary padding.
  return bytesEqual(value.subarray(0, 16), dict.u.subarray(0, 16));
}

/** Algorithm 7: recover the padded *user* password from the owner password. */
function userPasswordFromOwner(owner: Uint8Array, dict: EncryptionDict): Uint8Array {
  let hash = md5(padPassword(owner));
  const keyLength = dict.r === 2 ? 5 : Math.min(16, Math.max(5, Math.floor(dict.length / 8) || 5));
  if (dict.r >= 3) {
    for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, keyLength));
  }
  const key = hash.subarray(0, keyLength);
  if (dict.r === 2) return rc4(key, dict.o.subarray(0, 32));
  let value = dict.o.subarray(0, 32);
  for (let i = 19; i >= 0; i--) {
    const roundKey = new Uint8Array(key.length);
    for (let b = 0; b < key.length; b++) roundKey[b] = (key[b] ?? 0) ^ i;
    value = rc4(roundKey, value);
  }
  return value;
}

/**
 * Algorithm 2.B — the revision 6 hardening loop.
 *
 * The point of the loop is cost: it runs at least 64 rounds of AES over a
 * kilobyte of repeated material before it will even consider stopping, which is
 * what makes guessing a weak statement password slow.
 */
function hash2B(password: Uint8Array, salt: Uint8Array, userData: Uint8Array): Uint8Array {
  let k = sha256(concatBytes(password, salt, userData));
  let round = 0;
  let last = 0;
  while (round < 64 || last > round - 32) {
    const block = concatBytes(password, k, userData);
    const k1 = new Uint8Array(block.length * 64);
    for (let i = 0; i < 64; i++) k1.set(block, i * block.length);
    // Encryption, not decryption: 2.B runs the cipher forwards as a mixing
    // function, with the first half of K as the key and the second half as the IV.
    const e = aesCbcEncryptNoPad(k.subarray(0, 16), k.subarray(16, 32), k1);
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i] ?? 0;
    const mod = sum % 3;
    k = mod === 0 ? sha256(e) : mod === 1 ? sha384(e) : sha512(e);
    last = e[e.length - 1] ?? 0;
    round++;
  }
  return k.subarray(0, 32);
}

/** Revision 5 used a bare SHA-256; revision 6 replaced it with 2.B. */
function hash2AB(revision: number, password: Uint8Array, salt: Uint8Array, userData: Uint8Array): Uint8Array {
  return revision === 5
    ? sha256(concatBytes(password, salt, userData))
    : hash2B(password, salt, userData);
}

/**
 * Passwords for revisions 5 and 6 are UTF-8, capped at 127 bytes.
 *
 * The specification asks for SASLprep normalisation first. It is skipped: it
 * only changes the outcome for passwords carrying unusual Unicode, and getting
 * it half-right would break passwords that currently work.
 */
function utf8Password(password: string): Uint8Array {
  return new TextEncoder().encode(password).subarray(0, 127);
}

interface UnlockResult {
  fileKey: Uint8Array;
  openedWith: 'user' | 'owner' | 'empty';
}

function unlockAes256(dict: EncryptionDict, password: string): UnlockResult | null {
  const bytes = utf8Password(password);
  const u48 = dict.u.subarray(0, 48);

  const userValidation = dict.u.subarray(32, 40);
  const userKeySalt = dict.u.subarray(40, 48);
  if (bytesEqual(hash2AB(dict.r, bytes, userValidation, new Uint8Array(0)), dict.u.subarray(0, 32))) {
    const intermediate = hash2AB(dict.r, bytes, userKeySalt, new Uint8Array(0));
    const fileKey = aesCbcDecryptNoPad(intermediate, new Uint8Array(16), dict.ue ?? new Uint8Array(32));
    return { fileKey, openedWith: password ? 'user' : 'empty' };
  }

  const ownerValidation = dict.o.subarray(32, 40);
  const ownerKeySalt = dict.o.subarray(40, 48);
  if (bytesEqual(hash2AB(dict.r, bytes, ownerValidation, u48), dict.o.subarray(0, 32))) {
    const intermediate = hash2AB(dict.r, bytes, ownerKeySalt, u48);
    const fileKey = aesCbcDecryptNoPad(intermediate, new Uint8Array(16), dict.oe ?? new Uint8Array(32));
    return { fileKey, openedWith: 'owner' };
  }

  return null;
}

function unlockLegacy(dict: EncryptionDict, password: string, id0: Uint8Array): UnlockResult | null {
  const bytes = latin1Bytes(password);

  const asUser = legacyFileKey(padPassword(bytes), dict, id0);
  if (legacyKeyOpensFile(asUser, dict, id0)) {
    return { fileKey: asUser, openedWith: password ? 'user' : 'empty' };
  }

  // Not the user password — it may still be the owner password, which the user
  // password can be recovered from.
  const recovered = userPasswordFromOwner(bytes, dict);
  const asOwner = legacyFileKey(recovered, dict, id0);
  if (legacyKeyOpensFile(asOwner, dict, id0)) return { fileKey: asOwner, openedWith: 'owner' };

  return null;
}

const AES_SALT = new Uint8Array([0x73, 0x41, 0x6c, 0x54]); // "sAlT"

/**
 * Build the decryptor for a document, or throw `PdfPasswordError` if the
 * password is wrong.
 */
export function createDecryptor(
  dict: EncryptionDict,
  id0: Uint8Array,
  password: string,
): Decryptor {
  if (dict.filter && dict.filter !== 'Standard') {
    throw new PdfUnsupportedEncryptionError(
      `This PDF uses the “${dict.filter}” security handler, which needs the software that produced it.`,
    );
  }
  if (![2, 3, 4, 5, 6].includes(dict.r)) {
    throw new PdfUnsupportedEncryptionError(`This PDF uses an unknown encryption revision (${dict.r}).`);
  }

  const unlocked = dict.r >= 5 ? unlockAes256(dict, password) : unlockLegacy(dict, password, id0);
  if (!unlocked) {
    throw new PdfPasswordError(
      password ? 'That password did not open the PDF.' : 'This PDF is password protected.',
      Boolean(password),
    );
  }

  const { fileKey } = unlocked;

  /** Algorithm 1: mix the object and generation numbers into the key. */
  const objectKey = (num: number, gen: number, cipher: Cipher): Uint8Array => {
    if (cipher === 'aes256') return fileKey;
    const extra = new Uint8Array([
      num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff,
    ]);
    const parts = cipher === 'aes128'
      ? concatBytes(fileKey, extra, AES_SALT)
      : concatBytes(fileKey, extra);
    return md5(parts).subarray(0, Math.min(fileKey.length + 5, 16));
  };

  const decryptWith = (cipher: Cipher) => (data: Uint8Array, num: number, gen: number): Uint8Array => {
    if (cipher === 'none') return data;
    const key = objectKey(num, gen, cipher);
    return cipher === 'rc4' ? rc4(key, data) : aesDecrypt(key, data);
  };

  return {
    decryptStream: decryptWith(dict.streamCipher),
    decryptString: decryptWith(dict.stringCipher),
    openedWith: unlocked.openedWith,
  };
}
