import { STYLES, type Style } from '../core/art.ts';
import type { Store } from '../core/store.ts';
import { createVault, gestureMatches, hasVault, importBackup, unlockVault, type Vault } from '../core/vault.ts';
import { clear, h, icon, toast } from './dom.ts';
import { artCanvas, paintArt } from './media.ts';
import { readBackupFiles } from './stegoClient.ts';

const TITLES = ['Quiet Harbor', 'Ochre Meridian', 'Nocturne for Salt', 'Study in Late Light', 'Velvet Weather', 'Distant Orchard',
  'Amber Chorus', 'Low Tide Archive', 'Northern Lantern', 'Hollow Garden', 'Gilded Field', 'Slow Meridian II'];
const MEDIUM: Record<Style, string> = {
  warp: 'Domain-warped pigment, generative',
  strata: 'Layered strata, generative',
  orbits: 'Interference study, generative',
  mosaic: 'Cellular mosaic, generative',
  fields: 'Colour fields, generative',
};
export const EXHIBIT = TITLES.map((title, i) => ({
  title,
  seed: `atelier-exhibit-${i}`,
  style: STYLES[(i * 3 + 1) % STYLES.length] as Style,
  palette: (i * 7) % 10,
  year: 2026 - (i % 3),
}));

export interface GalleryCtx { store: Store; onUnlocked: (v: Vault) => void }

export function showGallery(root: HTMLElement, ctx: GalleryCtx) {
  clear(root);
  document.title = 'Atelier';
  const wall = h('section', { class: 'wall' },
    EXHIBIT.map((a, i) => h('button', { class: 'piece', 'aria-label': `View ${a.title}`, onclick: () => openViewer(root, ctx, i) },
      h('div', { class: 'frame' }, artCanvas(a.seed, 300, 375, { style: a.style, palette: a.palette })),
      h('div', { class: 'label' }, h('span', { class: 'title' }, a.title), h('span', { class: 'medium' }, `${MEDIUM[a.style]}, ${a.year}`)))));
  root.append(h('main', { class: 'gallery' },
    h('header', { class: 'gallery-head' },
      h('h1', {}, 'Atelier'),
      h('p', {}, 'A small collection of generative works'),
      h('p', { class: 'exhibit' }, 'Winter Exhibition · Room I')),
    wall,
    h('footer', { class: 'gallery-foot' }, 'Every work is generated on this device. Nothing leaves it.')));
}

function openViewer(root: HTMLElement, ctx: GalleryCtx, start: number) {
  let idx = start;
  let taps: number[] = [];
  let lastTap = 0;
  const canvas = h('canvas', { class: 'viewer-art' });
  const title = h('h2', {});
  const medium = h('p', { class: 'medium' });
  const fig = h('figure', { class: 'viewer-fig' }, canvas, h('figcaption', {}, title, medium));
  const close = () => { view.remove(); removeEventListener('keydown', onKey); };
  const go = (d: number) => { idx = (idx + d + EXHIBIT.length) % EXHIBIT.length; taps = []; draw(); };
  const view = h('div', { class: 'viewer', role: 'dialog', 'aria-label': 'Artwork' },
    h('button', { class: 'icon-btn viewer-close', 'aria-label': 'Close', onclick: close }, icon('close')),
    h('button', { class: 'icon-btn viewer-prev', 'aria-label': 'Previous', onclick: () => go(-1) }, icon('left')),
    fig,
    h('button', { class: 'icon-btn viewer-next', 'aria-label': 'Next', onclick: () => go(1) }, icon('right')));
  const onKey = (e: KeyboardEvent) => {
    if (view.querySelector('.keypanel')) return;
    if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1);
  };
  addEventListener('keydown', onKey);
  function draw() {
    const a = EXHIBIT[idx];
    title.textContent = a.title;
    medium.textContent = `${MEDIUM[a.style]}, ${a.year}`;
    requestAnimationFrame(() => paintArt(canvas, a.seed, 640, 800, { style: a.style, palette: a.palette }));
  }
  // Secret gesture: taps on a 3x3 grid over the artwork.
  let down: { x: number; y: number } | null = null;
  let sx = 0;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; sx = e.clientX; });
  canvas.addEventListener('pointerup', async (e) => {
    if (!down) return;
    const dx = e.clientX - sx;
    if (Math.abs(dx) > 60) { go(dx < 0 ? 1 : -1); down = null; return; }
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) { down = null; return; }
    down = null;
    const r = canvas.getBoundingClientRect();
    const cell = Math.min(2, Math.floor(((e.clientX - r.left) / r.width) * 3)) + 3 * Math.min(2, Math.floor(((e.clientY - r.top) / r.height) * 3));
    const now = performance.now();
    if (now - lastTap > 3000) taps = [];
    lastTap = now;
    taps.push(cell);
    if (taps.length > 12) taps.shift();
    const snap = taps.slice(), art = idx;
    if (await gestureMatches(ctx.store, art, snap)) { taps = []; showKeyPanel(view, ctx); }
  });
  root.append(view);
  draw();
}

function showKeyPanel(view: HTMLElement, ctx: GalleryCtx) {
  if (view.querySelector('.keypanel') || view.dataset.opening) return;
  view.dataset.opening = '1';
  void hasVault(ctx.store).then((exists) => {
    delete view.dataset.opening;
    const panel = exists ? unlockPanel(ctx, () => panel.remove()) : setupPanel(ctx, () => panel.remove());
    view.append(panel);
    (panel.querySelector('input') as HTMLInputElement | null)?.focus();
  });
}

function unlockPanel(ctx: GalleryCtx, dismiss: () => void) {
  const input = h('input', { type: 'password', placeholder: "Collector's key", autocomplete: 'off', spellcheck: false, 'aria-label': 'Key' });
  const btn = h('button', { type: 'submit', class: 'ghost' }, 'Enter');
  const form = h('form', {
    class: 'keypanel',
    onsubmit: async (e: Event) => {
      e.preventDefault();
      if (!input.value) return;
      btn.disabled = true; input.disabled = true; form.classList.add('busy');
      const v = await unlockVault(ctx.store, input.value).catch(() => null);
      input.value = '';
      if (v) { ctx.onUnlocked(v); return; }
      btn.disabled = false; input.disabled = false; form.classList.remove('busy');
      form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
      input.focus();
    },
    onkeydown: (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); },
  }, input, btn, h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: dismiss }, icon('close')));
  return form;
}

function setupPanel(ctx: GalleryCtx, dismiss: () => void) {
  const p1 = h('input', { type: 'password', placeholder: 'Passphrase (12+ characters)', autocomplete: 'new-password' });
  const p2 = h('input', { type: 'password', placeholder: 'Repeat passphrase', autocomplete: 'new-password' });
  const msg = h('p', { class: 'muted small' }, 'There is no recovery. If you forget this passphrase, everything inside is gone for good.');
  const btn = h('button', { type: 'submit' }, 'Begin');
  const fileIn = h('input', { type: 'file', accept: 'image/png,.atelier', multiple: true, hidden: true });
  fileIn.addEventListener('change', async () => {
    if (!fileIn.files?.length) return;
    try {
      msg.textContent = 'Reading backup…';
      const payload = await readBackupFiles(fileIn.files);
      const pass = p1.value || prompt('Passphrase used for that backup') || '';
      msg.textContent = 'Restoring…';
      await importBackup(ctx.store, payload, pass);
      const v = await unlockVault(ctx.store, pass);
      if (v) ctx.onUnlocked(v); else msg.textContent = 'Restored. Use your gesture and passphrase to enter.';
    } catch (err) { msg.textContent = (err as Error).message; }
    fileIn.value = '';
  });
  return h('form', {
    class: 'keypanel setup',
    onsubmit: async (e: Event) => {
      e.preventDefault();
      if (p1.value.length < 12) { msg.textContent = 'Use at least 12 characters. A few random words works well.'; return; }
      if (p1.value !== p2.value) { msg.textContent = 'Passphrases do not match.'; return; }
      btn.disabled = true; msg.textContent = 'Preparing…';
      const v = await createVault(ctx.store, p1.value);
      p1.value = p2.value = '';
      ctx.onUnlocked(v);
    },
  },
    h('h3', {}, 'Begin a private collection'),
    p1, p2, msg,
    h('div', { class: 'row' }, btn,
      h('button', { type: 'button', class: 'ghost', onclick: () => { toast('Choose the artwork images or .atelier file. Enter the backup passphrase above first.'); fileIn.click(); } }, 'Restore backup'),
      h('button', { type: 'button', class: 'ghost', onclick: dismiss }, 'Cancel')),
    fileIn);
}
