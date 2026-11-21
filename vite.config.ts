import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

/** Strict CSP (no network beyond same origin) + a generated precaching service worker. */
function offline(): Plugin {
  return {
    name: 'atelier-offline',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
    generateBundle(_, bundle) {
      const files = [...Object.keys(bundle), ...walk('public').map((p) => relative('public', p).split('\\').join('/'))]
        .filter((f) => f !== 'sw.js' && !f.endsWith('.map') && !/^(models|ort)\//.test(f) && !f.endsWith('.wasm'));
      const list = ['./', ...files.map((f) => `./${f}`)];
      const version = createHash('sha256').update(list.join('|') + Object.values(bundle).map((b) => ('code' in b ? b.code : String(b.source))).join('')).digest('hex').slice(0, 12);
      const sw = `// Generated. Precache everything; serve offline; never touch the network for app data.
const CACHE = 'atelier-${version}';
const VOICE = 'atelier-voice-v1'; // large on-device speech model files, cached on first use, kept across app updates
const ASSETS = ${JSON.stringify(list)};
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== VOICE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/models/') || url.pathname.includes('/ort/')) {
    e.respondWith(caches.open(VOICE).then((c) => c.match(req, { ignoreVary: true, ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => { if (res.ok && res.status === 200) c.put(req, res.clone()); return res; }))));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true, ignoreVary: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./', { ignoreVary: true }) : fetch(req))));
});
`;
      new Function(sw); // fail the build if the generated service worker has a syntax error
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw });
    },
  };
}

/** ONNX Runtime's bundle references a wasm via import.meta.url; we serve our own copy from /ort/, so drop the duplicate. */
function dropBundledWasm(): Plugin {
  return { name: 'drop-bundled-wasm', generateBundle(_, bundle) { for (const k of Object.keys(bundle)) if (k.endsWith('.wasm')) delete bundle[k]; } };
}

export default defineConfig({
  base: './',
  plugins: [offline()],
  build: { target: 'es2022', sourcemap: false },
  worker: { format: 'es', plugins: () => [dropBundledWasm()] },
  test: { environment: 'node', testTimeout: 60_000 },
} as never);
