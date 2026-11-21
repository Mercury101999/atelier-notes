// End-to-end smoke test + screenshots against the production build. Run: npm run build && node scripts/screenshots.mjs [outDir]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] || 'screenshots';
mkdirSync(OUT, { recursive: true });
const server = spawn('node_modules/.bin/vite', ['preview', '--port', '4319', '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('4319') && r()));
const BASE = 'http://localhost:4319/';
const PASS = 'velvet harbor lantern 1999';
const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); console.log(`${cond ? '✓' : '✗'} ${msg}`); };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: false });
  const page = await ctx.newPage();
  const external = [];
  const errors = [];
  page.on('request', (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE);
  await page.waitForSelector('.piece canvas');
  await page.waitForTimeout(1200);
  check(!(await page.content()).match(/note|vault|passphrase|encrypt/i), 'gallery markup has no sign of notes');
  await page.screenshot({ path: `${OUT}/01-gallery-mobile.png` });

  // secret gesture: 3rd artwork, corners clockwise from top-left
  await page.locator('.piece').nth(2).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/02-viewer.png` });
  const art = await page.locator('.viewer-art').boundingBox();
  for (const [fx, fy] of [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]) {
    await page.mouse.click(art.x + art.width * fx, art.y + art.height * fy);
    await page.waitForTimeout(150);
  }
  await page.waitForSelector('.keypanel.setup', { timeout: 5000 });
  check(true, 'secret gesture reveals first-run setup');
  await page.fill('.keypanel.setup input >> nth=0', PASS);
  await page.fill('.keypanel.setup input >> nth=1', PASS);
  await page.screenshot({ path: `${OUT}/03-setup.png` });
  await page.click('.keypanel.setup button[type=submit]');
  await page.waitForSelector('.studio', { timeout: 20000 });
  check(true, 'vault created and opened');

  // collections
  const addFolder = async (name) => {
    await page.click('.fab');
    await page.locator('.menu button').nth(1).click();
    await page.fill('.modal input', name);
    await page.click('.modal button[type=submit]');
    await page.waitForTimeout(200);
  };
  await addFolder('Travel');
  await addFolder('Ideas');
  await addFolder('Journal');

  const addNote = async (title, body, tags, image) => {
    await page.click('.fab');
    await page.locator('.menu button').nth(0).click();
    await page.fill('.title-in', title);
    await page.fill('.body-in', body);
    await page.fill('.tags-in', tags);
    if (image) await page.setInputFiles('.sheet input[type=file][accept="image/*"]', image);
    if (image) await page.waitForSelector('.att img', { timeout: 8000 });
    await page.waitForTimeout(800);
  };
  await addNote('Lisbon itinerary', 'Day 1: Alfama, tram 28. Day 2: Belém.', 'travel, plans', 'public/icons/icon-512.png');
  await page.locator('.sheet .icon-btn[aria-label=Back]').click();
  await addNote('Passport numbers', 'SECRET-PASSPORT-4471', 'private', null);
  await page.locator('.chip.add').click();
  await page.locator('.modal .menu button').first().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/05-editor.png`, fullPage: false });
  await page.locator('.sheet .icon-btn[aria-label=Back]').click();
  await addNote('Studio ideas', 'Generative prints, risograph run.', 'ideas', null);
  await page.locator('.chip.add').click();
  await page.locator('.modal .menu button').first().click();
  await page.waitForTimeout(700);
  await page.locator('.sheet .icon-btn[aria-label=Back]').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/04-unlocked-collection.png` });

  // nested room
  await page.locator('.room').first().click();
  await addFolder('Portugal 2027');
  await page.locator('.crumb').first().click();

  // board
  await page.click('.actions .icon-btn[aria-label="Switch view"]');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/06-board.png` });
  await page.click('.actions .icon-btn[aria-label="Switch view"]');

  // search in memory
  await page.fill('.search', 'lisbon');
  await page.waitForTimeout(300);
  check((await page.locator('.work').count()) === 1, 'in-memory search finds 1 result');
  await page.fill('.search', '');

  // storage holds only ciphertext
  const leak = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('atelier-cache'); r.onsuccess = () => res(r.result); r.onerror = rej; });
    const all = await new Promise((res) => { const r = db.transaction('tiles').objectStore('tiles').getAll(); r.onsuccess = () => res(r.result); });
    const dec = new TextDecoder();
    const text = all.map((b) => dec.decode(b)).join('');
    return ['Lisbon', 'SECRET-PASSPORT', 'Travel', 'Portugal', 'itinerary', 'icon-512'].filter((w) => text.includes(w));
  });
  check(leak.length === 0, `IndexedDB contains no plaintext (${leak.join(',') || 'none found'})`);

  // settings screenshot
  await page.click('.actions .icon-btn[aria-label=Settings]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/07-settings.png` });
  // backup export as stego artwork (runs in a worker under the production CSP)
  const dl = page.waitForEvent('download', { timeout: 30000 });
  await page.getByText('Export as artwork').click();
  await page.fill('.modal input', PASS);
  await page.click('.modal button[type=submit]');
  const file = await dl;
  const pngPath = `${OUT}/backup-artwork-example.png`;
  await file.saveAs(pngPath);
  check(file.suggestedFilename().endsWith('.png'), `backup exported as artwork PNG (${file.suggestedFilename()})`);
  // restore that PNG into the same device (replace) and confirm notes survive
  await page.setInputFiles('.sheet input[type=file][accept="image/png,.atelier"]', pngPath);
  await page.locator('.modal button.danger').click();
  await page.fill('.modal input', PASS);
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.gallery', { timeout: 30000 });
  check(true, 'restore from artwork PNG completes and locks');
  await page.locator('.piece').nth(2).click();
  await page.waitForTimeout(500);
  const a3 = await page.locator('.viewer-art').boundingBox();
  for (const [fx, fy] of [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]) await page.mouse.click(a3.x + a3.width * fx, a3.y + a3.height * fy);
  await page.fill('.keypanel input', PASS);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.studio', { timeout: 20000 });
  await page.fill('.search', 'passport');
  await page.waitForTimeout(300);
  check((await page.locator('.work').count()) === 1, 'restored data is intact');
  await page.fill('.search', '');
  await page.click('.actions .icon-btn[aria-label=Settings]');
  await page.locator('.sheet .icon-btn[aria-label=Back]').click();

  // panic lock: Esc twice
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.gallery', { timeout: 3000 });
  check((await page.locator('.studio').count()) === 0, 'Esc Esc panic-locks back to the gallery');

  // wrong then right passphrase
  await page.locator('.piece').nth(2).click();
  await page.waitForTimeout(500);
  const art2 = await page.locator('.viewer-art').boundingBox();
  for (const [fx, fy] of [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]) await page.mouse.click(art2.x + art2.width * fx, art2.y + art2.height * fy);
  await page.waitForSelector('.keypanel input[type=password]');
  await page.waitForTimeout(700);
  if (process.env.DEBUG) console.log(await page.evaluate(() => { const v = document.querySelector('.viewer'); return JSON.stringify({ n: document.querySelectorAll('.viewer').length, op: getComputedStyle(v).opacity, anims: document.getAnimations().map((a) => [a.animationName, a.playState, a.currentTime, a.effect?.target?.className]) }); }));
  await page.screenshot({ path: `${OUT}/08-unlock-prompt.png` });
  await page.fill('.keypanel input', 'wrong guess');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  check((await page.locator('.studio').count()) === 0, 'wrong passphrase stays locked');
  await page.fill('.keypanel input', PASS);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.studio', { timeout: 20000 });
  check((await page.locator('.work, .room').count()) >= 3, 'right passphrase reopens collection');

  // visibility change auto-lock
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForSelector('.gallery', { timeout: 3000 });
  check(true, 'hiding the app auto-locks');

  // desktop gallery
  const d = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await d.goto(BASE); await d.waitForTimeout(1500);
  await d.screenshot({ path: `${OUT}/00-gallery-desktop.png` });

  check(external.length === 0, `no external network requests (${external.length})`);
  check(errors.length === 0, `no console errors ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);

  // offline: service worker installed; stop the server entirely and reload
  await page.goto(BASE);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(800);
  server.kill();
  await new Promise((r) => setTimeout(r, 800));
  await page.reload();
  check((await page.locator('.piece').count()) === 12, 'works offline with the server stopped (service worker)');
} finally {
  await browser.close();
  server.kill();
}
if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1); }
console.log('\nAll e2e checks passed');
