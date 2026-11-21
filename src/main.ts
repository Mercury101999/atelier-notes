import './styles.css';
import { IdbStore } from './core/store.ts';
import type { Vault } from './core/vault.ts';
import { clear, revokeAll } from './ui/dom.ts';
import { showGallery } from './ui/gallery.ts';
import { LockGuard } from './ui/lock.ts';
import { clearArtCache } from './ui/media.ts';
import { showStudio } from './ui/studio.ts';
import { abortVoice } from './ui/voice.ts';

const root = document.getElementById('app')!;
const store = new IdbStore();
let vault: Vault | null = null;

function lock() {
  guard.stop();
  abortVoice(); // stop mic, kill transcription, zero audio
  vault?.lock();
  vault = null;
  for (const el of document.querySelectorAll('.modal-wrap, .sheet, .viewer, .toast')) el.remove();
  revokeAll();
  clearArtCache();
  clear(root);
  showGallery(root, { store, onUnlocked });
}

const guard = new LockGuard(lock);

function onUnlocked(v: Vault) {
  vault = v;
  for (const el of document.querySelectorAll('.viewer')) el.remove();
  guard.start(v.settings.idleMinutes);
  showStudio(root, { store, vault: v, guard, lock });
}

showGallery(root, { store, onUnlocked });

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}
// Ask the browser not to evict our storage under pressure (best effort).
navigator.storage?.persist?.().catch(() => {});
