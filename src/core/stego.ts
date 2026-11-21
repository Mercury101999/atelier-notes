/**
 * Hides bytes in the 2 least-significant bits of each R,G,B channel of generated artwork,
 * then saves lossless PNGs. The payload is already AES-GCM ciphertext; this is concealment only.
 */
import { concat, equal, randomBytes, readU32, u32, utf8 } from './bytes.ts';
import { renderArt, titleFor } from './art.ts';
import { decodePng, encodePng } from './png.ts';

const BITS = 2;
const MAGIC = utf8.encode('AtL1');
const HDR = 24; // magic4 | set8 | part u16 | count u16 | total u32 | len u32
const MAX_W = 2048, MAX_H = 2560, MIN_W = 640, MIN_H = 800;

export const capacity = (w: number, h: number) => Math.floor((w * h * 3 * BITS) / 8);

export function embed(rgba: Uint8Array | Uint8ClampedArray, data: Uint8Array) {
  const px = rgba.length / 4;
  // Fill the whole LSB plane: payload first, then random bits, so there's no visible boundary.
  const total = Math.floor((px * 3 * BITS) / 8);
  if (data.length > total) throw new Error('Payload too large');
  const full = data.length === total ? data : concat(data, randomBytes(total - data.length));
  let ch = 0;
  const mask = (1 << BITS) - 1;
  for (let i = 0; i < full.length; i++) {
    const b = full[i];
    for (let s = 8 - BITS; s >= 0; s -= BITS) {
      if ((ch & 3) === 3) ch++; // skip alpha
      rgba[ch] = (rgba[ch] & ~mask) | ((b >> s) & mask);
      ch++;
    }
  }
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
}

export function extract(rgba: Uint8Array | Uint8ClampedArray, offset: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  const per = 8 / BITS;
  const mask = (1 << BITS) - 1;
  let slot = offset * per;
  let ch = Math.floor(slot / 3) * 4 + (slot % 3);
  for (let i = 0; i < n; i++) {
    let b = 0;
    for (let k = 0; k < per; k++) {
      if ((ch & 3) === 3) ch++;
      if (ch >= rgba.length) throw new Error('Truncated');
      b = (b << BITS) | (rgba[ch] & mask);
      ch++;
    }
    out[i] = b;
  }
  return out;
}

function dims(bytes: number): [number, number] {
  const px = Math.ceil((bytes * 8) / (3 * BITS));
  let w = Math.max(MIN_W, Math.ceil(Math.sqrt((px * 4) / 5)));
  w = Math.ceil(w / 16) * 16;
  const h = Math.max(MIN_H, Math.ceil(px / w));
  return [w, h];
}

export interface Carrier { name: string; png: Uint8Array }

/** Splits a payload over as many artworks as needed and returns PNG files. */
export async function hideInArtworks(payload: Uint8Array, seed = Math.random().toString(36)): Promise<Carrier[]> {
  const per = capacity(MAX_W, MAX_H) - HDR;
  const count = Math.max(1, Math.ceil(payload.length / per));
  const set = randomBytes(8);
  const out: Carrier[] = [];
  for (let p = 0; p < count; p++) {
    const part = payload.subarray(p * per, Math.min(payload.length, (p + 1) * per));
    const hdr = new Uint8Array(HDR);
    hdr.set(MAGIC, 0); hdr.set(set, 4);
    hdr[12] = p >> 8; hdr[13] = p & 255; hdr[14] = count >> 8; hdr[15] = count & 255;
    hdr.set(u32(payload.length), 16); hdr.set(u32(part.length), 20);
    const [w, h] = dims(HDR + part.length);
    const artSeed = `${seed}-${p}`;
    const rgba = renderArt(artSeed, w, h, { grain: 14 });
    embed(rgba, concat(hdr, part));
    const title = titleFor(artSeed);
    out.push({ name: `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}${count > 1 ? `-${p + 1}of${count}` : ''}.png`, png: await encodePng(rgba, w, h, title) });
  }
  return out;
}

/** Reads artworks back (any order) and reassembles the payload. */
export async function revealFromArtworks(pngs: Uint8Array[]): Promise<Uint8Array> {
  const parts: { set: Uint8Array; idx: number; count: number; total: number; data: Uint8Array }[] = [];
  for (const png of pngs) {
    const { rgba } = await decodePng(png);
    const hdr = extract(rgba, 0, HDR);
    if (!equal(hdr.subarray(0, 4), MAGIC)) continue;
    const len = readU32(hdr, 20);
    parts.push({ set: hdr.slice(4, 12), idx: (hdr[12] << 8) | hdr[13], count: (hdr[14] << 8) | hdr[15], total: readU32(hdr, 16), data: extract(rgba, HDR, len) });
  }
  if (!parts.length) throw new Error('No hidden data found in these images');
  const set = parts[0].set;
  const mine = parts.filter((p) => equal(p.set, set)).sort((a, b) => a.idx - b.idx);
  const count = mine[0].count;
  const unique = mine.filter((p, i) => i === 0 || p.idx !== mine[i - 1].idx);
  if (unique.length !== count) throw new Error(`Missing images: found ${unique.length} of ${count}`);
  const payload = concat(...unique.map((p) => p.data));
  if (payload.length !== mine[0].total) throw new Error('Damaged images');
  return payload;
}
