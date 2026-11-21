import { describe, expect, it } from 'vitest';
import { applyCommands, applyEdits, applyRules, mergeChunks, peaks, postProcess, resample, tidy, wipe } from '../src/core/dictation.ts';

describe('dictation audio helpers', () => {
  it('merges chunks and zeroes them', () => {
    const a = new Float32Array([0.1, 0.2]), b = new Float32Array([0.3]);
    const chunks = [a, b];
    const m = mergeChunks(chunks);
    expect(Array.from(m).map((x) => +x.toFixed(2))).toEqual([0.1, 0.2, 0.3]);
    expect(a.every((x) => x === 0) && b.every((x) => x === 0)).toBe(true);
    expect(chunks.length).toBe(0);
    wipe(m);
    expect(m.every((x) => x === 0)).toBe(true);
  });

  it('resamples 48k -> 16k', () => {
    const x = new Float32Array(48000).map((_, i) => Math.sin(i / 10));
    const y = resample(x, 48000);
    expect(y.length).toBe(16000);
    expect(y[100]).toBeCloseTo(x[300], 5);
  });

  it('trims start/end and cuts middle segments', () => {
    const rate = 10;
    const audio = new Float32Array(100).map((_, i) => i); // 10 s
    const out = applyEdits(audio, { start: 1, end: 9 }, [{ start: 3, end: 4 }, { start: 6, end: 5 }], rate);
    expect(Array.from(out)).toEqual([...Array.from({ length: 20 }, (_, i) => 10 + i), ...Array.from({ length: 10 }, (_, i) => 40 + i), ...Array.from({ length: 30 }, (_, i) => 60 + i)]);
    expect(audio[50]).toBe(50); // input untouched
  });

  it('computes peaks', () => {
    const p = peaks(new Float32Array([0, -0.5, 0.2, 0.9]), 2);
    expect(Array.from(p)).toEqual([0.5, Float32Array.of(0.9)[0]]);
  });
});

describe('dictation text processing', () => {
  it('applies the custom dictionary (whole words, case-insensitive, longest first)', () => {
    const rules = [{ from: 'at a lea', to: 'Atelier' }, { from: 'jack', to: 'Jack' }, { from: 'jack son', to: 'Jackson' }];
    expect(applyRules('meet jack son at a lea, jack.', rules)).toBe('meet Jackson Atelier, Jack.');
    expect(applyRules('jackpot', rules)).toBe('jackpot');
  });

  it('turns spoken commands into punctuation and line breaks', () => {
    expect(tidy(applyCommands('Buy milk. New line. Call mum, new paragraph. Done period'))).toBe('Buy milk.\nCall mum\n\nDone.');
    expect(tidy(applyCommands('hello comma world question mark'))).toBe('Hello, world?');
  });

  it('full post-process with Whisper-style output', () => {
    const raw = ' [BLANK_AUDIO] remind me to email sam comma then new line pick up the prints from at a lea period';
    expect(postProcess(raw, [{ from: 'at a lea', to: 'Atelier' }, { from: 'sam', to: 'Sam' }], true))
      .toBe('Remind me to email Sam, then\nPick up the prints from Atelier.');
    expect(postProcess('a period of time', [], false)).toBe('A period of time');
  });
});
