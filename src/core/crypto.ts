import { concat, randomBytes, readU32, u32, utf8 } from './bytes.ts';

const subtle = crypto.subtle;
export const PBKDF2_ITERATIONS = 600_000;
export const IV_LEN = 12;
export const TAG_LEN = 16;
export const SEAL_OVERHEAD = IV_LEN + TAG_LEN;

/** Passphrase -> non-extractable AES-256-GCM key-encryption key (PBKDF2-SHA256). */
export async function deriveKek(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  if (iterations < PBKDF2_ITERATIONS) throw new Error('Iteration count too low');
  const base = await subtle.importKey('raw', utf8.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface VaultKeys {
  /** AES-256-GCM key for every record of this vault. Non-extractable. */
  enc: CryptoKey;
  /** HMAC key used to derive this vault's (otherwise unlinkable) index record id. Non-extractable. */
  ids: CryptoKey;
}

/** Turns a 64-byte vault master secret into non-extractable subkeys, then wipes the master bytes. */
export async function keysFromMaster(master: Uint8Array): Promise<VaultKeys> {
  try {
    const hk = await subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
    const salt = utf8.encode('atelier/hkdf/v1');
    const enc = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode('enc') },
      hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    const ids = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode('ids') },
      hk, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'],
    );
    return { enc, ids };
  } finally {
    master.fill(0);
  }
}

/** AES-GCM with a fresh random 96-bit IV. Output: iv || ciphertext+tag. */
export async function seal(key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(IV_LEN);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext));
  return concat(iv, ct);
}

export async function open(key: CryptoKey, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < SEAL_OVERHEAD) throw new Error('Ciphertext too short');
  const iv = sealed.subarray(0, IV_LEN);
  const ct = sealed.subarray(IV_LEN);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ct));
}

/** Size buckets hide exact lengths: 512 B, then powers of two up to 64 KiB, then 64 KiB multiples. */
export function bucketSize(n: number): number {
  const total = n + 4;
  if (total <= 512) return 512;
  if (total <= 65536) return 2 ** Math.ceil(Math.log2(total));
  return Math.ceil(total / 65536) * 65536;
}

export function pad(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(bucketSize(data.length));
  out.set(u32(data.length), 0);
  out.set(data, 4);
  return out;
}

export function unpad(padded: Uint8Array): Uint8Array {
  const len = readU32(padded, 0);
  if (len + 4 > padded.length) throw new Error('Bad padding');
  return padded.slice(4, 4 + len);
}

export async function hmacHex(key: CryptoKey, label: string): Promise<string> {
  const sig = new Uint8Array(await subtle.sign('HMAC', key, utf8.encode(label)));
  let s = '';
  for (let i = 0; i < 16; i++) s += sig[i].toString(16).padStart(2, '0');
  return s;
}
