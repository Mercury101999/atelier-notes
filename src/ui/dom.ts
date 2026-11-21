type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'number' ? String(c) : c);
  return el;
}

export function clear(el: Element) { while (el.firstChild) el.firstChild.remove(); }

/** Object URLs for decrypted media; revoked on lock. */
const urls = new Set<string>();
export function objectUrl(b: Blob) { const u = URL.createObjectURL(b); urls.add(u); return u; }
export function revokeAll() { for (const u of urls) URL.revokeObjectURL(u); urls.clear(); }

export function icon(name: keyof typeof ICONS, label?: string) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ico'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name];
  if (label) { const t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); t.textContent = label; s.prepend(t); }
  return s;
}
const P = (d: string) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
export const ICONS = {
  lock: P('M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3'),
  plus: P('M12 5v14M5 12h14'),
  search: P('M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4'),
  gear: P('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'),
  back: P('M15 18l-6-6 6-6'),
  close: P('M6 6l12 12M18 6L6 18'),
  left: P('M15 18l-6-6 6-6'),
  right: P('M9 6l6 6-6 6'),
  grid: P('M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'),
  graph: P('M6 6m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M18 8m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M10 18m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M8.2 7.2l7.4.6M7.2 8.2l1.8 7.5M16.4 10l-4.8 6'),
  folder: P('M3 7h6l2 2h10v10H3z'),
  image: P('M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5a1.5 1.5 0 1 0 0-.01'),
  file: P('M7 3h7l5 5v13H7zM14 3v5h5'),
  link: P('M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'),
  trash: P('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'),
  download: P('M12 4v11M7 10l5 5 5-5M5 20h14'),
  edit: P('M4 20h4L19 9l-4-4L4 16zM14 6l4 4'),
};

export function toast(msg: string) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3200);
}

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function download(bytes: Uint8Array | Blob, name: string, mime = 'application/octet-stream') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
  const u = URL.createObjectURL(blob);
  const a = h('a', { href: u, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 10_000);
}

/** Small promise-based modal. Returns null when dismissed. */
export function modal<T>(title: string, build: (close: (v: T | null) => void) => Node): Promise<T | null> {
  return new Promise((resolve) => {
    const prev = document.activeElement as HTMLElement | null;
    let done = false;
    const close = (v: T | null) => { if (done) return; done = true; wrap.remove(); prev?.focus?.(); resolve(v); };
    const wrap = h('div', { class: 'modal-wrap', onclick: (e: Event) => { if (e.target === wrap) close(null); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h3', {}, title),
        build(close)));
    wrap.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') close(null); });
    document.body.append(wrap);
    (wrap.querySelector('input,textarea,select,button') as HTMLElement | null)?.focus();
  });
}

export function promptText(title: string, opts: { value?: string; placeholder?: string; type?: string; ok?: string; hint?: string } = {}) {
  return modal<string>(title, (close) => {
    const input = h('input', { type: opts.type ?? 'text', value: opts.value ?? '', placeholder: opts.placeholder ?? '', autocomplete: 'off', spellcheck: false });
    return h('form', { onsubmit: (e: Event) => { e.preventDefault(); close(input.value); } },
      opts.hint ? h('p', { class: 'muted' }, opts.hint) : null,
      input,
      h('div', { class: 'row end' }, h('button', { type: 'button', class: 'ghost', onclick: () => close(null) }, 'Cancel'), h('button', { type: 'submit' }, opts.ok ?? 'OK')));
  });
}

export function confirmBox(title: string, text: string, ok = 'Confirm') {
  return modal<boolean>(title, (close) => h('div', {},
    h('p', { class: 'muted' }, text),
    h('div', { class: 'row end' }, h('button', { class: 'ghost', onclick: () => close(false) }, 'Cancel'), h('button', { class: 'danger', onclick: () => close(true) }, ok))));
}
