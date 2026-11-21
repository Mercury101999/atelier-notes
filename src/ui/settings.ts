import { exportBackup, importBackup, setGesture } from '../core/vault.ts';
import { confirmBox, download, h, icon, promptText, toast } from './dom.ts';
import { EXHIBIT } from './gallery.ts';
import { hideInArtworksAsync, readBackupFiles } from './stegoClient.ts';
import type { StudioCtx } from './studio.ts';
import { MODEL_LABEL, modelCached, prepareModel, removeModel, voiceSupported } from './voice.ts';

export function openSettings(ctx: StudioCtx, rerender: () => void) {
  const { vault, store, guard } = ctx;
  document.querySelector('.sheet')?.remove();
  const s = vault.settings;
  const close = () => { sheet.remove(); rerender(); };
  const busy = async (btn: HTMLButtonElement, label: string, fn: () => Promise<void>) => {
    const old = btn.textContent; btn.disabled = true; btn.textContent = label;
    try { await fn(); } catch (e) { toast((e as Error).message); } finally { btn.disabled = false; btn.textContent = old; }
  };

  // Auto-lock
  const idle = h('select', { 'aria-label': 'Auto-lock' }, [1, 2, 3, 5, 10, 15, 30].map((m) => h('option', { value: String(m), selected: m === s.idleMinutes }, `${m} minute${m > 1 ? 's' : ''}`)));
  idle.addEventListener('change', async () => { const m = Number(idle.value); await vault.updateSettings({ idleMinutes: m }); guard.setMinutes(m); toast('Saved'); });
  const hide = h('input', { type: 'checkbox', checked: s.hideTitles });
  hide.addEventListener('change', async () => { await vault.updateSettings({ hideTitles: hide.checked }); toast('Saved'); });

  // Gesture
  const artSel = h('select', { 'aria-label': 'Artwork' }, EXHIBIT.map((a, i) => h('option', { value: String(i) }, `${i + 1}. ${a.title}`)));
  let seq: number[] = [];
  const seqOut = h('span', { class: 'muted small' }, 'Tap 3–9 squares in order');
  const pad = h('div', { class: 'gpad' }, [...Array(9).keys()].map((i) => h('button', {
    type: 'button', 'aria-label': `Square ${i + 1}`,
    onclick: (e: Event) => { if (seq.length >= 9) return; seq.push(i); seqOut.textContent = seq.map((c) => c + 1).join(' → '); const b = e.currentTarget as HTMLElement; b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); },
  })));
  const gestureSave = h('button', {}, 'Save gesture');
  gestureSave.addEventListener('click', () => busy(gestureSave, 'Saving…', async () => {
    if (seq.length < 3) throw new Error('Tap at least 3 squares');
    await setGesture(store, Number(artSel.value), seq);
    toast(`Gesture saved: open “${EXHIBIT[Number(artSel.value)].title}” and tap ${seq.map((c) => c + 1).join(', ')}`);
    seq = []; seqOut.textContent = 'Tap 3–9 squares in order';
  }));

  // Passphrase
  const cur = h('input', { type: 'password', placeholder: 'Current passphrase', autocomplete: 'current-password' });
  const nx1 = h('input', { type: 'password', placeholder: 'New passphrase (12+)', autocomplete: 'new-password' });
  const nx2 = h('input', { type: 'password', placeholder: 'Repeat new passphrase', autocomplete: 'new-password' });
  const passBtn = h('button', {}, 'Change passphrase');
  passBtn.addEventListener('click', () => busy(passBtn, 'Working…', async () => {
    if (nx1.value.length < 12) throw new Error('Use at least 12 characters');
    if (nx1.value !== nx2.value) throw new Error('New passphrases do not match');
    await vault.changePassphrase(cur.value, nx1.value);
    cur.value = nx1.value = nx2.value = '';
    toast('Passphrase changed');
  }));

  // Decoy
  const decoy = h('input', { type: 'password', placeholder: 'Decoy passphrase', autocomplete: 'off' });
  const seed = h('input', { type: 'checkbox', checked: true });
  const decoyBtn = h('button', {}, 'Create decoy');
  decoyBtn.addEventListener('click', () => busy(decoyBtn, 'Creating…', async () => {
    if (decoy.value.length < 8) throw new Error('Use at least 8 characters');
    await vault.createDecoy(decoy.value, seed.checked);
    decoy.value = '';
    toast('Decoy ready. Its passphrase opens a separate, ordinary-looking collection.');
  }));

  // Backup
  const askPass = () => promptText('Confirm passphrase', { type: 'password', ok: 'Continue', hint: 'The backup is encrypted with the passphrase you use to open this collection.' });
  const exportPng = h('button', {}, icon('image'), 'Export as artwork');
  exportPng.addEventListener('click', async () => {
    const p = await askPass(); if (!p) return;
    await busy(exportPng, 'Painting…', async () => {
      const payload = await exportBackup(store, p);
      const carriers = await hideInArtworksAsync(payload);
      const files = carriers.map((c) => new File([c.png], c.name, { type: 'image/png' }));
      if (navigator.canShare?.({ files }) && matchMedia('(pointer: coarse)').matches) {
        try { guard.pickerOpen = true; await navigator.share({ files }); return; } catch { /* fall back to download */ } finally { guard.pickerOpen = false; }
      }
      for (const f of files) { download(f, f.name); await new Promise((r) => setTimeout(r, 400)); }
      toast(`${files.length} artwork${files.length > 1 ? 's' : ''} saved`);
    });
  });
  const exportRaw = h('button', { class: 'ghost' }, icon('download'), 'Export .atelier file');
  exportRaw.addEventListener('click', async () => {
    const p = await askPass(); if (!p) return;
    await busy(exportRaw, 'Encrypting…', async () => {
      download(await exportBackup(store, p), `atelier-${new Date().toISOString().slice(0, 10)}.atelier`);
    });
  });
  const importIn = h('input', { type: 'file', accept: 'image/png,.atelier', multiple: true, hidden: true });
  const importBtn = h('button', { class: 'ghost' }, 'Restore from backup…');
  importBtn.addEventListener('click', () => { guard.pickerOpen = true; importIn.click(); });
  importIn.addEventListener('cancel', () => (guard.pickerOpen = false));
  importIn.addEventListener('change', async () => {
    guard.pickerOpen = false;
    const files = importIn.files; if (!files?.length) return;
    await busy(importBtn, 'Reading…', async () => {
      const payload = await readBackupFiles(files);
      if (!(await confirmBox('Replace everything?', 'Restoring replaces ALL collections on this device (including any other passphrases) with the backup.', 'Restore'))) return;
      const p = await promptText('Backup passphrase', { type: 'password', ok: 'Restore' }); if (!p) return;
      await importBackup(store, payload, p);
      toast('Restored. Use your gesture and passphrase to enter.');
      ctx.lock();
    });
    importIn.value = '';
  });

  const eraseBtn = h('button', { class: 'danger' }, 'Erase this device');
  eraseBtn.addEventListener('click', async () => {
    const t = await promptText('Erase everything?', { placeholder: 'Type ERASE', ok: 'Erase', hint: 'Deletes every collection, note, image and file stored by this app on this device. This cannot be undone.' });
    if (t !== 'ERASE') return;
    await store.wipe(); ctx.lock();
  });

  // Voice typing
  const cmds = h('input', { type: 'checkbox', checked: s.voiceCommands });
  cmds.addEventListener('change', async () => { await vault.updateSettings({ voiceCommands: cmds.checked }); toast('Saved'); });
  const modelState = h('p', { class: 'muted small' }, 'Checking…');
  const refreshModel = async () => { modelState.textContent = (await modelCached()) ? `Voice model ready offline: ${MODEL_LABEL}.` : `Voice model not downloaded yet (${MODEL_LABEL}). It downloads from this app’s own site on first use.`; };
  void refreshModel();
  const dlBtn = h('button', { class: 'ghost' }, icon('download'), 'Download for offline');
  dlBtn.addEventListener('click', () => busy(dlBtn, 'Downloading…', async () => {
    const ms = await prepareModel((f) => { dlBtn.textContent = `Downloading… ${Math.round(f * 100)}%`; });
    toast(`Voice model ready (${(ms / 1000).toFixed(1)} s)`); await refreshModel();
  }));
  const rmBtn = h('button', { class: 'ghost' }, 'Remove voice model');
  rmBtn.addEventListener('click', () => busy(rmBtn, 'Removing…', async () => { await removeModel(); await refreshModel(); }));
  const dictList = h('div', { class: 'dict' });
  let dict = s.dictionary.map((r) => ({ ...r }));
  const saveDict = async () => { await vault.updateSettings({ dictionary: dict.filter((r) => r.from.trim()) }); };
  const drawDict = () => {
    dictList.replaceChildren(...dict.map((r, i) => {
      const a = h('input', { value: r.from, placeholder: 'When I say…', 'aria-label': 'Heard' });
      const b = h('input', { value: r.to, placeholder: 'Write…', 'aria-label': 'Replacement' });
      a.addEventListener('change', () => { r.from = a.value; void saveDict(); });
      b.addEventListener('change', () => { r.to = b.value; void saveDict(); });
      return h('div', { class: 'dict-row' }, a, h('span', { class: 'muted' }, '→'), b,
        h('button', { class: 'icon-btn sm', 'aria-label': 'Remove rule', onclick: () => { dict.splice(i, 1); void saveDict(); drawDict(); } }, icon('close')));
    }));
  };
  drawDict();
  const addRule = h('button', { class: 'ghost', onclick: () => { dict.push({ from: '', to: '' }); drawDict(); (dictList.lastElementChild?.querySelector('input') as HTMLInputElement | null)?.focus(); } }, icon('plus'), 'Add replacement');

  const sec = (title: string, ...kids: (Node | null)[]) => h('section', { class: 'set' }, h('h4', {}, title), ...kids);
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Settings' },
    h('div', { class: 'sheet-top' }, h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: close }, icon('back')), h('span', {}, 'Settings')),
    h('div', { class: 'sheet-body settings' },
      sec('Locking',
        h('label', { class: 'row' }, 'Lock after idle', idle),
        h('p', { class: 'muted small' }, 'Also locks whenever you switch apps or hide the tab. Press Esc twice or tap the lock to lock instantly.'),
        h('label', { class: 'row' }, hide, 'Hide titles under works')),
      sec('Secret gesture',
        h('p', { class: 'muted small' }, 'Pick an artwork, then tap squares of its 3×3 grid. In the gallery, open that artwork and tap the same squares within 3 seconds of each other.'),
        artSel, pad, seqOut, h('div', { class: 'row' }, gestureSave, h('button', { class: 'ghost', type: 'button', onclick: () => { seq = []; seqOut.textContent = 'Tap 3–9 squares in order'; } }, 'Clear'))),
      sec('Voice typing',
        h('p', { class: 'muted small' }, voiceSupported()
          ? 'Tap Dictate in a note. Speech is transcribed on this device with Whisper. Audio is kept only in memory, never stored, and erased once you insert the text or the app locks.'
          : 'Voice typing isn’t supported in this browser.'),
        modelState, h('div', { class: 'row wrap' }, dlBtn, rmBtn),
        h('label', { class: 'row' }, cmds, 'Spoken commands'),
        h('p', { class: 'muted small' }, 'Say “new line”, “new paragraph”, “period”, “comma”, “question mark”, “exclamation mark”, “colon”, “semicolon”, “dash”, “open quote”, “close quote”.'),
        h('p', { class: 'muted small' }, 'Custom dictionary (encrypted): fix names and words Whisper mishears.'),
        dictList, addRule),
      sec('Passphrase', cur, nx1, nx2, passBtn),
      vault.isPrimary ? sec('Decoy collection',
        h('p', { class: 'muted small' }, 'A second passphrase that opens a separate, harmless collection. Nothing on the device shows how many collections exist.'),
        decoy, h('label', { class: 'row' }, seed, 'Fill with ordinary notes'), decoyBtn) : null,
      sec('Backup',
        h('p', { class: 'muted small' }, 'Everything lives only on this device. Clearing browser data or losing the device loses it. Export regularly. Artwork exports hide the encrypted backup inside PNG paintings; keep them as files, because apps that recompress images destroy the hidden data.'),
        h('div', { class: 'row wrap' }, exportPng, exportRaw), importBtn, importIn),
      sec('Danger', eraseBtn)));
  document.querySelector('.studio')!.append(sheet);
}
