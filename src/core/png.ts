/** Minimal lossless PNG codec (8-bit RGB/RGBA, non-interlaced) using the platform zlib streams. */
import { concat, u32, readU32, utf8 } from './bytes.ts';

const SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const td = concat(utf8.encode(type), data);
  return concat(u32(data.length), td, u32(crc32(td)));
}
async function zlib(data: Uint8Array, mode: 'compress' | 'decompress'): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(mode === 'compress' ? new CompressionStream('deflate') : new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, title?: string): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const parts = [SIG, chunk('IHDR', ihdr)];
  if (title) parts.push(chunk('tEXt', concat(utf8.encode('Title'), new Uint8Array([0]), utf8.encode(title))));
  parts.push(chunk('IDAT', await zlib(raw, 'compress')), chunk('IEND', new Uint8Array(0)));
  return concat(...parts);
}

export async function decodePng(png: Uint8Array): Promise<{ w: number; h: number; rgba: Uint8Array }> {
  for (let i = 0; i < 8; i++) if (png[i] !== SIG[i]) throw new Error('Not a PNG');
  let o = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  while (o < png.length) {
    const len = readU32(png, o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = readU32(data, 0); h = readU32(data, 4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace) throw new Error('Unsupported PNG format');
  const bpp = colorType === 6 ? 4 : 3;
  const raw = await zlib(concat(...idat), 'decompress');
  const stride = w * bpp;
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0;
      const b = y > 0 ? px[row - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[row - stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v & 0xff;
    }
  }
  if (bpp === 4) return { w, h, rgba: px };
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) { rgba[j] = px[i]; rgba[j + 1] = px[i + 1]; rgba[j + 2] = px[i + 2]; rgba[j + 3] = 255; }
  return { w, h, rgba };
}
