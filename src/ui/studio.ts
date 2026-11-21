import type { Store } from '../core/store.ts';
import type { Folder, Note, Vault } from '../core/vault.ts';
import { clear, confirmBox, h, icon, modal, promptText } from './dom.ts';
import { artCanvas } from './media.ts';
import { openEditor } from './editor.ts';
import { renderBoard } from './board.ts';
import { openSettings } from './settings.ts';
import type { LockGuard } from './lock.ts';

export interface StudioCtx { store: Store; vault: Vault; guard: LockGuard; lock: () => void }

interface State { folder: string | null; view: 'rooms' | 'board'; query: string; tags: Set<string> }

export function showStudio(root: HTMLElement, ctx: StudioCtx) {
  const { vault } = ctx;
  const state: State = { folder: null, view: 'rooms', query: '', tags: new Set() };
  clear(root);
  document.title = 'Atelier';

  const search = h('input', { type: 'search', placeholder: 'Search works, tags, text', class: 'search', 'aria-label': 'Search', autocomplete: 'off' });
  search.addEventListener('input', () => { state.query = search.value; render(); });
  const viewBtn = h('button', { class: 'icon-btn', 'aria-label': 'Switch view', title: 'Rooms / Board', onclick: () => { state.view = state.view === 'rooms' ? 'board' : 'rooms'; render(); } });
  const top = h('header', { class: 'studio-top' },
    h('div', { class: 'brand' }, h('span', { class: 'mark' }, 'Atelier'), h('span', { class: 'sub' }, vault.isPrimary ? 'Private collection' : 'Collection')),
    search,
    h('div', { class: 'actions' },
      viewBtn,
      h('button', { class: 'icon-btn', 'aria-label': 'Settings', onclick: () => openSettings(ctx, render) }, icon('gear')),
      h('button', { class: 'icon-btn panic', 'aria-label': 'Lock now', title: 'Lock now (Esc Esc)', onclick: () => ctx.lock() }, icon('lock'))));
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Collections' });
  const tagbar = h('div', { class: 'tagbar' });
  const main = h('main', { class: 'studio-main' });
  const fab = h('button', { class: 'fab', 'aria-label': 'New', onclick: () => newMenu() }, icon('plus'));
  root.append(h('div', { class: 'studio' }, top, crumbs, tagbar, main, fab));

  const children = (id: string | null) => vault.folders.filter((f) => f.parent === id).sort((a, b) => a.name.localeCompare(b.name));
  const subtree = (id: string): Set<string> => {
    const s = new Set([id]);
    for (const f of vault.folders) if (f.parent === id) for (const x of subtree(f.id)) s.add(x);
    return s;
  };
  const filtering = () => state.query.trim() !== '' || state.tags.size > 0;
  function matches(n: Note) {
    const q = state.query.trim().toLowerCase();
    if (q && !(`${n.title}\n${n.body}\n${n.tags.join(' ')}\n${n.attachments.map((a) => a.name).join(' ')}`.toLowerCase().includes(q))) return false;
    for (const t of state.tags) if (!n.tags.includes(t)) return false;
    return true;
  }
  const openNote = (n: Note) => openEditor(ctx, n, render, openNote);

  function render() {
    if (vault.locked) return;
    viewBtn.replaceChildren(icon(state.view === 'rooms' ? 'graph' : 'grid'));
    // breadcrumbs
    clear(crumbs);
    crumbs.append(h('button', { class: 'crumb', onclick: () => { state.folder = null; render(); } }, 'Collections'));
    for (const f of vault.folderPath(state.folder)) {
      crumbs.append(h('span', { class: 'sep' }, '/'), h('button', { class: 'crumb', onclick: () => { state.folder = f.id; render(); } }, f.name));
    }
    if (state.folder) {
      const f = vault.folders.find((x) => x.id === state.folder)!;
      crumbs.append(h('span', { class: 'crumb-actions' },
        h('button', { class: 'icon-btn sm', 'aria-label': 'Rename collection', onclick: () => renameFolder(f) }, icon('edit')),
        h('button', { class: 'icon-btn sm', 'aria-label': 'Move collection', onclick: () => moveFolder(f) }, icon('folder')),
        h('button', { class: 'icon-btn sm', 'aria-label': 'Delete collection', onclick: () => deleteFolder(f) }, icon('trash'))));
    }
    // tags (computed in memory only)
    clear(tagbar);
    const allTags = [...new Set(vault.notes().flatMap((n) => n.tags))].sort();
    for (const t of allTags) {
      tagbar.append(h('button', { class: `chip${state.tags.has(t) ? ' on' : ''}`, onclick: () => { if (state.tags.has(t)) state.tags.delete(t); else state.tags.add(t); render(); } }, `#${t}`));
    }
    clear(main);
    const scope = state.folder ? subtree(state.folder) : null;
    if (state.view === 'board') {
      const notes = vault.notes().filter((n) => matches(n) && (!scope || (n.folder && scope.has(n.folder))));
      main.append(renderBoard(vault, notes, openNote));
      return;
    }
    if (filtering()) {
      const res = vault.notes().filter(matches);
      main.append(h('h2', { class: 'section' }, `${res.length} result${res.length === 1 ? '' : 's'}`), workGrid(res, true));
      return;
    }
    const rooms = children(state.folder);
    if (rooms.length) {
      main.append(h('h2', { class: 'section' }, state.folder ? 'Rooms within' : 'Collections'),
        h('div', { class: 'rooms' }, rooms.map((f) => roomCard(f))));
    }
    const works = vault.notes().filter((n) => n.folder === state.folder);
    main.append(h('h2', { class: 'section' }, 'Works'));
    if (!works.length && !rooms.length) {
      main.append(h('div', { class: 'empty' }, h('p', {}, 'This room is empty.'), h('p', { class: 'muted' }, 'Tap + to add a note or a collection.')));
    } else if (!works.length) main.append(h('p', { class: 'muted pad' }, 'No works in this room yet.'));
    else main.append(workGrid(works, false));
  }

  function roomCard(f: Folder) {
    const sub = subtree(f.id);
    const count = vault.notes().filter((n) => n.folder && sub.has(n.folder)).length;
    const rooms = sub.size - 1;
    return h('button', { class: 'room', onclick: () => { state.folder = f.id; render(); } },
      h('div', { class: 'arch' }, artCanvas(`room-${f.id}`, 280, 180)),
      h('div', { class: 'room-label' }, h('span', { class: 'title' }, f.name),
        h('span', { class: 'medium' }, `${count} work${count === 1 ? '' : 's'}${rooms ? ` · ${rooms} room${rooms === 1 ? '' : 's'}` : ''}`)));
  }

  function workGrid(notes: Note[], showPath: boolean) {
    const hide = vault.settings.hideTitles;
    return h('div', { class: 'works' }, notes.map((n, i) => {
      const imgs = n.attachments.filter((a) => a.kind === 'image').length;
      const files = n.attachments.length - imgs;
      const path = showPath ? vault.folderPath(n.folder).map((f) => f.name).join(' / ') : '';
      return h('button', { class: 'work', onclick: () => openNote(n), 'aria-label': hide ? `Work ${i + 1}` : n.title || 'Untitled' },
        h('div', { class: 'frame' }, artCanvas(n.id, 240, 300)),
        h('div', { class: 'label' },
          h('span', { class: 'title' }, hide ? `No. ${i + 1}` : n.title || 'Untitled'),
          h('span', { class: 'medium' }, [
            path,
            new Date(n.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
            imgs ? `${imgs} image${imgs > 1 ? 's' : ''}` : '',
            files ? `${files} file${files > 1 ? 's' : ''}` : '',
            n.links.length ? `${n.links.length} link${n.links.length > 1 ? 's' : ''}` : '',
          ].filter(Boolean).join(' · ')),
          !hide && n.tags.length ? h('span', { class: 'tags' }, n.tags.map((t) => `#${t}`).join(' ')) : null));
    }));
  }

  async function newMenu() {
    const choice = await modal<'note' | 'folder'>('Add', (close) => h('div', { class: 'menu' },
      h('button', { onclick: () => close('note') }, icon('edit'), 'New note'),
      h('button', { onclick: () => close('folder') }, icon('folder'), state.folder ? 'New room in this collection' : 'New collection')));
    if (choice === 'note') {
      const n = vault.newNote({ folder: state.folder });
      openNote(n);
    } else if (choice === 'folder') {
      const name = await promptText(state.folder ? 'New room' : 'New collection', { placeholder: 'Name', ok: 'Create' });
      if (name?.trim()) { await vault.createFolder(name.trim(), state.folder); render(); }
    }
  }
  async function renameFolder(f: Folder) {
    const name = await promptText('Rename', { value: f.name, ok: 'Save' });
    if (name?.trim()) { await vault.renameFolder(f.id, name.trim()); render(); }
  }
  async function moveFolder(f: Folder) {
    const bad = subtree(f.id);
    const dest = await pickFolder(vault, 'Move to…', (x) => !bad.has(x.id));
    if (dest !== undefined) { await vault.moveFolder(f.id, dest); render(); }
  }
  async function deleteFolder(f: Folder) {
    if (await confirmBox('Delete collection?', `“${f.name}” will be removed. Its notes and rooms move up one level; nothing else is deleted.`, 'Delete')) {
      state.folder = f.parent; await vault.deleteFolder(f.id); render();
    }
  }

  render();
  return render;
}

/** Folder picker. Resolves to folder id, null for top level, or undefined when cancelled. */
export async function pickFolder(vault: Vault, title: string, allow: (f: Folder) => boolean = () => true): Promise<string | null | undefined> {
  const r = await modal<{ id: string | null }>(title, (close) => {
    const opts = folderOptions(vault).filter((o) => !o.folder || allow(o.folder));
    return h('div', { class: 'menu' }, opts.map((o) => h('button', { onclick: () => close({ id: o.folder?.id ?? null }) }, icon('folder'), o.label)));
  });
  return r ? r.id : undefined;
}

export function folderOptions(vault: Vault): { folder: Folder | null; label: string }[] {
  const out: { folder: Folder | null; label: string }[] = [{ folder: null, label: 'Collections (top level)' }];
  const walk = (parent: string | null, depth: number) => {
    for (const f of vault.folders.filter((x) => x.parent === parent).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ folder: f, label: `${'\u2003'.repeat(depth)}${f.name}` });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
