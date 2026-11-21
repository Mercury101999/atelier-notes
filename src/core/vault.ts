import { concat, equal, pack, randomBytes, sha256, toHex, unpack, unutf8, utf8, u32, readU32 } from './bytes.ts';
import { PBKDF2_ITERATIONS, SEAL_OVERHEAD, bucketSize, deriveKek, hmacHex, keysFromMaster, open, pad, seal, unpad, type VaultKeys } from './crypto.ts';
import type { Header, Store } from './store.ts';

export const SLOT_COUNT = 4;
const MASTER_LEN = 64;
const SLOT_LEN = SEAL_OVERHEAD + MASTER_LEN;
/** Default secret gesture: third artwork, tap corners clockwise from top-left. */
export const DEFAULT_GESTURE = { art: 2, cells: [0, 2, 8, 6] };

export interface Folder { id: string; name: string; parent: string | null; created: number }
export interface Attachment { id: string; kind: 'image' | 'file'; name: string; mime: string; size: number; w?: number; h?: number }
export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  folder: string | null;
  attachments: Attachment[];
  /** Ids of linked notes (outgoing). Backlinks are computed in memory. */
  links: string[];
  created: number;
  updated: number;
}
export interface Settings { idleMinutes: number; hideTitles: boolean }
interface Index {
  v: 1;
  primary: boolean;
  slot: number;
  /** Slots this (primary) vault knows are in use, so it never overwrites them. */
  owned: number[];
  notes: string[];
  folders: Folder[];
  settings: Settings;
}

const slotAad = (i: number) => utf8.encode(`atelier/slot/${i}`);
const recAad = (id: string) => utf8.encode(`atelier/rec/${id}`);
export const newId = () => toHex(randomBytes(16));

async function sealRecord(keys: VaultKeys, id: string, plain: Uint8Array) { return seal(keys.enc, pad(plain), recAad(id)); }
async function openRecord(keys: VaultKeys, id: string, sealed: Uint8Array) { return unpad(await open(keys.enc, sealed, recAad(id))); }
const enc = (o: unknown) => utf8.encode(JSON.stringify(o));
const dec = <T>(b: Uint8Array) => JSON.parse(unutf8.decode(b)) as T;

/** Random filler records with the same size distribution as real ones. */
async function writeNoise(store: Store, count: number) {
  for (let i = 0; i < count; i++) {
    const size = bucketSize(Math.floor(Math.random() * 6000)) + SEAL_OVERHEAD;
    await store.put(newId(), randomBytes(size));
  }
}

/** Try every slot (always all of them, so timing doesn't reveal which matched). */
async function findSlot(header: Header, passphrase: string): Promise<{ slot: number; master: Uint8Array } | null> {
  const kek = await deriveKek(passphrase, header.salt, header.iter);
  let found: { slot: number; master: Uint8Array } | null = null;
  for (let i = 0; i < header.slots.length; i++) {
    try {
      const m = await open(kek, header.slots[i], slotAad(i));
      if (!found) found = { slot: i, master: m }; else m.fill(0);
    } catch { /* not this slot */ }
  }
  return found;
}

export async function hasVault(store: Store) { return !!(await store.getHeader()); }

/** First-time setup: creates the header, the primary vault and some noise records. */
export async function createVault(store: Store, passphrase: string): Promise<Vault> {
  const salt = randomBytes(16);
  const kek = await deriveKek(passphrase, salt, PBKDF2_ITERATIONS);
  const slot = Math.floor(Math.random() * SLOT_COUNT);
  const master = randomBytes(MASTER_LEN);
  const slots: Uint8Array[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) slots.push(i === slot ? await seal(kek, master, slotAad(i)) : randomBytes(SLOT_LEN));
  const header: Header = { v: 1, salt, iter: PBKDF2_ITERATIONS, slots, gestureSalt: randomBytes(16), gesture: null };
  await store.replaceAll(header, []);
  const keys = await keysFromMaster(master);
  const index: Index = { v: 1, primary: true, slot, owned: [slot], notes: [], folders: [], settings: { idleMinutes: 3, hideTitles: false } };
  const v = new Vault(store, keys, index, await hmacHex(keys.ids, 'atelier/index'), new Map());
  await v.saveIndex();
  await writeNoise(store, 4 + Math.floor(Math.random() * 7));
  return v;
}

export async function unlockVault(store: Store, passphrase: string): Promise<Vault | null> {
  const header = await store.getHeader();
  if (!header) return null;
  const hit = await findSlot(header, passphrase);
  if (!hit) return null;
  const keys = await keysFromMaster(hit.master);
  const indexId = await hmacHex(keys.ids, 'atelier/index');
  const raw = await store.get(indexId);
  if (!raw) return null;
  const index = dec<Index>(await openRecord(keys, indexId, raw));
  index.folders ??= [];
  const notes = new Map<string, Note>();
  for (const id of index.notes) {
    const r = await store.get(id);
    if (!r) continue;
    try {
      const n = dec<Note>(await openRecord(keys, id, r));
      n.attachments ??= []; n.links ??= []; n.tags ??= []; n.folder ??= null;
      notes.set(id, n);
    } catch { /* corrupted record: skip */ }
  }
  return new Vault(store, keys, index, indexId, notes);
}

/** An unlocked vault. Keys are non-extractable CryptoKeys held only in memory; lock() drops everything. */
export class Vault {
  constructor(
    private store: Store,
    private keys: VaultKeys | null,
    private index: Index,
    private indexId: string,
    private noteMap: Map<string, Note>,
  ) {}

  private k(): VaultKeys { if (!this.keys) throw new Error('Locked'); return this.keys; }
  get locked() { return !this.keys; }
  get isPrimary() { return this.index.primary; }
  get settings(): Settings { return { ...this.index.settings }; }
  get folders(): Folder[] { return this.index.folders.map((f) => ({ ...f })); }

  async saveIndex() { await this.store.put(this.indexId, await sealRecord(this.k(), this.indexId, enc(this.index))); }

  notes(): Note[] { return [...this.noteMap.values()].sort((a, b) => b.updated - a.updated); }
  note(id: string) { return this.noteMap.get(id); }

  newNote(partial: Partial<Note> = {}): Note {
    const now = Date.now();
    return { id: newId(), title: '', body: '', tags: [], folder: null, attachments: [], links: [], created: now, updated: now, ...partial };
  }

  async saveNote(n: Note) {
    n.updated = Date.now();
    const copy: Note = structuredClone(n);
    await this.store.put(n.id, await sealRecord(this.k(), n.id, enc(copy)));
    this.noteMap.set(n.id, copy);
    if (!this.index.notes.includes(n.id)) { this.index.notes.push(n.id); await this.saveIndex(); }
  }

  async deleteNote(id: string) {
    const n = this.noteMap.get(id);
    if (!n) return;
    for (const a of n.attachments) await this.store.del(a.id);
    await this.store.del(id);
    this.noteMap.delete(id);
    this.index.notes = this.index.notes.filter((x) => x !== id);
    await this.saveIndex();
    for (const other of this.noteMap.values()) {
      if (other.links.includes(id)) { other.links = other.links.filter((x) => x !== id); await this.saveNote(other); }
    }
  }

  backlinks(id: string): Note[] { return this.notes().filter((n) => n.links.includes(id)); }

  /** Encrypts an attachment (image or file) as its own padded record. */
  async putBlob(bytes: Uint8Array): Promise<string> {
    const id = newId();
    await this.store.put(id, await sealRecord(this.k(), id, bytes));
    return id;
  }
  async getBlob(id: string): Promise<Uint8Array | null> {
    const r = await this.store.get(id);
    if (!r) return null;
    return openRecord(this.k(), id, r);
  }
  async deleteBlob(id: string) { await this.store.del(id); }

  // ---- folders ("collections") ----
  async createFolder(name: string, parent: string | null = null): Promise<Folder> {
    const f: Folder = { id: newId(), name, parent, created: Date.now() };
    this.index.folders.push(f);
    await this.saveIndex();
    return { ...f };
  }
  async renameFolder(id: string, name: string) {
    const f = this.index.folders.find((x) => x.id === id);
    if (f) { f.name = name; await this.saveIndex(); }
  }
  async moveFolder(id: string, parent: string | null) {
    const f = this.index.folders.find((x) => x.id === id);
    if (!f || id === parent) return;
    for (let p = parent; p; p = this.index.folders.find((x) => x.id === p)?.parent ?? null) if (p === id) return; // no cycles
    f.parent = parent; await this.saveIndex();
  }
  /** Deletes a folder; its notes and sub-folders move up to its parent. */
  async deleteFolder(id: string) {
    const f = this.index.folders.find((x) => x.id === id);
    if (!f) return;
    for (const c of this.index.folders) if (c.parent === id) c.parent = f.parent;
    this.index.folders = this.index.folders.filter((x) => x.id !== id);
    await this.saveIndex();
    for (const n of this.noteMap.values()) if (n.folder === id) { n.folder = f.parent; await this.saveNote(n); }
  }
  folderPath(id: string | null): Folder[] {
    const out: Folder[] = [];
    for (let p = id; p; ) { const f = this.index.folders.find((x) => x.id === p); if (!f) break; out.unshift({ ...f }); p = f.parent; }
    return out;
  }

  async updateSettings(s: Partial<Settings>) { this.index.settings = { ...this.index.settings, ...s }; await this.saveIndex(); }

  /** Adds an independent decoy vault in a slot this primary vault doesn't use. */
  async createDecoy(passphrase: string, seed = true) {
    if (!this.index.primary) throw new Error('Not available');
    const header = (await this.store.getHeader())!;
    if (await findSlot(header, passphrase)) throw new Error('That passphrase is already in use');
    const free = [...Array(header.slots.length).keys()].filter((i) => !this.index.owned.includes(i));
    if (!free.length) throw new Error('No free slots');
    const slot = free[Math.floor(Math.random() * free.length)];
    const kek = await deriveKek(passphrase, header.salt, header.iter);
    const master = randomBytes(MASTER_LEN);
    header.slots[slot] = await seal(kek, master, slotAad(slot));
    await this.store.putHeader(header);
    const keys = await keysFromMaster(master);
    const index: Index = { v: 1, primary: false, slot, owned: [slot], notes: [], folders: [], settings: { ...this.index.settings } };
    const decoy = new Vault(this.store, keys, index, await hmacHex(keys.ids, 'atelier/index'), new Map());
    await decoy.saveIndex();
    if (seed) {
      const samples: [string, string, string[]][] = [
        ['Groceries', 'oat milk\nlemons\nbasil\ncoffee beans\nrice', ['list']],
        ['Gallery visit', 'Ask about the spring print sale. Bring a tote.', ['plans']],
        ['Book list', 'The Overstory\nPiranesi\nA Gentleman in Moscow', ['reading']],
        ['Paint colours', 'Hallway: warm white (eggshell)\nStudy: deep teal', ['home']],
      ];
      for (const [title, body, tags] of samples) await decoy.saveNote(decoy.newNote({ title, body, tags }));
    }
    decoy.lock();
    if (!this.index.owned.includes(slot)) this.index.owned.push(slot);
    await this.saveIndex();
  }

  async changePassphrase(current: string, next: string) {
    const header = (await this.store.getHeader())!;
    const hit = await findSlot(header, current);
    if (!hit || hit.slot !== this.index.slot) { hit?.master.fill(0); throw new Error('Current passphrase is incorrect'); }
    const clash = await findSlot(header, next);
    if (clash) { clash.master.fill(0); hit.master.fill(0); throw new Error('Choose a different passphrase'); }
    const kek = await deriveKek(next, header.salt, header.iter);
    header.slots[hit.slot] = await seal(kek, hit.master, slotAad(hit.slot));
    hit.master.fill(0);
    await this.store.putHeader(header);
  }

  /** Drops keys and all decrypted state. */
  lock() {
    this.keys = null;
    this.noteMap.clear();
    this.index = { v: 1, primary: false, slot: -1, owned: [], notes: [], folders: [], settings: { idleMinutes: 3, hideTitles: false } };
  }
}

// ---- gesture (camouflage only; not a security boundary) ----
export function gestureString(art: number, cells: number[]) { return `${art}:${cells.join('-')}`; }

export async function gestureMatches(store: Store, art: number, recent: number[]): Promise<boolean> {
  const header = await store.getHeader();
  if (!header?.gesture) {
    const d = DEFAULT_GESTURE.cells;
    return art === DEFAULT_GESTURE.art && recent.length >= d.length && recent.slice(-d.length).join() === d.join();
  }
  for (let len = 3; len <= Math.min(9, recent.length); len++) {
    const h = await sha256(header.gestureSalt, utf8.encode(gestureString(art, recent.slice(-len))));
    if (equal(h, header.gesture)) return true;
  }
  return false;
}

export async function setGesture(store: Store, art: number, cells: number[]) {
  if (cells.length < 3 || cells.length > 9) throw new Error('Use 3–9 taps');
  const header = (await store.getHeader())!;
  header.gestureSalt = randomBytes(16);
  header.gesture = await sha256(header.gestureSalt, utf8.encode(gestureString(art, cells)));
  await store.putHeader(header);
}

// ---- backups ----
const BACKUP_MAGIC = utf8.encode('ATLB');
const backupAad = utf8.encode('atelier/backup/v1');

function serializeHeader(h: Header): Uint8Array {
  return pack([u32(h.iter), h.salt, h.gestureSalt, h.gesture ?? new Uint8Array(0), ...h.slots]);
}
function deserializeHeader(b: Uint8Array): Header {
  const [iter, salt, gestureSalt, gesture, ...slots] = unpack(b);
  if (slots.length !== SLOT_COUNT) throw new Error('Unsupported backup');
  return { v: 1, iter: readU32(iter, 0), salt, gestureSalt, gesture: gesture.length ? gesture : null, slots };
}

/**
 * Whole-device image (header + every record of every vault, all already ciphertext),
 * wrapped in another AES-GCM layer keyed from the passphrase so the payload is uniformly random.
 */
export async function exportBackup(store: Store, passphrase: string): Promise<Uint8Array> {
  const header = await store.getHeader();
  if (!header) throw new Error('Nothing to back up');
  const hit = await findSlot(header, passphrase);
  if (!hit) throw new Error('Passphrase is incorrect');
  hit.master.fill(0);
  const records = await store.all();
  const image = pack([BACKUP_MAGIC, serializeHeader(header), ...records.flatMap(([id, d]) => [utf8.encode(id), d])]);
  const salt = randomBytes(16);
  const key = await deriveKek(passphrase, salt, PBKDF2_ITERATIONS);
  return concat(salt, await seal(key, image, backupAad));
}

export async function importBackup(store: Store, backup: Uint8Array, passphrase: string) {
  const key = await deriveKek(passphrase, backup.subarray(0, 16), PBKDF2_ITERATIONS);
  let image: Uint8Array;
  try { image = await open(key, backup.subarray(16), backupAad); } catch { throw new Error('Wrong passphrase or damaged backup'); }
  const [magic, h, ...rest] = unpack(image);
  if (!equal(magic, BACKUP_MAGIC)) throw new Error('Not an Atelier backup');
  const header = deserializeHeader(h);
  const records: [string, Uint8Array][] = [];
  for (let i = 0; i + 1 < rest.length; i += 2) records.push([unutf8.decode(rest[i]), rest[i + 1]]);
  await store.replaceAll(header, records);
}
