import type { Carrier } from '../core/stego.ts';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();

function w() {
  if (!worker) {
    worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = pending.get(id); pending.delete(id);
      if (ok) p?.res(result); else p?.rej(new Error(error));
    };
  }
  return worker;
}
function call<T>(op: string, data: unknown): Promise<T> {
  const id = ++seq;
  return new Promise<T>((res, rej) => { pending.set(id, { res: res as (v: unknown) => void, rej }); w().postMessage({ id, op, data }); });
}
export const hideInArtworksAsync = (payload: Uint8Array) => call<Carrier[]>('hide', payload);
export const revealFromArtworksAsync = (pngs: Uint8Array[]) => call<Uint8Array>('reveal', pngs);

/** Reads backup files: PNG artworks (stego) or a raw .atelier file. */
export async function readBackupFiles(files: FileList | File[]): Promise<Uint8Array> {
  const list = [...files];
  const bufs = await Promise.all(list.map(async (f) => new Uint8Array(await f.arrayBuffer())));
  const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const pngs = bufs.filter(isPng);
  if (pngs.length) return revealFromArtworksAsync(pngs);
  if (bufs.length !== 1) throw new Error('Choose one .atelier file or the artwork images');
  return bufs[0];
}
