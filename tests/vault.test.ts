import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { unutf8, utf8 } from '../src/core/bytes.ts';
import { IdbStore, MemoryStore } from '../src/core/store.ts';
import { SLOT_COUNT, createVault, exportBackup, gestureMatches, importBackup, setGesture, unlockVault, DEFAULT_GESTURE } from '../src/core/vault.ts';
import { hideInArtworks, revealFromArtworks } from '../src/core/stego.ts';

const T = 60_000;

describe('vault', () => {
  it('stores only ciphertext and round-trips notes, folders, attachments, links', async () => {
    const store = new MemoryStore();
    const v = await createVault(store, 'real passphrase');
    const f = await v.createFolder('Ideas');
    const sub = await v.createFolder('Inner', f.id);
    const blob = await v.putBlob(utf8.encode('PDFDATA-secret'));
    const a = v.newNote({ title: 'Secret plan', body: 'meet at the pier', tags: ['x'], folder: sub.id, attachments: [{ id: blob, kind: 'file', name: 'plan.pdf', mime: 'application/pdf', size: 14 }] });
    await v.saveNote(a);
    const b = v.newNote({ title: 'Second', links: [a.id] });
    await v.saveNote(b);
    // nothing in storage contains plaintext
    for (const [, d] of await store.all()) {
      const s = unutf8.decode(d);
      for (const w of ['Secret plan', 'pier', 'Ideas', 'Inner', 'PDFDATA', 'plan.pdf']) expect(s.includes(w)).toBe(false);
    }
    v.lock();
    expect(v.locked).toBe(true);
    expect(v.notes()).toEqual([]);
    const v2 = (await unlockVault(store, 'real passphrase'))!;
    expect(v2.notes().map((n) => n.title).sort()).toEqual(['Second', 'Secret plan']);
    expect(v2.folderPath(sub.id).map((x) => x.name)).toEqual(['Ideas', 'Inner']);
    expect(unutf8.decode((await v2.getBlob(blob))!)).toBe('PDFDATA-secret');
    expect(v2.backlinks(a.id).map((n) => n.title)).toEqual(['Second']);
    await v2.deleteFolder(f.id);
    expect(v2.note(a.id)!.folder).toBe(sub.id);
    expect(v2.folders.find((x) => x.id === sub.id)!.parent).toBe(null);
    await v2.deleteNote(a.id);
    expect(v2.note(b.id)!.links).toEqual([]);
    expect(await store.get(blob)).toBeUndefined();
    expect(await unlockVault(store, 'wrong')).toBeNull();
  }, T);

  it('decoy vault is independent and storage does not reveal vault count', async () => {
    const store = new MemoryStore();
    const real = await createVault(store, 'real');
    const h0 = (await store.getHeader())!;
    expect(h0.slots.length).toBe(SLOT_COUNT);
    const slotLens = new Set(h0.slots.map((s) => s.length));
    expect(slotLens.size).toBe(1);
    await real.saveNote(real.newNote({ title: 'REAL-ONLY' }));
    await real.createFolder('real-folder');
    await real.createDecoy('decoy', true);
    await expect(real.createDecoy('real')).rejects.toThrow();
    const h1 = (await store.getHeader())!;
    expect(h1.slots.length).toBe(SLOT_COUNT);
    expect(new Set(h1.slots.map((s) => s.length)).size).toBe(1);

    const d = (await unlockVault(store, 'decoy'))!;
    expect(d.isPrimary).toBe(false);
    expect(d.notes().some((n) => n.title === 'REAL-ONLY')).toBe(false);
    expect(d.notes().length).toBe(4);
    expect(d.folders).toEqual([]);
    await d.saveNote(d.newNote({ title: 'DECOY-ONLY' }));
    await expect(d.createDecoy('another')).rejects.toThrow();

    const r = (await unlockVault(store, 'real'))!;
    expect(r.isPrimary).toBe(true);
    expect(r.notes().map((n) => n.title)).toEqual(['REAL-ONLY']);
    expect(r.folders.map((f) => f.name)).toEqual(['real-folder']);
    // all record ids look alike (32 hex chars), no per-vault prefix
    for (const id of await store.ids()) expect(id).toMatch(/^[0-9a-f]{32}$/);
  }, T);

  it('change passphrase', async () => {
    const store = new MemoryStore();
    const v = await createVault(store, 'old');
    await v.saveNote(v.newNote({ title: 'n' }));
    await expect(v.changePassphrase('nope', 'new')).rejects.toThrow();
    await v.changePassphrase('old', 'new');
    expect(await unlockVault(store, 'old')).toBeNull();
    expect((await unlockVault(store, 'new'))!.notes()[0].title).toBe('n');
  }, T);

  it('backup export/import round-trips through PNG steganography (IndexedDB)', async () => {
    const src = new IdbStore('t-src');
    const v = await createVault(src, 'pw');
    const photo = await v.putBlob(new Uint8Array([1, 2, 3, 4]));
    await v.saveNote(v.newNote({ title: 'kept', attachments: [{ id: photo, kind: 'image', name: 'p.jpg', mime: 'image/jpeg', size: 4 }] }));
    await v.createDecoy('decoy');
    await expect(exportBackup(src, 'bad')).rejects.toThrow();
    const backup = await exportBackup(src, 'pw');
    const pngs = await hideInArtworks(backup);
    const restored = await revealFromArtworks(pngs.map((p) => p.png));

    const dst = new IdbStore('t-dst');
    await expect(importBackup(dst, restored, 'wrong')).rejects.toThrow();
    await importBackup(dst, restored, 'pw');
    const r = (await unlockVault(dst, 'pw'))!;
    expect(r.notes()[0].title).toBe('kept');
    expect(Array.from((await r.getBlob(photo))!)).toEqual([1, 2, 3, 4]);
    expect((await unlockVault(dst, 'decoy'))!.notes().length).toBe(4);
  }, T);

  it('secret gesture: default and custom', async () => {
    const store = new MemoryStore();
    await createVault(store, 'p');
    expect(await gestureMatches(store, DEFAULT_GESTURE.art, [4, ...DEFAULT_GESTURE.cells])).toBe(true);
    expect(await gestureMatches(store, 0, DEFAULT_GESTURE.cells)).toBe(false);
    await setGesture(store, 5, [1, 1, 7]);
    expect(await gestureMatches(store, 5, [3, 1, 1, 7])).toBe(true);
    expect(await gestureMatches(store, DEFAULT_GESTURE.art, DEFAULT_GESTURE.cells)).toBe(false);
    expect((await store.getHeader())!.gesture!.length).toBe(32);
  }, T);
});

describe('dictation settings', () => {
  it('dictionary and voice commands are stored encrypted in the vault index', async () => {
    const store = new MemoryStore();
    const v = await createVault(store, 'pw');
    expect(v.settings.voiceCommands).toBe(true);
    await v.updateSettings({ dictionary: [{ from: 'at a lea', to: 'ZEBRA-REPLACEMENT' }], voiceCommands: false });
    for (const [, d] of await store.all()) expect(unutf8.decode(d).includes('ZEBRA')).toBe(false);
    const r = (await unlockVault(store, 'pw'))!;
    expect(r.settings.dictionary).toEqual([{ from: 'at a lea', to: 'ZEBRA-REPLACEMENT' }]);
    expect(r.settings.voiceCommands).toBe(false);
  }, 60_000);
});
