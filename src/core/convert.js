'use strict';
// Pro tools without VS Code: write a topic tree (formats.toModel) as KM, FreeMind MM, OPML or a Markdown outline; read
// a Markdown heading/list outline into a topic tree; the task table (rows, CSV, Markdown); a one-page PDF around a
// JPEG picture of the map. Every walk is iterative.
const X = require('./xmldoc');
const { PROGRESS_PERCENT, percentToProgress } = require('./formats');

const KINDS = {
  km: { ext: '.km', label: 'KityMinder (.km)' },
  mm: { ext: '.mm', label: 'FreeMind (.mm)' },
  opml: { ext: '.opml', label: 'OPML (.opml)' },
  md: { ext: '.md', label: 'Markdown outline (.md)' },
};

const topic = (title) => ({ title, note: '', priority: 0, progress: 0, link: '', folded: false, side: '', kids: [] });

/** Preorder [topic, depth, parent] list. */
function walk(root) {
  const out = [];
  const st = [[root, 0, null]];
  while (st.length) {
    const [t, d, p] = st.pop();
    out.push([t, d, p]);
    for (let i = t.kids.length - 1; i >= 0; i--) st.push([t.kids[i], d + 1, t]);
  }
  return out;
}

// ---------- KM ----------
function newId() {
  let s = '';
  for (let i = 0; i < 12; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)];
  return s;
}
function toKm(root) {
  const now = Date.now();
  const mk = (t) => {
    const data = { id: newId(), created: now, text: t.title };
    if (t.note) data.note = t.note;
    if (t.priority) data.priority = t.priority;
    if (t.progress) data.progress = t.progress;
    if (t.link) data.hyperlink = t.link;
    if (t.folded && t.kids.length) data.expandState = 'collapse';
    return { data, children: [] };
  };
  const out = mk(root);
  const st = [[root, out]];
  while (st.length) {
    const [t, o] = st.pop();
    for (const k of t.kids) { const ko = mk(k); o.children.push(ko); st.push([k, ko]); }
  }
  return JSON.stringify({ root: out, template: 'default', theme: 'fresh-blue', version: '1.4.43' }, null, 4) + '\n';
}

// ---------- FreeMind ----------
function toMm(root) {
  const now = String(Date.now());
  let seq = Math.floor(Math.random() * 1e8);
  const lines = ['<map version="1.0.1">', '<!-- To view this file, open it with a FreeMind compatible mind map editor -->'];
  const open = (t, d, idx) => {
    const a = [`TEXT="${X.escAttr(t.title)}"`, `ID="ID_${seq++}"`, `CREATED="${now}"`, `MODIFIED="${now}"`];
    if (d === 1) a.push(`POSITION="${t.side || (idx % 2 === 0 ? 'right' : 'left')}"`);
    if (t.folded && t.kids.length) a.push('FOLDED="true"');
    if (t.link) a.push(`LINK="${X.escAttr(t.link)}"`);
    const inner = [];
    if (t.note) inner.push(`<richcontent TYPE="NOTE"><html><head></head><body>${t.note.split('\n').map((l) => `<p>${X.escText(l)}</p>`).join('')}</body></html></richcontent>`);
    if (t.priority) inner.push(`<icon BUILTIN="full-${t.priority}"/>`);
    if (t.progress) inner.push(`<icon BUILTIN="${Math.round((t.progress - 1) / 2) * 25}%"/>`);
    return { head: `<node ${a.join(' ')}`, inner };
  };
  // iterative writer with explicit close markers
  const st = [[root, 0, 0]];
  while (st.length) {
    const it = st.pop();
    if (it === 'close') { lines.push('</node>'); continue; }
    const [t, d, idx] = it;
    const o = open(t, d, idx);
    if (!t.kids.length && !o.inner.length) { lines.push(`${o.head}/>`); continue; }
    lines.push(`${o.head}>`);
    lines.push(...o.inner);
    st.push('close');
    for (let i = t.kids.length - 1; i >= 0; i--) st.push([t.kids[i], d + 1, i]);
  }
  lines.push('</map>');
  return lines.join('\n') + '\n';
}

// ---------- OPML ----------
function toOpml(root, title) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<opml version="2.0">', '  <head>', `    <title>${X.escText(title || root.title)}</title>`, '  </head>', '  <body>'];
  const attrs = (t) => {
    const a = [`text="${X.escAttr(t.title)}"`];
    if (t.note) a.push(`_note="${X.escAttr(t.note)}"`);
    if (t.priority) a.push(`_priority="${t.priority}"`);
    if (t.progress) a.push(`_progress="${PROGRESS_PERCENT(t.progress)}"`);
    if (t.link) a.push(`url="${X.escAttr(t.link)}"`);
    return a.join(' ');
  };
  const st = [];
  const top = root.virtual ? root.kids : [root];
  for (let i = top.length - 1; i >= 0; i--) st.push([top[i], 2]);
  while (st.length) {
    const it = st.pop();
    if (typeof it === 'string') { lines.push(it); continue; }
    const [t, d] = it;
    const ind = '  '.repeat(d);
    if (!t.kids.length) { lines.push(`${ind}<outline ${attrs(t)}/>`); continue; }
    lines.push(`${ind}<outline ${attrs(t)}>`);
    st.push(`${ind}</outline>`);
    for (let i = t.kids.length - 1; i >= 0; i--) st.push([t.kids[i], d + 1]);
  }
  lines.push('  </body>', '</opml>');
  return lines.join('\n') + '\n';
}

// ---------- Markdown ----------
const mdInline = (s) => String(s).replace(/\n+/g, ' ').trim();
function toMarkdown(root) {
  const out = [];
  const titleOf = (t) => (t.link ? `[${mdInline(t.title).replace(/[[\]]/g, '\\$&')}](${t.link.replace(/[()\s]/g, encodeURIComponent)})` : mdInline(t.title));
  for (const [t, d] of walk(root)) {
    if (root.virtual && t === root) continue;
    const dd = root.virtual ? d - 1 : d;
    if (dd <= 1) {
      out.push(`${dd === 0 ? '#' : '##'} ${titleOf(t) || '(no title)'}`, '');
      if (t.note) out.push(...t.note.trim().split('\n').map((l) => `> ${l}`.trimEnd()), '');
    } else {
      const ind = '  '.repeat(dd - 2);
      const box = t.progress === 9 ? '[x] ' : t.progress ? '[ ] ' : '';
      out.push(`${ind}- ${box}${titleOf(t) || '(no title)'}`);
      if (t.note) for (const l of t.note.trim().split('\n')) out.push(`${ind}  > ${l}`.trimEnd());
    }
  }
  // a list ends with one blank line before the next heading
  const res = [];
  for (let i = 0; i < out.length; i++) {
    res.push(out[i]);
    const isList = /^\s*- /.test(out[i]) || /^\s+> ?/.test(out[i]);
    if (isList && out[i + 1] !== undefined && /^#/.test(out[i + 1])) res.push('');
  }
  while (res.length && res[res.length - 1] === '') res.pop();
  return res.join('\n') + '\n';
}

/** A Markdown heading/list outline as a topic tree. Paragraphs become the note of the topic above them. */
function fromMarkdown(text, fallbackTitle) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  if (lines[0] === '---') { // front matter
    const e = lines.indexOf('---', 1);
    if (e > 0) i = e + 1;
  }
  const root = topic(fallbackTitle || 'Outline');
  const heads = [{ level: 0, t: root }]; // heading stack
  let list = []; // list stack: { indent, t }
  let last = root;
  let fence = null;
  const parseTitle = (s) => {
    const t = topic('');
    let x = s.trim();
    const box = /^\[([ xX])\]\s+/.exec(x);
    if (box) { t.progress = box[1] === ' ' ? 1 : 9; x = x.slice(box[0].length); }
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(x);
    if (link) { x = link[1]; t.link = decodeURIComponent(link[2]); }
    t.title = x.replace(/\\([[\]])/g, '$1');
    return t;
  };
  const addNote = (t, s) => { t.note = t.note ? `${t.note}\n${s}` : s; };
  let h1count = 0;
  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (fence) { addNote(last, ln); if (ln.trim().startsWith(fence)) fence = null; continue; }
    const f = /^\s*(```|~~~)/.exec(ln);
    if (f) { fence = f[1]; addNote(last, ln); continue; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(ln);
    if (h) {
      const level = h[1].length;
      if (level === 1) h1count++;
      list = [];
      while (heads.length > 1 && heads[heads.length - 1].level >= level) heads.pop();
      const t = parseTitle(h[2]);
      heads[heads.length - 1].t.kids.push(t);
      heads.push({ level, t });
      last = t;
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(ln);
    if (q) { addNote(last, q[1]); continue; } // a quote is the note of the topic above it (how notes are written)
    const li = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(ln);
    if (li) {
      const indent = li[1].replace(/\t/g, '    ').length;
      while (list.length && list[list.length - 1].indent >= indent) list.pop();
      const parent = list.length ? list[list.length - 1].t : heads[heads.length - 1].t;
      const t = parseTitle(li[2]);
      parent.kids.push(t);
      list.push({ indent, t });
      last = t;
      continue;
    }
    if (!ln.trim()) { if (last.note && !/\n\n$/.test(last.note) && last.note.trim()) last.note += '\n'; continue; }
    if (list.length && /^\s+\S/.test(ln)) { addNote(last, ln.trim()); continue; }
    list = [];
    const owner = heads[heads.length - 1].t;
    addNote(owner, ln.trim());
    last = owner;
  }
  const clean = (t) => { t.note = t.note.replace(/\n{3,}/g, '\n\n').trim(); };
  for (const [t] of walk(root)) clean(t);
  // one H1 that holds everything: it is the root
  if (h1count === 1 && root.kids.length === 1 && !root.note) return root.kids[0];
  return root;
}

function write(root, kind, title) {
  if (kind === 'km') return toKm(root.virtual ? { ...root, virtual: false } : root);
  if (kind === 'mm') return toMm(root.virtual ? { ...root, virtual: false } : root);
  if (kind === 'opml') return toOpml(root, title);
  if (kind === 'md') return toMarkdown(root);
  throw new Error(`Unknown format ${kind}`);
}

// ---------- task table ----------
function taskRows(root) {
  const rows = [];
  const st = [[root, []]];
  while (st.length) {
    const [t, crumbs] = st.pop();
    const title = mdInline(t.title);
    if (!t.virtual) {
      rows.push({
        path: (t.path || []).join('.'), id: t.path ? t.path.join('.') : '', depth: crumbs.length, title, branch: crumbs.join(' > '),
        priority: t.priority || 0, progress: t.progress ? PROGRESS_PERCENT(t.progress) : null, note: t.note || '', link: t.link || '', kids: t.kids.length,
      });
    }
    const next = t.virtual ? crumbs : crumbs.concat(title);
    for (let i = t.kids.length - 1; i >= 0; i--) st.push([t.kids[i], next]);
  }
  return rows;
}
const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
function rowsCsv(rows) {
  const head = ['Topic', 'Branch', 'Level', 'Priority', 'Progress %', 'Note', 'Link'];
  const out = [head.join(',')];
  for (const r of rows) out.push([r.title, r.branch, r.depth, r.priority || '', r.progress === null ? '' : r.progress, r.note, r.link].map(csvCell).join(','));
  return out.join('\r\n') + '\r\n';
}
const mdCell = (v) => String(v === null || v === undefined ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
function rowsMarkdown(rows, title) {
  const out = [`# Tasks: ${mdCell(title)}`, '', `${rows.length} topics.`, '', '| Topic | Branch | Priority | Progress | Note | Link |', '| --- | --- | --- | --- | --- | --- |'];
  for (const r of rows) out.push(`| ${mdCell(r.title)} | ${mdCell(r.branch)} | ${r.priority || ''} | ${r.progress === null ? '' : `${r.progress} %`} | ${mdCell(r.note)} | ${mdCell(r.link)} |`);
  return out.join('\n') + '\n';
}
/** Filter: { q, priority: ''|'any'|'none'|'1'..'9', progress: ''|'none'|'open'|'done', note: bool } */
function filterRows(rows, f) {
  const q = String((f && f.q) || '').toLowerCase().trim();
  return rows.filter((r) => {
    if (q && !`${r.title}\n${r.branch}\n${r.note}\n${r.link}`.toLowerCase().includes(q)) return false;
    const p = f && f.priority;
    if (p === 'any' && !r.priority) return false;
    if (p === 'none' && r.priority) return false;
    if (p && /^\d$/.test(p) && r.priority !== Number(p)) return false;
    const g = f && f.progress;
    if (g === 'none' && r.progress !== null) return false;
    if (g === 'open' && (r.progress === null || r.progress >= 100)) return false;
    if (g === 'done' && r.progress !== 100) return false;
    if (f && f.note && !r.note) return false;
    return true;
  });
}

// ---------- PDF ----------
/** A one-page PDF that shows a JPEG picture. w, h: pixel size of the JPEG; scale: pixels per CSS pixel. Page size in
 *  points = CSS pixels * 0.75 (96 dpi). */
function pdfFromJpeg(jpeg, w, h, scale) {
  const pw = +(w / (scale || 1) * 0.75).toFixed(2), ph = +(h / (scale || 1) * 0.75).toFixed(2);
  const content = Buffer.from(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q\n`, 'latin1');
  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`, 'latin1'),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, 'latin1'), jpeg, Buffer.from('\nendstream', 'latin1')]),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('endstream', 'latin1')]),
    Buffer.from('<< /Producer (Mindmap Editor by Zovo) >>', 'latin1'),
  ];
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let pos = parts[0].length;
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(pos);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(b); pos += b.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
/** Width and height of a baseline or progressive JPEG, or null. */
function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

module.exports = { KINDS, topic, walk, toKm, toMm, toOpml, toMarkdown, fromMarkdown, write, taskRows, rowsCsv, rowsMarkdown, filterRows, pdfFromJpeg, jpegSize, percentToProgress };
