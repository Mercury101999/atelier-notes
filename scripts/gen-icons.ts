// Generates app icons with the same generative-art engine. Run: node scripts/gen-icons.ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { renderArt } from '../src/core/art.ts';
import { encodePng } from '../src/core/png.ts';

mkdirSync('public/icons', { recursive: true });
async function icon(size: number, file: string, inset: number) {
  const art = renderArt('atelier-icon', size, size, { style: 'warp', palette: 0, grain: 6 });
  const out = new Uint8ClampedArray(size * size * 4);
  const bg = [12, 11, 10];
  const r = size * (0.5 - inset);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    // arched "gallery frame": square with rounded top
    const cx = x - size / 2, top = size * inset + r * 0.9, inside = Math.abs(cx) < r && y < size - size * inset && (y > top || Math.hypot(cx, y - top) < r);
    const src = inside ? art : null;
    out[i] = src ? src[i] : bg[0]; out[i + 1] = src ? src[i + 1] : bg[1]; out[i + 2] = src ? src[i + 2] : bg[2]; out[i + 3] = 255;
  }
  writeFileSync(`public/icons/${file}`, await encodePng(out, size, size));
}
await icon(192, 'icon-192.png', 0.12);
await icon(512, 'icon-512.png', 0.12);
await icon(512, 'icon-maskable-512.png', 0.2);
await icon(180, 'apple-touch-icon.png', 0.1);
console.log('icons written');
