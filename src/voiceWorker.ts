/// <reference lib="webworker" />
// On-device speech recognition (Whisper tiny.en via transformers.js + ONNX Runtime WASM).
// Model and runtime files are served from this app's own origin; remote model loading is disabled.
import { env, pipeline } from '@huggingface/transformers';

export const MODEL_ID = 'whisper-tiny.en';
type Asr = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let asr: Promise<Asr> | null = null;
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

function load(base: string): Promise<Asr> {
  if (asr) return asr;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  // Must be a path (not a full URL) or transformers.js skips its local-file lookup.
  env.localModelPath = `${new URL(base).pathname}models/`;
  env.useBrowserCache = false; // the service worker caches model files for offline use
  env.useWasmCache = false;
  const wasm = env.backends.onnx.wasm!;
  wasm.numThreads = 1; // no cross-origin isolation on static hosting
  wasm.proxy = false;
  wasm.wasmPaths = { mjs: `${base}ort/ort-wasm-simd-threaded.mjs`, wasm: `${base}ort/ort-wasm-simd-threaded.wasm` };
  const files = new Map<string, { loaded: number; total: number }>();
  asr = pipeline('automatic-speech-recognition', MODEL_ID, {
    device: 'wasm',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.file && p.total) {
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
        let l = 0, t = 0;
        for (const f of files.values()) { l += f.loaded; t += f.total; }
        post({ type: 'progress', loaded: l, total: t });
      }
    },
  }) as unknown as Promise<Asr>;
  asr.catch(() => { asr = null; });
  return asr;
}

self.onmessage = async (e: MessageEvent) => {
  const { type, base, audio } = e.data as { type: 'load' | 'run'; base: string; audio?: Float32Array };
  try {
    const t0 = performance.now();
    const fn = await load(base);
    if (type === 'load') { post({ type: 'ready', ms: performance.now() - t0 }); return; }
    post({ type: 'transcribing' });
    const t1 = performance.now();
    const out = await fn(audio!, { chunk_length_s: 30, stride_length_s: 5 });
    const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
    post({ type: 'result', text, ms: performance.now() - t1, seconds: audio!.length / 16000 });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message || String(err) });
  } finally {
    audio?.fill(0); // release the audio copy held by the worker
  }
};
