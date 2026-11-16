'use strict';
// The three file formats as editable documents: KityMinder JSON (.km), FreeMind/Freeplane XML (.mm) and OPML.
// load(text, fmt) -> doc; toModel(doc) -> the plain topic tree the webview draws; applyOp(doc, op) changes the doc in
// place; save(doc) -> text. Edits change only the fields they touch: every other key, attribute, comment and
// whitespace in the file stays as it was (unknown KM keys, Freeplane styles and hooks, OPML head and custom
// attributes). Topics are addressed by their path of child indexes from the root, e.g. [0, 2].
const X = require('./xmldoc');

const MAX_TEXT = 20000;

/** 'km' | 'mm' | 'opml' | '' from a file name. */
function formatOf(name) {
  const m = /\.(km|mm|opml)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

class MapError extends Error {
  constructor(msg, line) { super(msg); this.line = line || 0; }
}

// Progress uses the KityMinder scale: 0 none, 1 = 0 %, 3 = 25 %, 5 = 50 %, 7 = 75 %, 9 = 100 % (2, 4, 6, 8 in between).
const PROGRESS_PERCENT = (p) => Math.round(((p - 1) / 8) * 100);
const percentToProgress = (pct) => Math.max(1, Math.min(9, Math.round(Number(pct) / 12.5) + 1));
const nearestQuarter = (p) => Math.round((p - 1) / 2) * 25; // 1..9 -> 0, 25, 50, 75, 100
const clampInt = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0; };

// ---------------------------------------------------------------- KM
function genId() {
  let s = '';
  for (let i = 0; i < 12; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)];
  return s;
}

const KM = {
  load(text) {
    let obj;
    const src = String(text).replace(/^﻿/, '');
    if (!src.trim()) throw new MapError('The file is empty.');
    try { obj = JSON.parse(src); } catch (e) {
      const m = /position (\d+)/.exec(e.message);
      let line = 0;
      if (m) line = src.slice(0, Number(m[1])).split('\n').length;
      throw new MapError(`This .km file is not valid JSON: ${e.message.split('\n')[0]}`, line);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !obj.root || typeof obj.root !== 'object') throw new MapError('This .km file has no "root" topic.');
    const st = [obj.root];
    while (st.length) {
      const n = st.pop();
      if (!n || typeof n !== 'object' || Array.isArray(n)) throw new MapError('This .km file has a topic that is not an object.');
      if (!n.data || typeof n.data !== 'object') n.data = {};
      if (n.children !== undefined && !Array.isArray(n.children)) throw new MapError('This .km file has "children" that is not a list.');
      for (const c of n.children || []) st.push(c);
    }
    const m = /^\{\s*\n([ \t]+)"/.exec(src);
    return { fmt: 'km', obj, indent: m ? m[1] : (/^\{\s*\n/.test(src) ? 2 : 0), eol: /\r\n/.test(src) ? '\r\n' : '\n', finalNl: /\n$/.test(src), bom: /^﻿/.test(text) };
  },
  save(d) {
    let s = JSON.stringify(d.obj, null, d.indent || undefined);
    if (d.eol === '\r\n') s = s.replace(/\n/g, '\r\n');
    if (d.finalNl) s += d.eol;
    return (d.bom ? '﻿' : '') + s;
  },
  root: (d) => d.obj.root,
  kids: (n) => (Array.isArray(n.children) ? n.children : []),
  get(n) {
    const dt = n.data || {};
    return {
      title: typeof dt.text === 'string' ? dt.text : dt.text === undefined || dt.text === null ? '' : String(dt.text),
      note: typeof dt.note === 'string' ? dt.note : '',
      priority: clampInt(dt.priority, 0, 9),
      progress: clampInt(dt.progress, 0, 9),
      link: typeof dt.hyperlink === 'string' ? dt.hyperlink : '',
      folded: dt.expandState === 'collapse',
      side: '',
      rich: false,
    };
  },
  set(n, field, v) {
    const dt = n.data || (n.data = {});
    if (field === 'title') dt.text = v;
    else if (field === 'note') { if (v) dt.note = v; else delete dt.note; }
    else if (field === 'priority') { if (v) dt.priority = v; else delete dt.priority; }
    else if (field === 'progress') { if (v) dt.progress = v; else delete dt.progress; }
    else if (field === 'link') { if (v) dt.hyperlink = v; else { delete dt.hyperlink; delete dt.hyperlinkTitle; } }
    else if (field === 'folded') { if (v) dt.expandState = 'collapse'; else if (dt.expandState !== undefined) dt.expandState = 'expand'; }
  },
  make(title) { return { data: { id: genId(), created: Date.now(), text: title }, children: [] }; },
  insert(d, parent, i, node) { if (!Array.isArray(parent.children)) parent.children = []; parent.children.splice(i, 0, node); },
  remove(d, parent, i) { return parent.children.splice(i, 1)[0]; },
  placed() {},
  layout(d) {
    const t = String(d.obj.template || '');
    if (t === 'right') return 'right';
    if (t === 'structure' || t === 'filetree') return 'tree';
    if (t === 'tianpan' || t === 'fish-bone') return 'map';
    return 'map';
  },
};

// ---------------------------------------------------------------- shared XML helpers
function xmlLoad(text, what) {
  const src = String(text).replace(/^﻿/, '');
  if (!src.trim()) throw new MapError('The file is empty.');
  let doc;
  try { doc = X.parse(src); } catch (e) { throw new MapError(`This ${what} file is not valid XML: ${e.message}`, e.line); }
  return { doc, bom: /^﻿/.test(text) };
}

// ---------------------------------------------------------------- FreeMind / Freeplane
const MM = {
  load(text) {
    const { doc, bom } = xmlLoad(text, '.mm');
    const map = X.rootEl(doc);
    if (!map || map.name !== 'map') throw new MapError(`This .mm file is not a FreeMind or Freeplane map (the first element is <${map ? map.name : '?'}>, not <map>).`);
    const root = X.firstEl(map, 'node');
    if (!root) throw new MapError('This .mm file has no root topic (<node> inside <map>).');
    return { fmt: 'mm', doc, map, bom };
  },
  save(d) { return (d.bom ? '﻿' : '') + X.serialize(d.doc); },
  root: (d) => X.firstEl(d.map, 'node'),
  kids: (n) => X.elems(n, 'node'),
  rich(n, type) { return X.elems(n, 'richcontent').find((r) => String(X.attr(r, 'TYPE') || '').toUpperCase() === type) || null; },
  get(n) {
    const icons = X.elems(n, 'icon').map((i) => X.attr(i, 'BUILTIN') || '');
    let priority = 0, progress = 0;
    for (const ic of icons) {
      let m = /^full-(\d)$/.exec(ic);
      if (m && !priority) priority = Number(m[1]);
      m = /^(0|25|50|75|100)%$/.exec(ic);
      if (m && !progress) progress = percentToProgress(m[1]);
    }
    let title = X.attrCI(n, 'TEXT');
    let rich = false;
    if (title === undefined) {
      const r = MM.rich(n, 'NODE');
      title = r ? X.htmlText(r) : (X.attr(n, 'LOCALIZED_TEXT') || '');
      rich = !!r;
    }
    const nr = MM.rich(n, 'NOTE');
    const side = String(X.attr(n, 'POSITION') || '').toLowerCase();
    return {
      title, note: nr ? X.htmlText(nr) : '', priority, progress, link: X.attr(n, 'LINK') || '',
      folded: X.attr(n, 'FOLDED') === 'true', side: side === 'left' || side === 'right' ? side : '', rich,
    };
  },
  set(n, field, v, d) {
    if (field === 'title') {
      const r = MM.rich(n, 'NODE');
      if (r) X.removeEl(n, r);
      const a = n.attrs.find((x) => x.name.toUpperCase() === 'TEXT');
      X.setAttr(n, a ? a.name : 'TEXT', v);
    } else if (field === 'note') {
      const r = MM.rich(n, 'NOTE');
      if (!v) { if (r) X.removeEl(n, r); }
      else {
        const html = `<html><head></head><body>${String(v).split(/\r?\n/).map((l) => `<p>${X.escText(l)}</p>`).join('')}</body></html>`;
        if (r) {
          X.setKids(r, X.fragment(html));
          if (X.attr(r, 'CONTENT-TYPE') !== undefined) X.setAttr(r, 'CONTENT-TYPE', 'xml/');
        } else {
          const nr = X.el('richcontent', [['TYPE', 'NOTE']]);
          X.setKids(nr, X.fragment(html));
          X.insertEl(d.doc, n, nr, X.firstEl(n, 'node'));
        }
      }
    } else if (field === 'priority' || field === 'progress') {
      const re = field === 'priority' ? /^full-\d$/ : /^(0|25|50|75|100)%$/;
      const old = X.elems(n, 'icon').filter((i) => re.test(X.attr(i, 'BUILTIN') || ''));
      for (const o of old) X.removeEl(n, o);
      if (v) {
        const name = field === 'priority' ? `full-${v}` : `${nearestQuarter(v)}%`;
        X.insertEl(d.doc, n, X.el('icon', [['BUILTIN', name]]), X.firstEl(n, 'node'));
      }
    } else if (field === 'link') X.setAttr(n, 'LINK', v || undefined);
    else if (field === 'folded') X.setAttr(n, 'FOLDED', v ? 'true' : (X.attr(n, 'FOLDED') !== undefined ? 'false' : undefined));
    if (X.attr(n, 'MODIFIED') !== undefined) X.setAttr(n, 'MODIFIED', String(Date.now()));
  },
  make(title) {
    const now = String(Date.now());
    return X.el('node', [['TEXT', title], ['ID', `ID_${Math.floor(Math.random() * 2e9)}`], ['CREATED', now], ['MODIFIED', now]]);
  },
  insert(d, parent, i, node) { const ks = MM.kids(parent); X.insertEl(d.doc, parent, node, ks[i] || null); },
  remove(d, parent, i) { const k = MM.kids(parent)[i]; X.removeEl(parent, k); return k; },
  /** A main topic needs a side in FreeMind: the side with fewer topics. */
  placed(d, parent, node) {
    if (parent !== MM.root(d)) return;
    if (X.attr(node, 'POSITION') !== undefined) return;
    const ks = MM.kids(parent).filter((k) => k !== node);
    const left = ks.filter((k) => X.attr(k, 'POSITION') === 'left').length;
    X.setAttr(node, 'POSITION', left < ks.length - left ? 'left' : 'right');
  },
  layout() { return 'map'; },
};

// ---------------------------------------------------------------- OPML
const OPML = {
  load(text) {
    const { doc, bom } = xmlLoad(text, 'OPML');
    const opml = X.rootEl(doc);
    if (!opml || opml.name !== 'opml') throw new MapError(`This file is not OPML (the first element is <${opml ? opml.name : '?'}>, not <opml>).`);
    const body = X.firstEl(opml, 'body');
    if (!body) throw new MapError('This OPML file has no <body>.');
    const outs = X.elems(body, 'outline');
    const head = X.firstEl(opml, 'head');
    const title = head && X.firstEl(head, 'title') ? X.textContent(X.firstEl(head, 'title')).trim() : '';
    // One outline in the body is the root topic. With several (or none), the file title is a root that is not saved.
    const single = outs.length === 1;
    return { fmt: 'opml', doc, opml, body, bom, single, title };
  },
  save(d) { return (d.bom ? '﻿' : '') + X.serialize(d.doc); },
  root: (d) => (d.single ? X.elems(d.body, 'outline')[0] : d.body),
  kids: (n) => X.elems(n, 'outline'),
  get(n, d) {
    if (n.name === 'body') return { title: d && d.title ? d.title : 'Outline', note: '', priority: 0, progress: 0, link: '', folded: false, side: '', rich: false, virtual: true };
    let progress = 0;
    const pr = X.attr(n, '_progress');
    if (pr !== undefined && /^\d+$/.test(pr)) progress = percentToProgress(pr);
    else if (X.attr(n, '_complete') === 'true') progress = 9;
    return {
      title: X.attr(n, 'text') !== undefined ? X.attr(n, 'text') : (X.attr(n, 'title') || ''),
      note: X.attr(n, '_note') || '',
      priority: clampInt(X.attr(n, '_priority'), 0, 9),
      progress,
      link: X.attr(n, 'url') || X.attr(n, 'htmlUrl') || '',
      folded: false, side: '', rich: false,
    };
  },
  set(n, field, v) {
    if (n.name === 'body') return; // the stand-in root of an outline with several top items is not in the file
    if (field === 'title') X.setAttr(n, 'text', v);
    else if (field === 'note') X.setAttr(n, '_note', v || undefined);
    else if (field === 'priority') X.setAttr(n, '_priority', v ? String(v) : undefined);
    else if (field === 'progress') {
      if (X.attr(n, '_complete') !== undefined && !X.attr(n, '_progress')) X.setAttr(n, '_complete', v === 9 ? 'true' : undefined);
      X.setAttr(n, '_progress', v ? String(PROGRESS_PERCENT(v)) : undefined);
    } else if (field === 'link') {
      if (X.attr(n, 'url') === undefined && X.attr(n, 'htmlUrl') !== undefined) X.setAttr(n, 'htmlUrl', v || undefined);
      else X.setAttr(n, 'url', v || undefined);
    }
  },
  make(title) { return X.el('outline', [['text', title]]); },
  insert(d, parent, i, node) { const ks = OPML.kids(parent); X.insertEl(d.doc, parent, node, ks[i] || null); },
  remove(d, parent, i) { const k = OPML.kids(parent)[i]; X.removeEl(parent, k); return k; },
  placed() {},
  layout() { return 'right'; },
};

const ADAPTERS = { km: KM, mm: MM, opml: OPML };

function load(text, fmt) {
  const A = ADAPTERS[fmt];
  if (!A) throw new MapError(`Unknown mind map format "${fmt}".`);
  return A.load(text);
}
const save = (d) => ADAPTERS[d.fmt].save(d);

/** The topic tree for the webview: { path, title, note, priority, progress, link, folded, side, rich, kids }. */
function toModel(d) {
  const A = ADAPTERS[d.fmt];
  const mk = (n, path) => {
    const g = A.get(n, d);
    const t = { path, title: g.title.length > MAX_TEXT ? g.title.slice(0, MAX_TEXT) + '…' : g.title, note: g.note, priority: g.priority, progress: g.progress, link: g.link, folded: g.folded, side: g.side, rich: g.rich, kids: [] };
    if (g.virtual) t.virtual = true;
    return t;
  };
  const root = mk(A.root(d), []);
  const st = [[A.root(d), root]];
  let count = 0;
  while (st.length) {
    const [n, t] = st.pop();
    count++;
    A.kids(n).forEach((c, i) => { const ct = mk(c, t.path.concat(i)); t.kids.push(ct); st.push([c, ct]); });
  }
  return { fmt: d.fmt, root, count, layout: A.layout(d) };
}

function nodeAt(d, path) {
  const A = ADAPTERS[d.fmt];
  let n = A.root(d), parent = null;
  for (const i of path) {
    const ks = A.kids(n);
    if (!Number.isInteger(i) || i < 0 || i >= ks.length) return null;
    parent = n; n = ks[i];
  }
  return { n, parent };
}

const samePrefix = (a, b) => a.length <= b.length && a.every((x, i) => x === b[i]);

/**
 * Applies one edit. op: { op: 'rename'|'addChild'|'addSibling'|'delete'|'move'|'fold'|'set'|'foldAll', path, ... }.
 * Returns { changed, select } (the path to select afterwards) or throws MapError.
 */
function applyOp(d, op) {
  const A = ADAPTERS[d.fmt];
  const path = Array.isArray(op.path) ? op.path.map(Number) : [];
  const at = nodeAt(d, path);
  if (!at) throw new MapError('That topic is no longer in the file.');
  const isRoot = path.length === 0;
  const virtualRoot = d.fmt === 'opml' && !d.single;
  const text = (v) => String(v === undefined || v === null ? '' : v).slice(0, MAX_TEXT);
  switch (op.op) {
    case 'rename': {
      if (isRoot && virtualRoot) return { changed: false, select: path };
      const g = A.get(at.n, d);
      const t = text(op.text);
      if (g.title === t && !g.rich) return { changed: false, select: path };
      A.set(at.n, 'title', t, d);
      return { changed: true, select: path };
    }
    case 'addChild': {
      const node = A.make(text(op.text || 'New topic'));
      const i = A.kids(at.n).length;
      A.insert(d, at.n, i, node);
      A.placed(d, at.n, node);
      if (A.get(at.n, d).folded) A.set(at.n, 'folded', false, d);
      return { changed: true, select: path.concat(i), edit: true };
    }
    case 'addSibling': {
      if (isRoot) return applyOp(d, { ...op, op: 'addChild' });
      const i = path[path.length - 1] + (op.before ? 0 : 1);
      const node = A.make(text(op.text || 'New topic'));
      A.insert(d, at.parent, i, node);
      A.placed(d, at.parent, node);
      return { changed: true, select: path.slice(0, -1).concat(i), edit: true };
    }
    case 'delete': {
      if (isRoot) throw new MapError('The root topic cannot be deleted.');
      const i = path[path.length - 1];
      A.remove(d, at.parent, i);
      const left = A.kids(at.parent).length;
      const sel = left ? path.slice(0, -1).concat(Math.min(i, left - 1)) : path.slice(0, -1);
      return { changed: true, select: sel };
    }
    case 'move': {
      if (isRoot) throw new MapError('The root topic cannot be moved.');
      const to = Array.isArray(op.to) ? op.to.map(Number) : null;
      if (!to) throw new MapError('No target for the move.');
      if (samePrefix(path, to)) throw new MapError('A topic cannot move into its own branch.');
      const target = nodeAt(d, to);
      if (!target) throw new MapError('The target topic is no longer in the file.');
      const from = path[path.length - 1];
      const sameParent = to.length === path.length - 1 && samePrefix(to, path);
      let idx = Number.isInteger(op.index) ? op.index : A.kids(target.n).length;
      if (sameParent && idx > from) idx--;
      if (sameParent && idx === from) return { changed: false, select: path };
      // paths after the removal: a target that sits after the moved topic in the same parent shifts by one
      const node = A.remove(d, at.parent, from);
      const t2 = nodeAt(d, adjustAfterRemoval(to, path));
      const tn = t2 ? t2.n : target.n;
      idx = Math.max(0, Math.min(idx, A.kids(tn).length));
      A.insert(d, tn, idx, node);
      A.placed(d, tn, node);
      if (A.get(tn, d).folded) A.set(tn, 'folded', false, d);
      return { changed: true, select: adjustAfterRemoval(to, path).concat(idx) };
    }
    case 'fold': {
      if (!A.kids(at.n).length || d.fmt === 'opml') return { changed: false, select: path };
      const f = !!op.folded;
      if (A.get(at.n, d).folded === f) return { changed: false, select: path };
      A.set(at.n, 'folded', f, d);
      return { changed: true, select: path };
    }
    case 'foldAll': {
      if (d.fmt === 'opml') return { changed: false, select: path };
      let changed = false;
      const st = A.kids(A.root(d)).slice();
      while (st.length) {
        const n = st.pop();
        const ks = A.kids(n);
        if (ks.length && A.get(n, d).folded !== !!op.folded) { A.set(n, 'folded', !!op.folded, d); changed = true; }
        for (const k of ks) st.push(k);
      }
      return { changed, select: [] };
    }
    case 'set': {
      if (isRoot && virtualRoot) return { changed: false, select: path };
      const f = op.field;
      if (!['note', 'priority', 'progress', 'link'].includes(f)) throw new MapError(`Unknown field "${f}".`);
      const g = A.get(at.n, d);
      let v = op.value;
      if (f === 'priority' || f === 'progress') v = clampInt(v, 0, 9);
      else v = text(v).replace(f === 'link' ? /[\r\n]/g : /$^/, '');
      if (f === 'note') v = v.replace(/\r\n/g, '\n');
      if (f === 'progress' && d.fmt === 'mm' && v) v = nearestQuarter(v) / 12.5 + 1;
      if (g[f] === v) return { changed: false, select: path };
      A.set(at.n, f, v, d);
      return { changed: true, select: path };
    }
    default: throw new MapError(`Unknown edit "${op.op}".`);
  }
}

/** A path as it reads after the topic at `removed` was taken out of its parent. */
function adjustAfterRemoval(p, removed) {
  const k = removed.length - 1;
  if (p.length > k && samePrefix(removed.slice(0, k), p) && p[k] > removed[k]) {
    const q = p.slice(); q[k]--; return q;
  }
  return p;
}

/** One minimal replace: the changed middle between the common start and the common end of two texts. */
function minimalEdit(oldText, newText) {
  let a = 0;
  const max = Math.min(oldText.length, newText.length);
  while (a < max && oldText.charCodeAt(a) === newText.charCodeAt(a)) a++;
  let b = 0;
  while (b < max - a && oldText.charCodeAt(oldText.length - 1 - b) === newText.charCodeAt(newText.length - 1 - b)) b++;
  return { start: a, end: oldText.length - b, text: newText.slice(a, newText.length - b) };
}


/** Small replaces that turn oldText into newText: whole changed lines found by a line diff (LCS) of the part between
 *  the common start and end, each trimmed to its changed characters. Offsets are in oldText, in order, never
 *  overlapping. Falls back to one minimal replace when the changed part is very large. */
function textEdits(oldText, newText) {
  const one = minimalEdit(oldText, newText);
  if (one.start === one.end && !one.text) return [];
  const lineStart = (t, i) => t.lastIndexOf('\n', i - 1) + 1;
  const a0 = lineStart(oldText, one.start);
  const aEndNl = oldText.indexOf('\n', one.end - 1 < a0 ? a0 : one.end - 1);
  const a1 = aEndNl < 0 ? oldText.length : aEndNl + 1;
  const b1 = newText.length - (oldText.length - a1);
  const A = oldText.slice(a0, a1).split(/(?<=\n)/), B = newText.slice(a0, b1).split(/(?<=\n)/);
  const n = A.length, m = B.length;
  if (n * m > 4e6 || n < 2 || m < 2) return [one];
  // LCS table from the end
  const L = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * (m + 1) + j] = A[i] === B[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
  const out = [];
  let i = 0, j = 0, pa = a0, hunk = null;
  const flush = () => { if (hunk) { const e = minimalEdit(oldText.slice(hunk.s, hunk.e), hunk.text); out.push({ start: hunk.s + e.start, end: hunk.s + e.end, text: e.text }); hunk = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { flush(); pa += A[i].length; i++; j++; continue; }
    if (!hunk) hunk = { s: pa, e: pa, text: '' };
    if (j < m && (i >= n || L[i * (m + 1) + j + 1] >= L[(i + 1) * (m + 1) + j])) { hunk.text += B[j]; j++; } else { pa += A[i].length; hunk.e = pa; i++; }
  }
  flush();
  return out.filter((e) => e.start !== e.end || e.text);
}

module.exports = { textEdits, minimalEdit, formatOf, load, save, toModel, applyOp, nodeAt, MapError, ADAPTERS, PROGRESS_PERCENT, percentToProgress, adjustAfterRemoval };
