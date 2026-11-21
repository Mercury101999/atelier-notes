import { describe, expect, it } from 'vitest';
import { randomBytes } from '../src/core/bytes.ts';
import { decodePng, encodePng } from '../src/core/png.ts';
import { embed, extract, hideInArtworks, revealFromArtworks } from '../src/core/stego.ts';
import { renderArt } from '../src/core/art.ts';

describe('png + steganography', () => {
  it('png codec is lossless', async () => {
    const px = renderArt('seed', 33, 21);
    const png = await encodePng(px, 33, 21, 'Test');
    const d = await decodePng(png);
    expect(d.w).toBe(33); expect(d.h).toBe(21);
    expect(Array.from(d.rgba)).toEqual(Array.from(px));
  });

  it('embed/extract raw pixels', () => {
    const px = renderArt('x', 64, 64);
    const data = randomBytes(1000);
    embed(px, data);
    expect(extract(px, 0, 1000)).toEqual(data);
    expect(extract(px, 10, 5)).toEqual(data.subarray(10, 15));
  });

  it('round-trips a payload through PNG artwork', async () => {
    const payload = randomBytes(50_000);
    const carriers = await hideInArtworks(payload, 'test');
    expect(carriers.length).toBe(1);
    expect(carriers[0].name.endsWith('.png')).toBe(true);
    expect(await revealFromArtworks(carriers.map((c) => c.png))).toEqual(payload);
  });

  it('splits large payloads across multiple images, any order', async () => {
    const payload = randomBytes(4_200_000);
    const carriers = await hideInArtworks(payload, 'big');
    expect(carriers.length).toBe(2);
    expect(await revealFromArtworks(carriers.map((c) => c.png).reverse())).toEqual(payload);
    await expect(revealFromArtworks([carriers[0].png])).rejects.toThrow(/Missing/);
  }, 60_000);

  it('rejects images without hidden data', async () => {
    const png = await encodePng(renderArt('plain', 32, 32), 32, 32);
    await expect(revealFromArtworks([png])).rejects.toThrow();
  });
});
