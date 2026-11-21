import { describe, expect, it } from 'vitest';
import { randomBytes, utf8 } from '../src/core/bytes.ts';
import { PBKDF2_ITERATIONS, bucketSize, deriveKek, keysFromMaster, open, pad, seal, unpad } from '../src/core/crypto.ts';

describe('crypto', () => {
  it('derives a non-extractable AES-256-GCM key with >=600k PBKDF2 iterations', async () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    const k = await deriveKek('correct horse', randomBytes(16));
    expect(k.extractable).toBe(false);
    expect((k.algorithm as AesKeyAlgorithm).length).toBe(256);
    await expect(deriveKek('x', randomBytes(16), 1000)).rejects.toThrow();
  });

  it('round-trips seal/open and uses a unique IV each time', async () => {
    const k = await deriveKek('pass', randomBytes(16));
    const msg = utf8.encode('hello secret world');
    const aad = utf8.encode('rec-1');
    const a = await seal(k, msg, aad), b = await seal(k, msg, aad);
    expect(a.subarray(0, 12)).not.toEqual(b.subarray(0, 12));
    expect(await open(k, a, aad)).toEqual(msg);
    await expect(open(k, a, utf8.encode('rec-2'))).rejects.toThrow(); // AAD binds record id
    const tampered = a.slice(); tampered[20] ^= 1;
    await expect(open(k, tampered, aad)).rejects.toThrow();
  });

  it('wrong passphrase fails to decrypt', async () => {
    const salt = randomBytes(16);
    const k1 = await deriveKek('one', salt), k2 = await deriveKek('two', salt);
    const s = await seal(k1, utf8.encode('x'), new Uint8Array());
    await expect(open(k2, s, new Uint8Array())).rejects.toThrow();
  });

  it('subkeys from master are non-extractable and master is wiped', async () => {
    const m = randomBytes(64);
    const keys = await keysFromMaster(m);
    expect(m.every((b) => b === 0)).toBe(true);
    expect(keys.enc.extractable).toBe(false);
    expect(keys.ids.extractable).toBe(false);
  });

  it('pads to size buckets', () => {
    expect(bucketSize(1)).toBe(512);
    expect(bucketSize(600)).toBe(1024);
    expect(bucketSize(70000)).toBe(131072);
    const d = randomBytes(777);
    expect(unpad(pad(d))).toEqual(d);
  });
});
