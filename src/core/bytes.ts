export const utf8 = new TextEncoder();
export const unutf8 = new TextDecoder();

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}
export function readU32(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off);
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Length-prefixed packing of byte chunks: [count u32]([len u32][bytes])* */
export function pack(chunks: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [u32(chunks.length)];
  for (const c of chunks) parts.push(u32(c.length), c);
  return concat(...parts);
}
export function unpack(b: Uint8Array): Uint8Array[] {
  const n = readU32(b, 0);
  const out: Uint8Array[] = [];
  let o = 4;
  for (let i = 0; i < n; i++) {
    if (o + 4 > b.length) throw new Error('Truncated');
    const len = readU32(b, o); o += 4;
    if (o + len > b.length) throw new Error('Truncated');
    out.push(b.slice(o, o + len)); o += len;
  }
  return out;
}

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts)));
}
