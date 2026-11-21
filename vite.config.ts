import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
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
        .filter((f) => f !== 'sw.js' && !f.endsWith('.map'));
      const list = ['./', ...files.map((f) => `./${f}`)];
      const version = createHash('sha256').update(list.join('|') + Object.values(bundle).map((b) => ('code' in b ? b.code : String(b.source))).join('')).digest('hex').slice(0, 12);
      const sw = `// Generated. Precache everything; serve offline; never touch the network for app data.
const CACHE = 'atelier-${version}';
const ASSETS = ${JSON.stringify(list)};
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true, ignoreVary: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./', { ignoreVary: true }) : fetch(req))));
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [offline()],
  build: { target: 'es2022', sourcemap: false },
  worker: { format: 'es' },
  test: { environment: 'node', testTimeout: 60_000 },
} as never);
