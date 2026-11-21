import { hashSeed, renderArt } from '../core/art.ts';
import type { Note, Vault } from '../core/vault.ts';
import { h } from './dom.ts';

interface Node { id: string; kind: 'note' | 'image' | 'file'; label: string; x: number; y: number; vx: number; vy: number; r: number; note: Note; hue: number; tex?: HTMLCanvasElement }
interface Edge { a: Node; b: Node; kind: 'link' | 'attach' }

/** Force-directed "board" of notes, their links, and attached images/files. Pan, pinch/scroll-zoom, tap to open. */
export function renderBoard(vault: Vault, notes: Note[], open: (n: Note) => void): HTMLElement {
  const hide = vault.settings.hideTitles;
  const canvas = h('canvas', { class: 'board-canvas', 'aria-label': 'Board of linked notes' });
  const wrap = h('div', { class: 'board' }, canvas,
    h('p', { class: 'board-hint muted small' }, notes.length ? 'Drag to pan · scroll or pinch to zoom · tap a work to open' : 'No works to show here yet.'));
  const nodes: Node[] = [];
  const byId = new Map<string, Node>();
  const edges: Edge[] = [];
  const folderHue = (f: string | null) => (f ? hashSeed(f) % 360 : 40);
  notes.forEach((n, i) => {
    const ang = (i / Math.max(1, notes.length)) * Math.PI * 2;
    const node: Node = { id: n.id, kind: 'note', label: hide ? `No. ${i + 1}` : n.title || 'Untitled', x: Math.cos(ang) * 160, y: Math.sin(ang) * 160, vx: 0, vy: 0, r: 22, note: n, hue: folderHue(n.folder) };
    const tex = document.createElement('canvas'); tex.width = tex.height = 48;
    tex.getContext('2d')!.putImageData(new ImageData(renderArt(n.id, 48, 48), 48, 48), 0, 0);
    node.tex = tex;
    nodes.push(node); byId.set(n.id, node);
  });
  for (const n of notes) {
    const a = byId.get(n.id)!;
    for (const l of n.links) { const b = byId.get(l); if (b) edges.push({ a, b, kind: 'link' }); }
    n.attachments.forEach((att, k) => {
      const ang = (k / Math.max(1, n.attachments.length)) * Math.PI * 2;
      const an: Node = { id: att.id, kind: att.kind, label: hide ? '' : att.name, x: a.x + Math.cos(ang) * 50, y: a.y + Math.sin(ang) * 50, vx: 0, vy: 0, r: 9, note: n, hue: a.hue };
      nodes.push(an); edges.push({ a, b: an, kind: 'attach' });
    });
  }

  let scale = 1.25, panX = 0, panY = 0, raf = 0, ticks = 0;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const resize = () => {
    const r = wrap.getBoundingClientRect();
    canvas.width = Math.max(1, r.width * dpr); canvas.height = Math.max(1, r.height * dpr);
    canvas.style.width = `${r.width}px`; canvas.style.height = `${r.height}px`;
    kick();
  };
  const ro = new ResizeObserver(resize);
  requestAnimationFrame(() => { ro.observe(wrap); resize(); });

  function step() {
    const k = 0.9;
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const q = nodes[j];
        let dx = p.x - q.x, dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = ((p.kind === 'note' && q.kind === 'note') ? 2600 : 500) / d2;
        const d = Math.sqrt(d2);
        p.vx += (dx / d) * f; p.vy += (dy / d) * f; q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
      }
      p.vx -= p.x * 0.004; p.vy -= p.y * 0.004;
    }
    for (const e of edges) {
      const L = e.kind === 'link' ? 120 : 46;
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || 1;
      const f = (d - L) * 0.02;
      e.a.vx += (dx / d) * f; e.a.vy += (dy / d) * f; e.b.vx -= (dx / d) * f; e.b.vy -= (dy / d) * f;
    }
    for (const p of nodes) {
      if (p === dragging) continue;
      p.vx = Math.max(-20, Math.min(20, p.vx * k)); p.vy = Math.max(-20, Math.min(20, p.vy * k));
      p.x += p.vx; p.y += p.vy;
    }
  }
  function draw() {
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, W / 2 + panX * dpr, H / 2 + panY * dpr);
    for (const e of edges) {
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y);
      ctx.setLineDash(e.kind === 'attach' ? [3, 4] : []);
      ctx.strokeStyle = e.kind === 'link' ? 'rgba(232,216,176,0.55)' : 'rgba(232,216,176,0.25)';
      ctx.lineWidth = e.kind === 'link' ? 1.4 / scale : 1 / scale; ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const p of nodes) {
      if (p.kind === 'note') {
        ctx.save(); ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.clip();
        if (p.tex) ctx.drawImage(p.tex, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
        ctx.restore();
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${p.hue},55%,65%,0.9)`; ctx.lineWidth = 2; ctx.stroke();
      } else {
        ctx.fillStyle = p.kind === 'image' ? 'rgba(201,162,39,0.85)' : 'rgba(150,170,190,0.85)';
        if (p.kind === 'image') ctx.fillRect(p.x - p.r, p.y - p.r * 0.75, p.r * 2, p.r * 1.5);
        else { ctx.beginPath(); ctx.moveTo(p.x - p.r * 0.7, p.y - p.r); ctx.lineTo(p.x + p.r * 0.7, p.y - p.r); ctx.lineTo(p.x + p.r * 0.7, p.y + p.r); ctx.lineTo(p.x - p.r * 0.7, p.y + p.r); ctx.fill(); }
      }
      if (p.label && (p.kind === 'note' || scale > 1.4)) {
        ctx.font = `${p.kind === 'note' ? 12 : 10}px Georgia, serif`;
        ctx.textAlign = 'center'; ctx.fillStyle = p.kind === 'note' ? 'rgba(242,234,220,0.92)' : 'rgba(242,234,220,0.6)';
        const t = p.label.length > 26 ? p.label.slice(0, 25) + '…' : p.label;
        ctx.fillText(t, p.x, p.y + p.r + 15);
      }
    }
  }
  function loop() {
    if (!canvas.isConnected) { ro.disconnect(); return; }
    if (ticks-- > 0) step();
    draw();
    raf = ticks > 0 || dragging ? requestAnimationFrame(loop) : 0;
  }
  function kick(n = 400) { ticks = Math.max(ticks, n); if (!raf) raf = requestAnimationFrame(loop); }

  // interaction
  const pointers = new Map<number, { x: number; y: number }>();
  let dragging: Node | null = null;
  let moved = 0, pinch = 0;
  const toWorld = (cx: number, cy: number) => {
    const r = canvas.getBoundingClientRect();
    return { x: (cx - r.left - r.width / 2 - panX) / scale, y: (cy - r.top - r.height / 2 - panY) / scale };
  };
  const hit = (cx: number, cy: number) => {
    const w = toWorld(cx, cy);
    let best: Node | null = null, bd = Infinity;
    for (const p of nodes) { const d = Math.hypot(p.x - w.x, p.y - w.y); if (d < p.r + 8 && d < bd) { bd = d; best = p; } }
    return best;
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0;
    if (pointers.size === 1) dragging = hit(e.clientX, e.clientY);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); dragging = null; }
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved += Math.abs(dx) + Math.abs(dy);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) scale = Math.min(4, Math.max(0.3, scale * (d / pinch)));
      pinch = d; kick(1); return;
    }
    if (dragging) { const w = toWorld(e.clientX, e.clientY); dragging.x = w.x; dragging.y = w.y; dragging.vx = dragging.vy = 0; kick(120); }
    else { panX += dx; panY += dy; kick(1); }
  });
  const up = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (dragging && moved < 8) open(dragging.note);
    dragging = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); scale = Math.min(4, Math.max(0.3, scale * Math.exp(-e.deltaY * 0.0015))); kick(1); }, { passive: false });
  kick();
  return wrap;
}
