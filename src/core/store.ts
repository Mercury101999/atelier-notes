/** Persistence layer. Everything stored here is ciphertext or random-looking bytes. */
export interface Header {
  v: 1;
  salt: Uint8Array;
  iter: number;
  /** Fixed number of key slots. Unused slots are random bytes of identical length. */
  slots: Uint8Array[];
  gestureSalt: Uint8Array;
  /** SHA-256 over the secret gallery gesture; null = default gesture. */
  gesture: Uint8Array | null;
}

export interface Store {
  getHeader(): Promise<Header | undefined>;
  putHeader(h: Header): Promise<void>;
  get(id: string): Promise<Uint8Array | undefined>;
  put(id: string, data: Uint8Array): Promise<void>;
  del(id: string): Promise<void>;
  ids(): Promise<string[]>;
  all(): Promise<[string, Uint8Array][]>;
  replaceAll(h: Header, records: [string, Uint8Array][]): Promise<void>;
  wipe(): Promise<void>;
}

export class MemoryStore implements Store {
  header?: Header;
  records = new Map<string, Uint8Array>();
  async getHeader() { return this.header ? structuredClone(this.header) : undefined; }
  async putHeader(h: Header) { this.header = structuredClone(h); }
  async get(id: string) { const r = this.records.get(id); return r ? r.slice() : undefined; }
  async put(id: string, data: Uint8Array) { this.records.set(id, data.slice()); }
  async del(id: string) { this.records.delete(id); }
  async ids() { return [...this.records.keys()]; }
  async all() { return [...this.records.entries()].map(([k, v]) => [k, v.slice()] as [string, Uint8Array]); }
  async replaceAll(h: Header, records: [string, Uint8Array][]) {
    this.header = structuredClone(h);
    this.records = new Map(records.map(([k, v]) => [k, v.slice()]));
  }
  async wipe() { this.header = undefined; this.records.clear(); }
}

// Innocuous names: to a casual inspector this looks like an image cache.
const DB_NAME = 'atelier-cache';
const PREFS = 'prefs';
const TILES = 'tiles';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}

export class IdbStore implements Store {
  private dbp: Promise<IDBDatabase> | null = null;
  constructor(private name = DB_NAME) {}
  private db(): Promise<IDBDatabase> {
    if (!this.dbp) {
      this.dbp = new Promise((res, rej) => {
        const r = indexedDB.open(this.name, 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore(PREFS);
          r.result.createObjectStore(TILES);
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return this.dbp;
  }
  async getHeader() { const db = await this.db(); return req<Header | undefined>(db.transaction(PREFS).objectStore(PREFS).get('h')); }
  async putHeader(h: Header) { const db = await this.db(); const tx = db.transaction(PREFS, 'readwrite'); tx.objectStore(PREFS).put(h, 'h'); await done(tx); }
  async get(id: string) { const db = await this.db(); return req<Uint8Array | undefined>(db.transaction(TILES).objectStore(TILES).get(id)); }
  async put(id: string, data: Uint8Array) { const db = await this.db(); const tx = db.transaction(TILES, 'readwrite'); tx.objectStore(TILES).put(data, id); await done(tx); }
  async del(id: string) { const db = await this.db(); const tx = db.transaction(TILES, 'readwrite'); tx.objectStore(TILES).delete(id); await done(tx); }
  async ids() { const db = await this.db(); return (await req(db.transaction(TILES).objectStore(TILES).getAllKeys())) as string[]; }
  async all() {
    const db = await this.db();
    const s = db.transaction(TILES).objectStore(TILES);
    const [keys, vals] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
    return (keys as string[]).map((k, i) => [k, vals[i] as Uint8Array] as [string, Uint8Array]);
  }
  async replaceAll(h: Header, records: [string, Uint8Array][]) {
    const db = await this.db();
    const tx = db.transaction([PREFS, TILES], 'readwrite');
    const t = tx.objectStore(TILES);
    t.clear();
    for (const [k, v] of records) t.put(v, k);
    tx.objectStore(PREFS).put(h, 'h');
    await done(tx);
  }
  async wipe() {
    const db = await this.db();
    const tx = db.transaction([PREFS, TILES], 'readwrite');
    tx.objectStore(PREFS).clear();
    tx.objectStore(TILES).clear();
    await done(tx);
  }
}
