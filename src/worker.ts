/// <reference lib="webworker" />
import { hideInArtworks, revealFromArtworks } from './core/stego.ts';

self.onmessage = async (e: MessageEvent) => {
  const { id, op, data } = e.data as { id: number; op: 'hide' | 'reveal'; data: Uint8Array | Uint8Array[] };
  try {
    if (op === 'hide') {
      const carriers = await hideInArtworks(data as Uint8Array);
      (self as unknown as Worker).postMessage({ id, ok: true, result: carriers }, carriers.map((c) => c.png.buffer as ArrayBuffer));
    } else {
      const payload = await revealFromArtworks(data as Uint8Array[]);
      (self as unknown as Worker).postMessage({ id, ok: true, result: payload }, [payload.buffer as ArrayBuffer]);
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (err as Error).message });
  }
};
