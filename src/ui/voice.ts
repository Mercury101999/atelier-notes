/**
 * On-device voice typing: record -> trim/cut -> transcribe locally (Whisper) -> review -> insert.
 * Audio lives only in memory (Float32Arrays), is never written to storage, and is zeroed when the
 * text is accepted, when the session is discarded, or when the app locks.
 */
import { SAMPLE_RATE, applyEdits, mergeChunks, peaks, postProcess, resample, wipe, type Range, type Rule } from '../core/dictation.ts';
import { clear, h, icon, toast } from './dom.ts';
import type { LockGuard } from './lock.ts';

export const MODEL_FILES = [
  'models/whisper-tiny.en/onnx/encoder_model_quantized.onnx',
  'models/whisper-tiny.en/onnx/decoder_model_merged_quantized.onnx',
  'ort/ort-wasm-simd-threaded.wasm',
];
export const MODEL_LABEL = 'Whisper tiny.en (8-bit), ≈56 MB incl. runtime';
const MAX_SECONDS = 300;
const base = () => new URL('./', document.baseURI).href;

// ---- worker (model stays loaded while unlocked; terminated on lock/abort) ----
let worker: Worker | null = null;
type WorkerMsg = { type: 'progress'; loaded: number; total: number } | { type: 'ready'; ms: number } | { type: 'transcribing' } | { type: 'result'; text: string; ms: number; seconds: number } | { type: 'error'; message: string };
let listener: ((m: WorkerMsg) => void) | null = null;
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../voiceWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => listener?.(e.data as WorkerMsg);
    worker.onerror = (e) => listener?.({ type: 'error', message: e.message || 'Voice engine failed to start' });
  }
  return worker;
}
function killWorker() { worker?.terminate(); worker = null; listener = null; }

/** Downloads/loads the model (used by Settings "download for offline"). */
export function prepareModel(onProgress: (frac: number) => void): Promise<number> {
  return new Promise((res, rej) => {
    listener = (m) => {
      if (m.type === 'progress') onProgress(m.total ? m.loaded / m.total : 0);
      else if (m.type === 'ready') { listener = null; res(m.ms); }
      else if (m.type === 'error') { listener = null; rej(new Error(m.message)); }
    };
    getWorker().postMessage({ type: 'load', base: base() });
  });
}

export async function modelCached(): Promise<boolean> {
  if (!('caches' in self)) return false;
  for (const f of MODEL_FILES) if (!(await caches.match(new URL(f, base()).href))) return false;
  return true;
}
export async function removeModel() {
  killWorker();
  await caches.delete('atelier-voice-v1');
}

export const voiceSupported = () => (typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined');

// ---- session ----
let active: VoiceSession | null = null;
/** Called on lock / panic: stops the mic, kills transcription, zeroes audio, removes UI. */
export function abortVoice() { active?.destroy(); active = null; killWorker(); }

interface Opts { rules: Rule[]; commands: boolean; guard: LockGuard; onInsert: (text: string) => void }

export function openVoice(opts: Opts) {
  if (!voiceSupported()) { toast('Voice typing isn’t supported in this browser'); return; }
  active?.destroy();
  active = new VoiceSession(opts);
}

class VoiceSession {
  private el: HTMLElement;
  private body: HTMLElement;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private audio: Float32Array | null = null; // 16 kHz mono, memory only
  private keep: Range = { start: 0, end: 0 };
  private cuts: Range[] = [];
  private timer = 0;
  private dead = false;
  private player: { ctx: AudioContext; buf: AudioBuffer; src: AudioBufferSourceNode } | null = null;

  constructor(private o: Opts) {
    this.body = h('div', { class: 'voice-body' });
    this.el = h('div', { class: 'modal-wrap voice-wrap' },
      h('div', { class: 'modal voice', role: 'dialog', 'aria-label': 'Voice typing' },
        h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Voice typing'),
          h('button', { class: 'icon-btn', 'aria-label': 'Discard', onclick: () => this.close() }, icon('close'))),
        this.body,
        h('p', { class: 'muted small voice-note' }, 'Transcribed on this device. Audio stays in memory only and is erased when you finish.')));
    document.body.append(this.el);
    void this.record();
  }

  private close() { this.destroy(); if (active === this) active = null; }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    clearInterval(this.timer);
    this.stopMic();
    this.stopPreview();
    for (const c of this.chunks) c.fill(0);
    this.chunks.length = 0;
    wipe(this.audio); this.audio = null;
    this.el.remove();
  }

  private stopMic() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try { this.node?.disconnect(); } catch { /* ignore */ }
    this.node = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  // ---------- 1. record ----------
  private async record() {
    clear(this.body);
    const status = h('p', { class: 'muted' }, 'Waiting for microphone…');
    this.body.append(status);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.dead) { this.stopMic(); return; }
      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule(new URL('pcm-worklet.js', base()).href);
      if (this.dead) return;
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
      const mute = this.ctx.createGain(); mute.gain.value = 0;
      src.connect(this.node); this.node.connect(mute); mute.connect(this.ctx.destination);
    } catch (e) {
      this.stopMic();
      clear(this.body);
      this.body.append(h('p', {}, (e as Error).name === 'NotAllowedError' ? 'Microphone permission was denied.' : `Couldn’t start the microphone: ${(e as Error).message}`),
        h('div', { class: 'row end' }, h('button', { onclick: () => this.close() }, 'Close')));
      return;
    }
    const rate = this.ctx.sampleRate;
    let samples = 0;
    const level = h('div', { class: 'level' }, h('span', {}));
    const clock = h('span', { class: 'clock' }, '0:00');
    this.node.port.onmessage = (e) => {
      if (!(e.data instanceof Float32Array)) return;
      this.chunks.push(e.data);
      samples += e.data.length;
      let s = 0; for (let i = 0; i < e.data.length; i++) s += e.data[i] * e.data[i];
      (level.firstChild as HTMLElement).style.width = `${Math.min(100, Math.sqrt(s / e.data.length) * 400)}%`;
    };
    const start = performance.now();
    this.timer = window.setInterval(() => {
      const t = (performance.now() - start) / 1000;
      clock.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
      this.o.guard.reset(); // speaking counts as activity
      if (t >= MAX_SECONDS) void stop();
    }, 250);
    const stop = async () => {
      clearInterval(this.timer);
      const node = this.node;
      if (!node) return;
      await new Promise<void>((res) => {
        const prev = node.port.onmessage;
        node.port.onmessage = (e) => { if (e.data === 'flushed') res(); else prev?.call(node.port, e); };
        node.port.postMessage('flush');
        setTimeout(res, 500);
      });
      this.stopMic();
      if (this.dead) return;
      const raw = mergeChunks(this.chunks);
      this.audio = resample(raw, rate, SAMPLE_RATE);
      wipe(raw);
      if (this.audio.length < SAMPLE_RATE * 0.3) { wipe(this.audio); this.audio = null; toast('Nothing recorded'); void this.record(); return; }
      this.keep = { start: 0, end: this.audio.length / SAMPLE_RATE };
      this.cuts = [];
      this.trim();
    };
    clear(this.body);
    this.body.append(
      h('div', { class: 'rec' }, h('span', { class: 'rec-dot' }), h('span', {}, 'Recording'), clock),
      level,
      h('div', { class: 'row end' },
        h('button', { class: 'ghost', onclick: () => this.close() }, 'Cancel'),
        h('button', { class: 'stop-rec', onclick: () => void stop() }, 'Stop')));
  }

  // ---------- 2. trim / cut ----------
  private trim() {
    if (!this.audio) return;
    clear(this.body);
    const audio = this.audio;
    const dur = audio.length / SAMPLE_RATE;
    const canvas = h('canvas', { class: 'wave', 'aria-label': 'Recording waveform. Drag the handles to trim; drag across the middle to select a part to cut.' });
    const info = h('p', { class: 'muted small' });
    let sel: Range | null = null;
    const cutBtn = h('button', { class: 'ghost', disabled: true, onclick: () => { if (sel) { this.cuts.push(sel); sel = null; draw(); } } }, 'Cut selection');
    const undoBtn = h('button', { class: 'ghost', onclick: () => { this.cuts.pop(); draw(); } }, 'Undo cut');
    const playBtn = h('button', { class: 'ghost', onclick: () => this.player ? this.stopPreview(playBtn) : this.preview(playBtn) }, 'Play');
    const dpr = Math.min(2, devicePixelRatio || 1);
    let pk: Float32Array | null = null;
    const X = (t: number) => (t / dur) * canvas.width;
    const T = (clientX: number) => { const r = canvas.getBoundingClientRect(); return Math.max(0, Math.min(dur, ((clientX - r.left) / r.width) * dur)); };
    const draw = () => {
      const W = canvas.clientWidth * dpr || 600, H = 120 * dpr;
      if (canvas.width !== W) { canvas.width = W; canvas.height = H; pk = peaks(audio, Math.floor(W / (2 * dpr))); }
      if (!pk) pk = peaks(audio, Math.floor(W / (2 * dpr)));
      const g = canvas.getContext('2d')!;
      g.clearRect(0, 0, W, H);
      const bw = W / pk.length;
      for (let i = 0; i < pk.length; i++) {
        const t = ((i + 0.5) / pk.length) * dur;
        const kept = t >= this.keep.start && t <= this.keep.end && !this.cuts.some((c) => t >= Math.min(c.start, c.end) && t <= Math.max(c.start, c.end));
        const v = Math.max(1.5 * dpr, pk[i] * H * 0.9);
        g.fillStyle = kept ? '#e8d8b0' : 'rgba(232,216,176,0.18)';
        g.fillRect(i * bw + bw * 0.15, (H - v) / 2, bw * 0.7, v);
      }
      for (const c of this.cuts) { g.fillStyle = 'rgba(180,71,63,0.25)'; g.fillRect(X(Math.min(c.start, c.end)), 0, X(Math.abs(c.end - c.start)), H); }
      if (sel) { g.fillStyle = 'rgba(201,162,39,0.28)'; g.fillRect(X(Math.min(sel.start, sel.end)), 0, X(Math.abs(sel.end - sel.start)), H); }
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(0, 0, X(this.keep.start), H); g.fillRect(X(this.keep.end), 0, W - X(this.keep.end), H);
      for (const t of [this.keep.start, this.keep.end]) {
        g.fillStyle = '#c9a227'; g.fillRect(X(t) - 1.5 * dpr, 0, 3 * dpr, H);
        g.beginPath(); g.arc(X(t), H / 2, 7 * dpr, 0, Math.PI * 2); g.fill();
      }
      const kept = applyEditsLength(this.keep, this.cuts);
      info.textContent = `Keeping ${kept.toFixed(1)} s of ${dur.toFixed(1)} s${this.cuts.length ? ` · ${this.cuts.length} cut${this.cuts.length > 1 ? 's' : ''}` : ''}`;
      cutBtn.disabled = !sel || Math.abs(sel.end - sel.start) < 0.05;
      undoBtn.disabled = !this.cuts.length;
    };
    let drag: 'start' | 'end' | 'sel' | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const t = T(e.clientX);
      const tol = (16 / canvas.getBoundingClientRect().width) * dur;
      if (Math.abs(t - this.keep.start) < tol) drag = 'start';
      else if (Math.abs(t - this.keep.end) < tol) drag = 'end';
      else { drag = 'sel'; sel = { start: t, end: t }; }
      draw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const t = T(e.clientX);
      if (drag === 'start') this.keep.start = Math.min(t, this.keep.end - 0.2);
      else if (drag === 'end') this.keep.end = Math.max(t, this.keep.start + 0.2);
      else if (sel) sel.end = t;
      draw();
    });
    canvas.addEventListener('pointerup', () => { if (drag === 'sel' && sel && Math.abs(sel.end - sel.start) < 0.05) sel = null; drag = null; draw(); });
    this.body.append(
      canvas, info,
      h('p', { class: 'muted small' }, 'Drag the gold handles to trim the start and end. Drag across the middle to select a part, then Cut it.'),
      h('div', { class: 'row wrap' }, playBtn, cutBtn, undoBtn),
      h('div', { class: 'row end wrap' },
        h('button', { class: 'ghost', onclick: () => { this.stopPreview(); wipe(this.audio); this.audio = null; void this.record(); } }, 'Re-record'),
        h('button', { class: 'transcribe', onclick: () => { this.stopPreview(); void this.transcribe(); } }, 'Transcribe')));
    requestAnimationFrame(draw);
  }

  private preview(btn: HTMLButtonElement) {
    if (!this.audio) return;
    const pcm = applyEdits(this.audio, this.keep, this.cuts);
    if (!pcm.length) { wipe(pcm); return; }
    const ctx = new AudioContext();
    const buf = ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
    buf.copyToChannel(pcm, 0);
    wipe(pcm);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start();
    src.onended = () => this.stopPreview(btn);
    this.player = { ctx, buf, src };
    btn.textContent = 'Stop';
  }
  private stopPreview(btn?: HTMLButtonElement) {
    const p = this.player;
    if (!p) return;
    this.player = null;
    try { p.src.onended = null; p.src.stop(); } catch { /* ended */ }
    p.buf.getChannelData(0).fill(0);
    void p.ctx.close().catch(() => {});
    if (btn) btn.textContent = 'Play';
  }

  // ---------- 3. transcribe ----------
  private async transcribe() {
    if (!this.audio) return;
    clear(this.body);
    const label = h('p', {}, 'Loading voice model…');
    const bar = h('div', { class: 'progress' }, h('span', {}));
    const sub = h('p', { class: 'muted small' }, 'First use downloads the model from this app’s own site, then it works offline.');
    this.body.append(label, bar, sub,
      h('div', { class: 'row end' }, h('button', { class: 'ghost', onclick: () => { killWorker(); this.trim(); } }, 'Cancel')));
    const clip = applyEdits(this.audio, this.keep, this.cuts);
    if (!clip.length) { wipe(clip); this.trim(); return; }
    const fill = bar.firstChild as HTMLElement;
    listener = (m) => {
      if (this.dead) return;
      if (m.type === 'progress') { const f = m.total ? m.loaded / m.total : 0; fill.style.width = `${Math.round(f * 100)}%`; label.textContent = `Downloading voice model… ${Math.round(f * 100)}%`; }
      else if (m.type === 'transcribing') { label.textContent = 'Transcribing on this device…'; bar.classList.add('indeterminate'); fill.style.width = '35%'; sub.textContent = `${(clip.length / SAMPLE_RATE).toFixed(1)} s of audio`; }
      else if (m.type === 'result') { listener = null; this.review(m.text, m.ms, m.seconds); }
      else if (m.type === 'error') { listener = null; toast(`Transcription failed: ${m.message}`); this.trim(); }
    };
    // Transfer (move) the clip to the worker; it zeroes it after use.
    getWorker().postMessage({ type: 'run', base: base(), audio: clip }, [clip.buffer]);
  }

  // ---------- 4. review ----------
  private review(raw: string, ms: number, seconds: number) {
    clear(this.body);
    const text = postProcess(raw, this.o.rules, this.o.commands);
    const ta = h('textarea', { class: 'review', 'aria-label': 'Transcript' });
    ta.value = text;
    const showRaw = h('details', { class: 'muted small' }, h('summary', {}, 'Original transcript'), h('p', {}, raw.trim() || '(nothing recognised)'));
    this.body.append(
      h('p', { class: 'muted small' }, `Transcribed ${seconds.toFixed(1)} s in ${(ms / 1000).toFixed(1)} s. Edit before inserting.`),
      ta, showRaw,
      h('div', { class: 'row end wrap' },
        h('button', { class: 'ghost', onclick: () => this.trim() }, 'Back to trim'),
        h('button', { class: 'ghost', onclick: () => this.close() }, 'Discard'),
        h('button', { class: 'insert', onclick: () => { const t = ta.value.trim(); this.close(); if (t) this.o.onInsert(t); } }, 'Insert')));
    ta.focus();
  }
}

function applyEditsLength(keep: Range, cuts: Range[]) {
  let total = keep.end - keep.start;
  // merge overlapping cuts inside keep
  const cs = cuts.map((c) => [Math.max(keep.start, Math.min(c.start, c.end)), Math.min(keep.end, Math.max(c.start, c.end))]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let cur = keep.start;
  for (const [a, b] of cs) { const s = Math.max(a, cur); if (b > s) total -= b - s; cur = Math.max(cur, b); }
  return Math.max(0, total);
}
