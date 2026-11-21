import { renderArt, type ArtOptions } from '../core/art.ts';

/**
 * Re-encodes an image through a canvas. Only pixels survive, so EXIF/GPS/camera metadata is dropped.
 * Orientation is applied first so the picture still looks right.
 */
export async function sanitizeImage(file: Blob, maxDim = 2560): Promise<{ bytes: Uint8Array; w: number; h: number; mime: string }> {
  let src: ImageBitmap | HTMLImageElement;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode(); src = img;
    } finally { URL.revokeObjectURL(url); }
  }
  const sw = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const sh = 'naturalHeight' in src ? src.naturalHeight : src.height;
  const k = Math.min(1, maxDim / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0, w, h);
  if ('close' in src) src.close();
  const keepAlpha = file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/gif';
  const mime = keepAlpha ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Encode failed'))), mime, 0.88));
  c.width = c.height = 0;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h, mime };
}

const artCache = new Map<string, ImageData>();
export function clearArtCache() { artCache.clear(); }

/** Paints deterministic generative art for `seed` into a canvas (cached). */
export function paintArt(canvas: HTMLCanvasElement, seed: string, w: number, h: number, opts: ArtOptions = {}) {
  canvas.width = w; canvas.height = h;
  const key = `${seed}|${w}x${h}|${opts.style ?? ''}|${opts.palette ?? ''}`;
  let img = artCache.get(key);
  if (!img) { img = new ImageData(renderArt(seed, w, h, opts), w, h); artCache.set(key, img); }
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  return canvas;
}

/** Paint lazily when the canvas scrolls into view. */
const io = typeof IntersectionObserver !== 'undefined'
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const c = e.target as HTMLCanvasElement & { _paint?: () => void };
        io!.unobserve(c);
        requestAnimationFrame(() => c._paint?.());
      }
    }, { rootMargin: '200px' })
  : null;

export function artCanvas(seed: string, w: number, h: number, opts: ArtOptions = {}, cls = 'art') {
  const c = document.createElement('canvas') as HTMLCanvasElement & { _paint?: () => void };
  c.className = cls; c.width = w; c.height = h;
  c._paint = () => paintArt(c, seed, w, h, opts);
  if (io) io.observe(c); else c._paint();
  return c;
}
