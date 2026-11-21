/** Deterministic generative art rendered into raw RGBA pixels (works in browser, worker and Node). */

export function hashSeed(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const PALETTES: RGB[][] = [
  ['#0f1a2b', '#1f4e5f', '#c9a227', '#e8d8b0', '#8c2f39'],
  ['#14110f', '#3a2e39', '#d4a373', '#faedcd', '#6b705c'],
  ['#0b132b', '#3a506b', '#5bc0be', '#f4f1de', '#e07a5f'],
  ['#1b1b1e', '#7d1538', '#d8973c', '#f2e3bc', '#2e4057'],
  ['#101419', '#476c9b', '#984447', '#e9d6b9', '#ad8a64'],
  ['#0d1b1e', '#2f5d50', '#b9a44c', '#f1e9da', '#c1666b'],
  ['#1a1423', '#3d314a', '#b56576', '#eaac8b', '#f6e7cb'],
  ['#111111', '#264653', '#2a9d8f', '#e9c46a', '#e76f51'],
  ['#161616', '#4a4e69', '#9a8c98', '#c9ada7', '#f2e9e4'],
  ['#0a0908', '#22333b', '#a9927d', '#eae0d5', '#5e503f'],
].map((p) => p.map(hex));

function makeNoise(r: () => number) {
  const perm = new Uint8Array(512);
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = new Float32Array(256);
  for (let i = 0; i < 256; i++) grad[i] = r() * 2 - 1;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const v00 = grad[perm[X + perm[Y]]], v10 = grad[perm[X + 1 + perm[Y]]];
    const v01 = grad[perm[X + perm[Y + 1]]], v11 = grad[perm[X + 1 + perm[Y + 1]]];
    const u = fade(xf), v = fade(yf);
    return (v00 + (v10 - v00) * u) * (1 - v) + (v01 + (v11 - v01) * u) * v;
  };
  return (x: number, y: number, oct = 4) => {
    let s = 0, a = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { s += a * noise(x * f, y * f); f *= 2.03; a *= 0.5; }
    return s;
  };
}

function samplePalette(p: RGB[], t: number, out: number[]) {
  t = Math.min(0.9999, Math.max(0, t)) * (p.length - 1);
  const i = Math.floor(t), f = t - i, s = f * f * (3 - 2 * f);
  const a = p[i], b = p[i + 1];
  out[0] = a[0] + (b[0] - a[0]) * s; out[1] = a[1] + (b[1] - a[1]) * s; out[2] = a[2] + (b[2] - a[2]) * s;
}

export const STYLES = ['warp', 'strata', 'orbits', 'mosaic', 'fields'] as const;
export type Style = (typeof STYLES)[number];

export interface ArtOptions { style?: Style; palette?: number; grain?: number }

export function artMeta(seed: string, opts: ArtOptions = {}) {
  const r = rng(hashSeed(seed));
  const style = opts.style ?? STYLES[Math.floor(r() * STYLES.length)];
  const palette = PALETTES[(opts.palette ?? Math.floor(r() * PALETTES.length)) % PALETTES.length];
  return { style, palette, r };
}

export function renderArt(seed: string, w: number, h: number, opts: ArtOptions = {}): Uint8ClampedArray {
  const { style, palette, r } = artMeta(seed, opts);
  const fbm = makeNoise(r);
  const out = new Uint8ClampedArray(w * h * 4);
  const scale = 2.2 + r() * 2.5;
  const ox = r() * 100, oy = r() * 100;
  const centers = [...Array(3)].map(() => [r(), r(), 8 + r() * 30] as const);
  const sites = [...Array(18 + Math.floor(r() * 30))].map(() => [r(), r(), r()] as const);
  const rects = [...Array(2 + Math.floor(r() * 2))].map((_, i, a) => [0.1 + r() * 0.05, (i / a.length) * 0.85 + 0.08, 0.9 - r() * 0.05, ((i + 1) / a.length) * 0.85 + 0.03, 0.15 + r() * 0.85] as const);
  const bands = 5 + Math.floor(r() * 9);
  const grain = opts.grain ?? 10;
  const c = [0, 0, 0];
  const asp = w / h;
  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const nx = u * scale * asp + ox, ny = v * scale + oy;
      let t: number;
      switch (style) {
        case 'warp': {
          const wx = nx * 0.45, wy = ny * 0.45;
          const qx = fbm(wx, wy, 3), qy = fbm(wx + 5.2, wy + 1.3, 3);
          const rx = fbm(wx + 2.2 * qx + 1.7, wy + 2.2 * qy + 9.2, 3), ry = fbm(wx + 2.2 * qx + 8.3, wy + 2.2 * qy + 2.8, 3);
          t = 0.5 + fbm(wx + 2.4 * rx, wy + 2.4 * ry, 5) * 1.25;
          break;
        }
        case 'strata': {
          const d = fbm(nx * 0.6, ny * 0.3, 5) * 0.35;
          t = Math.floor((v + d) * bands) / bands + fbm(nx * 3, ny * 3, 2) * 0.08;
          break;
        }
        case 'orbits': {
          let s = 0;
          for (const [cx, cy, f] of centers) s += Math.sin(Math.hypot((u - cx) * asp, v - cy) * f + fbm(nx, ny, 3) * 3);
          t = 0.5 + s / 6;
          break;
        }
        case 'mosaic': {
          let best = 9, second = 9, val = 0;
          const wu = u + fbm(nx, ny, 3) * 0.08, wv = v + fbm(nx + 3, ny + 3, 3) * 0.08;
          for (const [sx, sy, sv] of sites) {
            const d = Math.hypot((wu - sx) * asp, wv - sy);
            if (d < best) { second = best; best = d; val = sv; } else if (d < second) second = d;
          }
          t = val * 0.85 + Math.min(1, (second - best) * 40) * 0.15;
          break;
        }
        default: {
          t = 0.08 + fbm(nx * 2, ny * 2, 3) * 0.1;
          for (const [x0, y0, x1, y1, tv] of rects) {
            const e = 0.025 + fbm(nx * 4, ny * 4, 2) * 0.02;
            const m = Math.min(u - x0, x1 - u, v - y0, y1 - v);
            const k = Math.min(1, Math.max(0, (m + e) / (2 * e)));
            t = t * (1 - k) + (tv + fbm(nx * 1.5, ny * 1.5, 3) * 0.15) * k;
          }
        }
      }
      samplePalette(palette, t, c);
      const g = (r() - 0.5) * grain;
      const vig = 1 - 0.25 * ((u - 0.5) ** 2 + (v - 0.5) ** 2) * 2;
      const i = (y * w + x) * 4;
      out[i] = (c[0] + g) * vig; out[i + 1] = (c[1] + g) * vig; out[i + 2] = (c[2] + g) * vig; out[i + 3] = 255;
    }
  }
  return out;
}

const ADJ = ['Quiet', 'Ochre', 'Late', 'Saltwater', 'Velvet', 'Distant', 'Amber', 'Slow', 'Northern', 'Hollow', 'Gilded', 'Low'];
const NOUN = ['Harbor', 'Meridian', 'Garden', 'Tide', 'Chorus', 'Field', 'Nocturne', 'Study', 'Lantern', 'Orchard', 'Weather', 'Archive'];
export function titleFor(seed: string): string {
  const r = rng(hashSeed('t' + seed));
  return `${ADJ[Math.floor(r() * ADJ.length)]} ${NOUN[Math.floor(r() * NOUN.length)]}, No. ${1 + Math.floor(r() * 40)}`;
}
