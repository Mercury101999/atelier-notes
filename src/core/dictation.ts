/** Pure helpers for on-device dictation: audio buffers (in memory only) and text post-processing. */

export const SAMPLE_RATE = 16_000;

/** Overwrites float buffers with zeros (best effort "secure" release). */
export function wipe(...arrays: (Float32Array | null | undefined)[]) {
  for (const a of arrays) if (a && a.buffer.byteLength) a.fill(0);
}

/** Joins captured chunks into one buffer and zeroes the chunks. */
export function mergeChunks(chunks: Float32Array[]): Float32Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; c.fill(0); }
  chunks.length = 0;
  return out;
}

/** Linear-interpolation resampler to 16 kHz (Whisper's input rate). */
export function resample(input: Float32Array, fromRate: number, toRate = SAMPLE_RATE): Float32Array {
  if (fromRate === toRate) return input.slice();
  const ratio = fromRate / toRate;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, i0 = Math.floor(x), f = x - i0;
    const a = input[i0], b = i0 + 1 < input.length ? input[i0 + 1] : a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

export interface Range { start: number; end: number } // seconds

/** Keeps [keep.start, keep.end] minus the cut ranges. Returns a new buffer; the input is untouched. */
export function applyEdits(audio: Float32Array, keep: Range, cuts: Range[], rate = SAMPLE_RATE): Float32Array {
  const s0 = Math.max(0, Math.floor(keep.start * rate)), s1 = Math.min(audio.length, Math.ceil(keep.end * rate));
  const segs: [number, number][] = [];
  const sorted = cuts.map((c) => [Math.max(s0, Math.floor(Math.min(c.start, c.end) * rate)), Math.min(s1, Math.ceil(Math.max(c.start, c.end) * rate))] as [number, number])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let cur = s0;
  for (const [a, b] of sorted) { if (a > cur) segs.push([cur, a]); cur = Math.max(cur, b); }
  if (s1 > cur) segs.push([cur, s1]);
  const out = new Float32Array(segs.reduce((n, [a, b]) => n + b - a, 0));
  let o = 0;
  for (const [a, b] of segs) { out.set(audio.subarray(a, b), o); o += b - a; }
  return out;
}

/** Peak envelope for drawing a waveform. */
export function peaks(audio: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(buckets);
  const per = audio.length / buckets;
  for (let i = 0; i < buckets; i++) {
    let m = 0;
    const a = Math.floor(i * per), b = Math.min(audio.length, Math.floor((i + 1) * per));
    for (let j = a; j < b; j++) { const v = Math.abs(audio[j]); if (v > m) m = v; }
    out[i] = m;
  }
  return out;
}

export interface Rule { from: string; to: string }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** User dictionary: whole-word/phrase, case-insensitive. Longer phrases first. */
export function applyRules(text: string, rules: Rule[]): string {
  const list = rules.filter((r) => r.from.trim()).sort((a, b) => b.from.length - a.from.length);
  for (const r of list) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(r.from.trim()).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
    text = text.replace(re, r.to);
  }
  return text;
}

// Spoken commands. Whisper usually adds its own punctuation around them ("New line."), so swallow it.
const P = `[\\s,.;:!?]*`;
const COMMANDS: [RegExp, string][] = [
  [new RegExp(`[\\s,]*\\bnew paragraph\\b${P}`, 'gi'), '\n\n'],
  [new RegExp(`[\\s,]*\\b(?:new line|next line|line break)\\b${P}`, 'gi'), '\n'],
  [new RegExp(`[\\s,]*\\b(?:period|full stop)\\b[\\s,.]*`, 'gi'), '. '],
  [new RegExp(`[\\s,]*\\bcomma\\b[\\s,.]*`, 'gi'), ', '],
  [new RegExp(`[\\s,]*\\bquestion mark\\b[\\s,.?]*`, 'gi'), '? '],
  [new RegExp(`[\\s,]*\\bexclamation (?:mark|point)\\b[\\s,.!]*`, 'gi'), '! '],
  [new RegExp(`[\\s,]*\\bsemicolon\\b[\\s,.]*`, 'gi'), '; '],
  [new RegExp(`[\\s,]*\\bcolon\\b[\\s,.]*`, 'gi'), ': '],
  [new RegExp(`[\\s,]*\\b(?:dash|hyphen)\\b[\\s,.]*`, 'gi'), ' - '],
  [new RegExp(`[\\s,]*\\bopen quote\\b[\\s,.]*`, 'gi'), ' "'],
  [new RegExp(`[\\s,]*\\bclose quote\\b[\\s,.]*`, 'gi'), '" '],
];

export function applyCommands(text: string): string {
  for (const [re, rep] of COMMANDS) text = text.replace(re, rep);
  return text;
}

/** Spacing and capitalisation cleanup. */
export function tidy(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/([,;:])(?=[^\s\n"])/g, '$1 ')
    .replace(/([.!?])\1+/g, '$1')
    .replace(/[,;:]+([.!?])/g, '$1')
    .replace(/ *\n */g, '\n')
    .replace(/(^|[.!?]\s+|\n)(["(]?)(\p{Ll})/gu, (_, a, q, c) => a + q + c.toUpperCase())
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function postProcess(raw: string, rules: Rule[], commands: boolean): string {
  let t = raw.replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|INAUDIBLE)\]|\((?:music|silence)\)/gi, ' ').trim();
  t = applyRules(t, rules);
  if (commands) t = applyCommands(t);
  return tidy(t);
}
