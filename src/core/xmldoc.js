'use strict';
// A small lossless XML tree for FreeMind .mm and OPML files. parse() keeps every byte: the XML declaration, comments,
// DOCTYPE, CDATA, whitespace between tags, attribute order, quoting and spacing. serialize(parse(x)) === x for any
// well-formed file. An element that was not changed is written from its original text; a changed element rebuilds only
// its own start tag, keeping the original text of every attribute that did not change. No DTD, no external entities,
// no network. Every walk is iterative, so a very deep file cannot overflow the stack.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
      try { return String.fromCodePoint(cp); } catch (err) { return m; }
    }
    return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : m;
  });
}
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class XmlError extends Error {
  constructor(msg, line) { super(line ? `${msg} (line ${line})` : msg); this.line = line || 0; }
}

function lineAt(text, i) {
  let n = 1;
  for (let k = text.indexOf('\n'); k >= 0 && k < i; k = text.indexOf('\n', k + 1)) n++;
  return n;
}

const ATTR_RE = /(\s+)([^\s=/>"']+)(\s*=\s*)("([^"]*)"|'([^']*)')/y;

function el(name, attrs) {
  return { t: 'el', name, attrs: (attrs || []).map(([n, v]) => ({ name: n, value: String(v), ws: ' ', raw: null })), tail: '', selfClose: true, kids: [], open: null, close: null, dirty: true };
}
function text(raw) { return { t: 'text', raw }; }

/** Parses text into { kids: [...] } (the document node). Throws XmlError with a line number on broken XML. */
function parse(src) {
  const doc = { t: 'doc', kids: [] };
  const stack = [doc];
  const n = src.length;
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { top().kids.push(text(src.slice(i))); break; }
    if (lt > i) top().kids.push(text(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      if (e < 0) throw new XmlError('A comment is not closed', lineAt(src, lt));
      top().kids.push({ t: 'raw', raw: src.slice(lt, e + 3) }); i = e + 3; continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      if (e < 0) throw new XmlError('A CDATA section is not closed', lineAt(src, lt));
      top().kids.push({ t: 'cdata', raw: src.slice(lt, e + 3) }); i = e + 3; continue;
    }
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt + 2);
      if (e < 0) throw new XmlError('A processing instruction is not closed', lineAt(src, lt));
      top().kids.push({ t: 'raw', raw: src.slice(lt, e + 2) }); i = e + 2; continue;
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE (with an internal subset in brackets): kept as text, never read
      let depth = 0, k = lt + 2;
      for (; k < n; k++) { const c = src[k]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break; }
      if (k >= n) throw new XmlError('A declaration is not closed', lineAt(src, lt));
      top().kids.push({ t: 'raw', raw: src.slice(lt, k + 1) }); i = k + 1; continue;
    }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      if (e < 0) throw new XmlError('An end tag is not closed', lineAt(src, lt));
      const name = src.slice(lt + 2, e).trim();
      const cur = top();
      if (cur.t !== 'el' || cur.name !== name) throw new XmlError(cur.t === 'el' ? `</${name}> does not match <${cur.name}>` : `</${name}> has no start tag`, lineAt(src, lt));
      cur.close = src.slice(lt, e + 1);
      stack.pop();
      i = e + 1; continue;
    }
    const m = /^<([A-Za-z_:\u00C0-\uFFFF][^\s/>!?<"'=]*)/.exec(src.slice(lt, lt + 300));
    if (!m) throw new XmlError('A "<" that does not start a tag', lineAt(src, lt));
    const node = { t: 'el', name: m[1], attrs: [], tail: '', selfClose: false, kids: [], open: '', close: null, dirty: false };
    let k = lt + m[0].length;
    for (;;) {
      ATTR_RE.lastIndex = k;
      const a = ATTR_RE.exec(src);
      if (!a) break;
      const value = decode(a[5] !== undefined ? a[5] : a[6]);
      node.attrs.push({ name: a[2], value, ws: a[1], raw: a[2] + a[3] + a[4] });
      k = ATTR_RE.lastIndex;
    }
    const tm = /^\s*(\/?)>/.exec(src.slice(k, k + 200));
    if (!tm) throw new XmlError(`The tag <${node.name}> is not closed or has a broken attribute`, lineAt(src, lt));
    node.tail = tm[0];
    node.selfClose = tm[1] === '/';
    i = k + tm[0].length;
    node.open = src.slice(lt, i);
    top().kids.push(node);
    if (!node.selfClose) stack.push(node);
  }
  if (stack.length > 1) throw new XmlError(`<${top().name}> is not closed at the end of the file`, lineAt(src, n));
  if (!doc.kids.some((k) => k.t === 'el')) throw new XmlError('The file has no XML element', 1);
  return doc;
}

function openTag(node) {
  if (!node.dirty && node.open !== null) return node.open;
  const tail = node.selfClose ? (node.tail && /\/>$/.test(node.tail) ? node.tail : '/>') : (node.tail && !/\/>$/.test(node.tail) ? node.tail : '>');
  return '<' + node.name + node.attrs.map((a) => a.ws + (a.raw !== null ? a.raw : `${a.name}="${escAttr(a.value)}"`)).join('') + tail;
}

/** Writes the tree back to text. */
function serialize(doc) {
  const out = [];
  // iterative: stack of [node, phase]
  const st = [];
  for (let k = doc.kids.length - 1; k >= 0; k--) st.push([doc.kids[k], 0]);
  while (st.length) {
    const [node, phase] = st.pop();
    if (node.t !== 'el') { out.push(node.raw); continue; }
    if (phase === 1) { out.push(node.close || `</${node.name}>`); continue; }
    out.push(openTag(node));
    if (node.selfClose) continue;
    st.push([node, 1]);
    for (let k = node.kids.length - 1; k >= 0; k--) st.push([node.kids[k], 0]);
  }
  return out.join('');
}

// ---------- reading ----------
const attr = (node, name) => { const a = node.attrs.find((x) => x.name === name); return a ? a.value : undefined; };
const attrCI = (node, name) => { const l = name.toLowerCase(); const a = node.attrs.find((x) => x.name.toLowerCase() === l); return a ? a.value : undefined; };
const elems = (node, name) => node.kids.filter((k) => k.t === 'el' && (name === undefined || k.name === name));
const firstEl = (node, name) => node.kids.find((k) => k.t === 'el' && (name === undefined || k.name === name)) || null;
const rootEl = (doc) => doc.kids.find((k) => k.t === 'el') || null;

/** All text inside a node (iterative), entities decoded. */
function textContent(node) {
  const out = [];
  const st = [node];
  while (st.length) {
    const x = st.pop();
    if (x.t === 'text') out.push(decode(x.raw));
    else if (x.t === 'cdata') out.push(x.raw.slice(9, -3));
    else if (x.t === 'el' || x.t === 'doc') for (let k = x.kids.length - 1; k >= 0; k--) st.push(x.kids[k]);
  }
  return out.join('');
}

/** Text of an HTML fragment kept as XML (FreeMind rich content): one line per paragraph, list item or <br>. */
function htmlText(node) {
  const out = [];
  const BLOCK = /^(p|div|li|h[1-6]|br|tr|pre|blockquote)$/i;
  const st = [node];
  while (st.length) {
    const x = st.pop();
    if (x === '\n') { out.push('\n'); continue; }
    if (x.t === 'text') out.push(decode(x.raw).replace(/\s+/g, ' '));
    else if (x.t === 'cdata') out.push(x.raw.slice(9, -3));
    else if (x.t === 'el' || x.t === 'doc') {
      if (x.t === 'el' && /^(head|style|script)$/i.test(x.name)) continue;
      if (x.t === 'el' && BLOCK.test(x.name)) st.push('\n');
      for (let k = x.kids.length - 1; k >= 0; k--) st.push(x.kids[k]);
      if (x.t === 'el' && /^li$/i.test(x.name)) out.push('\n- ');
    }
  }
  return out.join('').split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- editing ----------
function setAttr(node, name, value) {
  const a = node.attrs.find((x) => x.name === name);
  if (value === undefined || value === null) {
    if (a) { node.attrs.splice(node.attrs.indexOf(a), 1); node.dirty = true; }
    return;
  }
  const v = String(value);
  if (a) { if (a.value === v) return; a.value = v; a.raw = null; } else node.attrs.push({ name, value: v, ws: ' ', raw: null });
  node.dirty = true;
}

const isWs = (k) => k && k.t === 'text' && /^\s*$/.test(k.raw);

/** Indentation text of a node: the whitespace before it in its parent, from the last line break on. */
function indentBefore(parent, node) {
  const i = parent.kids.indexOf(node);
  const prev = i > 0 ? parent.kids[i - 1] : null;
  if (!isWs(prev)) return null;
  const s = prev.raw;
  const nl = s.lastIndexOf('\n');
  return nl < 0 ? null : s.slice(nl);
}

/** The indent step of the document: the difference between a child's and its parent's indentation, '' when the file
 *  has no indentation (FreeMind 0.9 writes every tag at the start of a line). */
function indentUnit(doc) {
  const st = [[doc, null]];
  while (st.length) {
    const [p, pInd] = st.pop();
    for (const k of p.kids) {
      if (k.t !== 'el') continue;
      const ind = p.t === 'doc' ? '\n' : indentBefore(p, k);
      if (ind !== null && pInd !== null && ind.length > pInd.length && ind.startsWith(pInd)) return ind.slice(pInd.length);
      if (ind !== null && pInd !== null && ind === pInd) return '';
      st.push([k, ind]);
    }
  }
  return '    ';
}

/** Inserts element `node` into parent before `ref` (an element of parent.kids) or at the end, with whitespace that
 *  matches its neighbours. */
function insertEl(doc, parent, node, ref) {
  if (ref) {
    const i = parent.kids.indexOf(ref);
    const ws = i > 0 && isWs(parent.kids[i - 1]) ? parent.kids[i - 1].raw : null;
    const add = ws !== null ? [node, text(ws)] : [node];
    parent.kids.splice(i, 0, ...add);
    return;
  }
  const lastEl = [...parent.kids].reverse().find((k) => k.t === 'el');
  if (lastEl) {
    const i = parent.kids.indexOf(lastEl);
    const ws = i > 0 && isWs(parent.kids[i - 1]) ? parent.kids[i - 1].raw : null;
    parent.kids.splice(i + 1, 0, ...(ws !== null ? [text(ws), node] : [node]));
    return;
  }
  // no element child yet
  const grand = findParent(doc, parent);
  const pInd = grand ? (indentBefore(grand, parent) || '\n') : '\n';
  const childInd = pInd + indentUnit(doc);
  if (parent.selfClose) {
    parent.selfClose = false;
    parent.dirty = true;
    parent.tail = '>';
    parent.close = `</${parent.name}>`;
    parent.kids = [text(childInd), node, text(pInd)];
    return;
  }
  const last = parent.kids[parent.kids.length - 1];
  if (isWs(last)) parent.kids.splice(parent.kids.length - 1, 0, text(childInd), node);
  else parent.kids.push(text(childInd), node, text(pInd));
}

/** Removes element `node` from parent with the whitespace before it. */
function removeEl(parent, node) {
  const i = parent.kids.indexOf(node);
  if (i < 0) return;
  if (i > 0 && isWs(parent.kids[i - 1])) parent.kids.splice(i - 1, 2);
  else parent.kids.splice(i, 1);
}

/** Parent of a node (iterative search from the document). */
function findParent(doc, node) {
  const st = [doc];
  while (st.length) {
    const p = st.pop();
    for (const k of p.kids) {
      if (k === node) return p;
      if (k.t === 'el' && k.kids.length) st.push(k);
    }
  }
  return null;
}

/** Replaces all children of an element with fresh content (an array of nodes). */
function setKids(node, kids) {
  node.kids = kids;
  if (node.selfClose && kids.length) { node.selfClose = false; node.tail = '>'; node.close = `</${node.name}>`; node.dirty = true; }
}

/** An element built from a small XML string (our own markup only). */
function fragment(xml) {
  const d = parse(`<x>${xml}</x>`);
  return rootEl(d).kids;
}

module.exports = {
  parse, serialize, XmlError, decode, escAttr, escText, el, text, attr, attrCI, elems, firstEl, rootEl, textContent, htmlText,
  setAttr, insertEl, removeEl, findParent, indentUnit, setKids, fragment,
};
