import type { Attachment, Note } from '../core/vault.ts';
import { clear, confirmBox, download, formatSize, h, icon, modal, objectUrl, toast } from './dom.ts';
import { artCanvas, sanitizeImage } from './media.ts';
import type { StudioCtx } from './studio.ts';
import { folderOptions } from './studio.ts';

const MAX_FILE = 50 * 1024 * 1024;

export function openEditor(ctx: StudioCtx, original: Note, onChange: () => void, openOther: (n: Note) => void) {
  const { vault, guard } = ctx;
  document.querySelector('.sheet')?.remove();
  const note: Note = structuredClone(original);
  const isNew = !vault.note(note.id);
  let dirty = false;
  let timer = 0;

  const save = async () => {
    clearTimeout(timer);
    if (!dirty || vault.locked) return;
    if (!vault.note(note.id) && !note.title.trim() && !note.body.trim() && !note.attachments.length) return;
    dirty = false;
    await vault.saveNote(note);
    status.textContent = 'Saved';
  };
  const touch = () => { dirty = true; status.textContent = '…'; clearTimeout(timer); timer = window.setTimeout(save, 600); };
  const close = async () => { await save(); sheet.remove(); onChange(); };

  const status = h('span', { class: 'status muted small' }, isNew ? 'New' : '');
  const title = h('input', { class: 'title-in', value: note.title, placeholder: 'Untitled', 'aria-label': 'Title' });
  title.addEventListener('input', () => { note.title = title.value; touch(); });
  const body = h('textarea', { class: 'body-in', placeholder: 'Write…', 'aria-label': 'Note' });
  body.value = note.body;
  const grow = () => { body.style.height = 'auto'; body.style.height = `${Math.max(220, body.scrollHeight)}px`; };
  body.addEventListener('input', () => { note.body = body.value; touch(); grow(); });
  const tags = h('input', { class: 'tags-in', value: note.tags.join(', '), placeholder: 'tags, comma separated', 'aria-label': 'Tags' });
  tags.addEventListener('input', () => { note.tags = [...new Set(tags.value.split(',').map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))]; touch(); });
  const folderSel = h('select', { 'aria-label': 'Collection' }, folderOptions(vault).map((o) => h('option', { value: o.folder?.id ?? '', selected: (o.folder?.id ?? null) === note.folder }, o.label)));
  folderSel.addEventListener('change', () => { note.folder = folderSel.value || null; touch(); });

  const attachWrap = h('div', { class: 'attachments' });
  const linkWrap = h('div', { class: 'links' });

  const imgIn = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true });
  const pick = (input: HTMLInputElement) => { guard.pickerOpen = true; input.click(); };
  for (const input of [imgIn, fileIn]) input.addEventListener('cancel', () => (guard.pickerOpen = false));
  imgIn.addEventListener('change', async () => {
    guard.pickerOpen = false;
    for (const f of imgIn.files ?? []) {
      try {
        const clean = await sanitizeImage(f);
        const id = await vault.putBlob(clean.bytes);
        note.attachments.push({ id, kind: 'image', name: f.name.replace(/\.[^.]+$/, '') + (clean.mime === 'image/png' ? '.png' : '.jpg'), mime: clean.mime, size: clean.bytes.length, w: clean.w, h: clean.h });
        dirty = true;
      } catch { toast(`Couldn't read ${f.name}`); }
    }
    imgIn.value = ''; await save(); renderAttachments();
  });
  fileIn.addEventListener('change', async () => {
    guard.pickerOpen = false;
    for (const f of fileIn.files ?? []) {
      if (f.size > MAX_FILE) { toast(`${f.name} is over 50 MB`); continue; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const id = await vault.putBlob(bytes);
      note.attachments.push({ id, kind: 'file', name: f.name, mime: f.type || 'application/octet-stream', size: f.size });
      dirty = true;
    }
    fileIn.value = ''; await save(); renderAttachments();
  });

  async function openAttachment(a: Attachment) {
    const bytes = await vault.getBlob(a.id);
    if (!bytes) { toast('Missing'); return; }
    const blob = new Blob([bytes], { type: a.mime });
    if (a.kind === 'image') {
      const url = objectUrl(blob);
      await modal<null>(a.name, (closeM) => h('div', { class: 'lightbox' }, h('img', { src: url, alt: '' }),
        h('div', { class: 'row end' },
          h('button', { class: 'ghost', onclick: () => download(blob, a.name) }, icon('download'), 'Save copy'),
          h('button', { onclick: () => closeM(null) }, 'Close'))));
    } else download(blob, a.name);
  }

  function renderAttachments() {
    clear(attachWrap);
    for (const a of note.attachments) {
      const thumb = h('div', { class: 'thumb' }, a.kind === 'image' ? h('div', { class: 'thumb-ph' }, icon('image')) : h('div', { class: 'thumb-file' }, icon('file'), h('span', {}, (a.name.split('.').pop() || '').slice(0, 5).toUpperCase())));
      if (a.kind === 'image') {
        void vault.getBlob(a.id).then((b) => {
          if (!b) return;
          thumb.replaceChildren(h('img', { src: objectUrl(new Blob([b], { type: a.mime })), alt: '' }));
        });
      }
      attachWrap.append(h('div', { class: 'att' },
        h('button', { class: 'att-open', onclick: () => openAttachment(a), 'aria-label': `Open ${a.name}` }, thumb,
          h('span', { class: 'att-name' }, a.name), h('span', { class: 'muted small' }, formatSize(a.size))),
        h('button', {
          class: 'icon-btn sm att-x', 'aria-label': `Remove ${a.name}`,
          onclick: async () => {
            if (!(await confirmBox('Remove attachment?', `${a.name} will be deleted from this note.`, 'Remove'))) return;
            note.attachments = note.attachments.filter((x) => x.id !== a.id);
            dirty = true; await save(); await vault.deleteBlob(a.id); renderAttachments();
          },
        }, icon('close'))));
    }
    attachWrap.append(
      h('button', { class: 'att-add', onclick: () => pick(imgIn) }, icon('image'), h('span', {}, 'Add image')),
      h('button', { class: 'att-add', onclick: () => pick(fileIn) }, icon('file'), h('span', {}, 'Attach file')));
  }

  function renderLinks() {
    clear(linkWrap);
    const out = note.links.map((id) => vault.note(id)).filter((n): n is Note => !!n);
    const back = vault.backlinks(note.id).filter((n) => n.id !== note.id);
    linkWrap.append(h('div', { class: 'chips' },
      out.map((n) => h('span', { class: 'chip link' },
        h('button', { onclick: async () => { await save(); openOther(n); } }, icon('link'), n.title || 'Untitled'),
        h('button', { class: 'x', 'aria-label': 'Unlink', onclick: () => { note.links = note.links.filter((x) => x !== n.id); touch(); renderLinks(); } }, '×'))),
      h('button', { class: 'chip add', onclick: linkPicker }, '+ Link a note')));
    if (back.length) {
      linkWrap.append(h('p', { class: 'muted small' }, 'Referenced by'),
        h('div', { class: 'chips' }, back.map((n) => h('button', { class: 'chip', onclick: async () => { await save(); openOther(n); } }, n.title || 'Untitled'))));
    }
  }

  async function linkPicker() {
    const candidates = vault.notes().filter((n) => n.id !== note.id && !note.links.includes(n.id));
    const picked = await modal<string>('Link a note', (closeM) => {
      const q = h('input', { type: 'search', placeholder: 'Filter', autocomplete: 'off' });
      const list = h('div', { class: 'menu scroll' });
      const draw = () => {
        clear(list);
        const s = q.value.toLowerCase();
        const items = candidates.filter((n) => (n.title + ' ' + n.tags.join(' ')).toLowerCase().includes(s)).slice(0, 50);
        if (!items.length) list.append(h('p', { class: 'muted' }, candidates.length ? 'No matches' : 'No other notes yet'));
        for (const n of items) list.append(h('button', { onclick: () => closeM(n.id) }, artCanvas(n.id, 36, 45, {}, 'mini'), n.title || 'Untitled'));
      };
      q.addEventListener('input', draw); draw();
      return h('div', {}, q, list);
    });
    if (picked) { note.links.push(picked); touch(); renderLinks(); }
  }

  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Note' },
    h('div', { class: 'sheet-top' },
      h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: close }, icon('back')),
      status,
      h('div', { class: 'grow' }),
      h('button', {
        class: 'icon-btn', 'aria-label': 'Delete note',
        onclick: async () => {
          if (!(await confirmBox('Delete note?', 'This note and its attachments will be permanently deleted from this device.', 'Delete'))) return;
          dirty = false; clearTimeout(timer);
          if (vault.note(note.id)) await vault.deleteNote(note.id);
          else for (const a of note.attachments) await vault.deleteBlob(a.id);
          sheet.remove(); onChange();
        },
      }, icon('trash'))),
    h('div', { class: 'sheet-body' },
      h('div', { class: 'banner' }, artCanvas(note.id, 720, 200)),
      title,
      h('div', { class: 'meta-row' }, h('label', {}, icon('folder'), folderSel), tags),
      body,
      h('h4', {}, 'Images & files'), attachWrap,
      h('h4', {}, 'Connections'), linkWrap,
      imgIn, fileIn));
  document.querySelector('.studio')!.append(sheet);
  renderAttachments(); renderLinks();
  requestAnimationFrame(grow);
  if (isNew) title.focus();
}
