// End-to-end check of on-device voice typing with a fake microphone (tests/fixtures/jfk.wav).
// Run: npm run build && node scripts/e2e-voice.mjs [outDir] [baseUrl]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = process.argv[2] || 'screenshots';
const REMOTE = process.argv[3];
mkdirSync(OUT, { recursive: true });
let server = null;
if (!REMOTE) {
  server = spawn('node_modules/.bin/vite', ['preview', '--port', '4321', '--strictPort'], { stdio: 'pipe' });
  await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('4321') && r()));
}
const BASE = REMOTE || 'http://localhost:4321/';
const ORIGIN = new URL(BASE).origin;
const PASS = 'quiet orchard lantern 42';
const fails = [];
const check = (c, m) => { if (!c) fails.push(m); console.log(`${c ? '✓' : '✗'} ${m}`); };

// A persistent profile (like a real browser) so Cache Storage has a normal quota for the model.
const profile = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/atelier-voice-');
const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'], args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve('tests/fixtures/jfk.wav')}`, '--autoplay-policy=no-user-gesture-required'] });
const browser = ctx;
await ctx.addInitScript(() => {
  window.__streams = [];
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => { const s = await orig(c); window.__streams.push(s); return s; };
});
const page = ctx.pages()[0] ?? await ctx.newPage();
const external = [], errors = [];
page.on('request', (r) => { const u = r.url(); if (!u.startsWith(ORIGIN) && !u.startsWith('blob:') && !u.startsWith('data:')) external.push(u); });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (process.env.DEBUG) console.log('  [console]', m.type(), m.text().slice(0, 300)); if (m.type() === 'error') errors.push(m.text()); });
if (process.env.DEBUG) page.on('requestfailed', (r) => console.log('  [failed]', r.url(), r.failure()?.errorText));
if (process.env.DEBUG) page.on('response', (r) => { if (r.status() >= 400) console.log('  [http]', r.status(), r.url()); });

async function gestureUnlock(first) {
  await page.locator('.piece').nth(2).click();
  await page.waitForTimeout(500);
  const a = await page.locator('.viewer-art').boundingBox();
  for (const [x, y] of [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]) await page.mouse.click(a.x + a.width * x, a.y + a.height * y);
  if (first) {
    await page.fill('.keypanel.setup input >> nth=0', PASS);
    await page.fill('.keypanel.setup input >> nth=1', PASS);
    await page.click('.keypanel.setup button[type=submit]');
  } else {
    await page.fill('.keypanel input', PASS);
    await page.keyboard.press('Enter');
  }
  await page.waitForSelector('.studio', { timeout: 30000 });
}

async function dictate(shotPrefix) {
  await page.click('.mic');
  await page.waitForSelector('.rec', { timeout: 10000 });
  await page.waitForTimeout(+(process.env.REC_MS || 11800));
  if (shotPrefix) await page.screenshot({ path: `${OUT}/${shotPrefix}-recording.png` });
  await page.click('.stop-rec');
  await page.waitForSelector('canvas.wave');
  await page.waitForTimeout(300);
  // trim: drag the end handle slightly left, and cut nothing
  const w = await page.locator('canvas.wave').boundingBox();
  await page.mouse.move(w.x + w.width - 2, w.y + w.height / 2);
  await page.mouse.down(); await page.mouse.move(w.x + w.width * 0.97, w.y + w.height / 2, { steps: 4 }); await page.mouse.up();
  if (shotPrefix) await page.screenshot({ path: `${OUT}/${shotPrefix}-trim.png` });
  const t0 = Date.now();
  await page.click('.transcribe');
  const dbg = process.env.DEBUG ? setInterval(async () => console.log('  [ui]', (await page.locator('.voice-body').innerText().catch(() => '-')).slice(0,80), await page.locator('.toast').allInnerTexts()), 700) : 0;
  await page.waitForSelector('textarea.review', { timeout: 180000 }).finally(() => clearInterval(dbg));
  const wall = (Date.now() - t0) / 1000;
  if (shotPrefix) await page.screenshot({ path: `${OUT}/${shotPrefix}-review.png` });
  const text = await page.inputValue('textarea.review');
  const stat = await page.locator('.voice-body p.muted').first().textContent();
  return { text, wall, stat };
}

try {
  await page.goto(BASE);
  await page.waitForSelector('.piece canvas');
  check((await page.locator('.mic').count()) === 0, 'no mic/voice UI in the gallery');
  await gestureUnlock(true);

  // dictionary rule + commands on
  await page.click('.actions .icon-btn[aria-label=Settings]');
  await page.getByText('Add replacement').click();
  await page.fill('.dict-row input >> nth=0', 'country');
  await page.locator('.dict-row input').nth(0).press('Tab');
  await page.fill('.dict-row input >> nth=1', 'nation');
  await page.locator('.dict-row input').nth(1).press('Tab');
  await page.waitForTimeout(400);
  await page.locator('.sheet .icon-btn[aria-label=Back]').click();

  // new note + dictate
  await page.click('.fab');
  await page.locator('.menu button').nth(0).click();
  await page.fill('.title-in', 'Speech notes');
  await page.fill('.body-in', 'Draft:');
  await page.locator('.body-in').press('End');
  const first = await dictate('09-voice');
  console.log(`  transcript: ${JSON.stringify(first.text)}`);
  console.log(`  ${first.stat} (wall clock incl. first model load: ${first.wall.toFixed(1)} s)`);
  check(/what you can do for/i.test(first.text), 'Whisper transcribed the speech on-device');
  check(/nation/i.test(first.text) && !/country/i.test(first.text), 'custom dictionary applied (country → nation)');
  await page.fill('textarea.review', first.text + ' Edited in review.');
  await page.click('button.insert');
  await page.waitForTimeout(1200);
  const body = await page.inputValue('.body-in');
  check(body.startsWith('Draft: ') && body.includes('Edited in review.'), 'reviewed text inserted at the cursor');
  await page.screenshot({ path: `${OUT}/10-voice-inserted.png` });

  // storage: no plaintext, no audio anywhere
  const st = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('atelier-cache'); r.onsuccess = () => res(r.result); r.onerror = rej; });
    const all = await new Promise((res) => { const r = db.transaction('tiles').objectStore('tiles').getAll(); r.onsuccess = () => res(r.result); });
    const text = all.map((b) => new TextDecoder().decode(b)).join('');
    const cacheNames = await caches.keys();
    const urls = [];
    for (const n of cacheNames) for (const r of await (await caches.open(n)).keys()) urls.push(r.url);
    const ls = Object.keys(localStorage).length + Object.keys(sessionStorage).length;
    return { leak: /americans|fellow|nation|Edited in review/i.test(text), urls, ls, cacheNames };
  });
  check(!st.leak, 'transcript is stored only encrypted');
  check(st.urls.every((u) => /\/(models|ort)\/|\/assets\/|\/icons\/|manifest|pcm-worklet|\/$/.test(u)), 'Cache Storage holds only app/model files (no audio)');
  check(st.ls === 0, 'nothing in localStorage/sessionStorage');
  if (process.env.DEBUG) console.log('  caches', st.cacheNames, st.urls.filter((u) => /models|ort/.test(u)), await page.evaluate(() => !!navigator.serviceWorker.controller));
  check(st.urls.some((u) => u.includes('decoder_model_merged_quantized.onnx')), 'model cached for offline use');
  await page.locator('.sheet .icon-btn[aria-label=Back]').click();

  // lock during recording aborts and releases the mic
  const n = await page.locator('.work').count();
  await page.locator('.work').first().click();
  await page.click('.mic');
  await page.waitForSelector('.rec');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.waitForSelector('.gallery', { timeout: 4000 });
  const mic = await page.evaluate(() => ({ live: window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState !== 'ended').length, ui: document.querySelectorAll('.voice-wrap').length }));
  check(mic.live === 0 && mic.ui === 0, 'panic lock during recording stops the mic and discards the session');

  // lock during transcription aborts too
  await gestureUnlock(false);
  check((await page.locator('.work').count()) === n, 'notes intact after lock');
  await page.locator('.work').first().click();
  await page.click('.mic');
  await page.waitForSelector('.rec'); await page.waitForTimeout(3000);
  await page.click('.stop-rec'); await page.waitForSelector('canvas.wave');
  await page.click('.transcribe');
  await page.waitForTimeout(150);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForSelector('.gallery', { timeout: 4000 });
  check((await page.locator('.voice-wrap').count()) === 0, 'auto-lock (app hidden) during transcription discards the session');

  // offline: server gone, model from cache
  if (server) {
    await page.goto(BASE);
    await page.evaluate(() => navigator.serviceWorker.ready);
    server.kill(); server = null;
    await new Promise((r) => setTimeout(r, 800));
    await page.reload();
    await page.waitForSelector('.piece canvas');
    await gestureUnlock(false);
    await page.locator('.work').first().click();
    if (fails.length) throw new Error('skipping offline phase');
    const off = await dictate(null);
    console.log(`  offline: ${off.stat} (wall ${off.wall.toFixed(1)} s)`);
    check(/what you can do for/i.test(off.text), 'voice typing works fully offline (server stopped)');
    await page.click('.voice .icon-btn[aria-label=Discard]');
  }
  if (REMOTE) {
    // Remote: cut the network for everything the service worker doesn't serve, then dictate again.
    await ctx.route('**/*', (r) => r.abort());
    await page.reload();
    await page.waitForSelector('.piece canvas');
    await gestureUnlock(false);
    await page.locator('.work').first().click();
    const off = await dictate(null);
    console.log(`  offline: ${off.stat} (wall ${off.wall.toFixed(1)} s)`);
    check(/what you can do for/i.test(off.text), 'voice typing works with the network blocked (live site)');
    await page.click('.voice .icon-btn[aria-label=Discard]');
  }
  check(external.length === 0, `no requests to other origins (${external.length}${external.length ? ': ' + external.slice(0, 3).join(', ') : ''})`);
  const realErrors = errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_FAILED/.test(e));
  check(realErrors.length === 0, `no console errors ${realErrors.length ? JSON.stringify(realErrors.slice(0, 4)) : ''}`);
} catch (e) {
  fails.push(String(e)); console.error(e);
  await page.screenshot({ path: `${OUT}/voice-failure.png` }).catch(() => {});
} finally {
  await browser.close();
  server?.kill();
}
if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1); }
console.log('\nAll voice e2e checks passed');
