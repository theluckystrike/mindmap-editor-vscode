// Mindmap Editor webview: draws the topic tree as SVG with the layouts of media/layout.js, and turns keys, clicks and
// drags into edit messages. It never changes the file itself: the extension applies each edit to the text document,
// so undo, redo, the dirty dot and save are VS Code's own. Loads nothing from the network.
(function () {
  'use strict';
  var L = module.exports; // media/layout.js
  var vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;
  var $ = function (id) { return document.getElementById(id); };
  var post = function (m) { if (vscode) vscode.postMessage(m); };

  var saved = (vscode && vscode.getState()) || {};
  var S = {
    model: null, fmt: '', readOnly: false, gen: 0, layout: saved.layout || '', sel: null, folded: new Set(saved.folded || []),
    view: { z: 1, tx: 0, ty: 0, fitted: false }, last: null, editing: null, drag: null, pan: null, error: '', pendingEdit: false,
  };

  // ---------- measuring ----------
  var LEVELS = [
    { size: 18, weight: 600, padX: 16, padY: 10, maxW: 300, rx: 10 },
    { size: 14.5, weight: 500, padX: 11, padY: 7, maxW: 260, rx: 7 },
    { size: 13, weight: 400, padX: 8, padY: 5, maxW: 260, rx: 5 },
  ];
  var ICON = 16, GAP = 4;
  var mctx = document.createElement('canvas').getContext('2d');
  var fontFamily = '';
  var FONT_TAIL = ', "PingFang SC", "Hiragino Sans", "Microsoft YaHei", "Noto Sans CJK SC", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  function cssVar(name, fb) { var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fb; }
  function setFont() { fontFamily = (cssVar('--vscode-font-family', 'system-ui') || 'system-ui') + FONT_TAIL; }

  function wrap(text, maxW) {
    var lines = [];
    var paras = String(text).split('\n');
    for (var p = 0; p < paras.length && lines.length < 40; p++) {
      var toks = paras[p].match(/[⺀-鿿가-힯＀-￯]|[^\s⺀-鿿가-힯＀-￯]+|\s+/g) || [''];
      var cur = '', curW = 0;
      for (var i = 0; i < toks.length; i++) {
        var tk = toks[i], w = mctx.measureText(tk).width;
        if (curW + w <= maxW || !cur.trim()) {
          if (w > maxW && !/\s/.test(tk)) {
            var chars = Array.from(tk);
            for (var c = 0; c < chars.length; c++) { var cw = mctx.measureText(chars[c]).width; if (curW + cw > maxW && cur) { lines.push(cur); cur = ''; curW = 0; } cur += chars[c]; curW += cw; }
          } else { cur += tk; curW += w; }
        } else { lines.push(cur.replace(/\s+$/, '')); cur = /^\s+$/.test(tk) ? '' : tk; curW = /^\s+$/.test(tk) ? 0 : w; }
      }
      lines.push(cur.replace(/\s+$/, ''));
    }
    if (lines.length > 40) { lines = lines.slice(0, 40); lines.push('…'); }
    return lines;
  }

  function measure(t, depth) {
    var Lv = LEVELS[Math.min(depth, 2)];
    mctx.font = Lv.weight + ' ' + Lv.size + 'px ' + fontFamily;
    var lines = wrap(t.title === '' ? ' ' : t.title, Lv.maxW);
    var textW = 0;
    for (var i = 0; i < lines.length; i++) textW = Math.max(textW, mctx.measureText(lines[i]).width);
    var lh = Math.round(Lv.size * 1.35);
    var icons = [];
    if (t.priority) icons.push('priority');
    if (t.progress) icons.push('progress');
    var tail = [];
    if (t.note) tail.push('note');
    if (t.link) tail.push('link');
    var iconsW = icons.length * (ICON + GAP), tailW = tail.length * (ICON + GAP);
    var w = Math.ceil(iconsW + textW + tailW + Lv.padX * 2);
    var h = Math.ceil(Math.max(lines.length * lh, icons.length || tail.length ? ICON : 0) + Lv.padY * 2);
    return { w: Math.max(w, depth === 0 ? 60 : 30), h: h, Lv: Lv, lines: lines, lh: lh, icons: icons, tail: tail, iconsW: iconsW, textW: textW };
  }

  // ---------- visible tree and layout ----------
  var key = function (path) { return ['r'].concat(path).join('.'); }; // root 'r', its first child 'r.0'
  function isFolded(t) {
    if (!t.kids.length) return false;
    if (S.fmt === 'opml') return S.folded.has(key(t.path));
    return !!t.folded;
  }
  function countAll(t) { var n = 0, st = t.kids.slice(); while (st.length) { var x = st.pop(); n++; for (var i = 0; i < x.kids.length; i++) st.push(x.kids[i]); } return n; }

  function computeLayout() {
    var nodes = [];
    var mk = function (t, depth, parent) {
      var m = measure(t, depth);
      var n = { t: t, w: m.w, h: m.h, m: m, kids: [], parent: parent, depth: depth, x: 0, y: 0, i: nodes.length, key: key(t.path) };
      nodes.push(n);
      return n;
    };
    var root = mk(S.model.root, 0, null);
    var st = [root];
    while (st.length) {
      var n = st.pop();
      if (isFolded(n.t)) { n.collapsed = countAll(n.t); continue; }
      for (var i = 0; i < n.t.kids.length; i++) { var k = mk(n.t.kids[i], n.depth + 1, n); n.kids.push(k); st.push(k); }
    }
    L.layout(root, layoutMode());
    var byKey = new Map();
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var j = 0; j < nodes.length; j++) {
      var q = nodes[j];
      byKey.set(q.key, q);
      var ex = q.collapsed ? 26 : 0;
      x0 = Math.min(x0, q.x - ex); y0 = Math.min(y0, q.y - (q.collapsed && (q.dir === 3) ? 26 : 0));
      x1 = Math.max(x1, q.x + q.w + ex); y1 = Math.max(y1, q.y + q.h + (q.collapsed && q.dir === 2 ? 26 : 0));
    }
    var PAD = 40;
    return { root: root, nodes: nodes, byKey: byKey, box: { x0: x0 - PAD, y0: y0 - PAD, x1: x1 + PAD, y1: y1 + PAD } };
  }
  function layoutMode() { return S.layout || (S.model && S.model.layout) || 'map'; }

  // ---------- drawing ----------
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  var r1 = function (v) { return Math.round(v * 10) / 10; };
  var PRIO = ['', '#e5484d', '#f76b15', '#e2a336', '#46a758', '#3e8ed0', '#8e4ec6', '#d6409f', '#12a594', '#7c7c7c'];

  /** Colors: the VS Code theme as CSS variables on screen; resolved values for an export. */
  function palette(resolve) {
    void resolve;
    var v = function (name, fb) { return cssVar(name, fb); };
    return {
      bg: v('--vscode-editor-background', '#1e1e1e'),
      fg: v('--vscode-editor-foreground', '#cccccc'),
      rootFill: v('--vscode-button-background', '#0e639c'),
      rootText: v('--vscode-button-foreground', '#ffffff'),
      l1Fill: v('--vscode-editorWidget-background', '#252526'),
      l1Stroke: v('--vscode-editorWidget-border', '#454545'),
      l2Fill: v('--vscode-editor-background', '#1e1e1e'),
      l2Stroke: v('--vscode-panel-border', '#3c3c3c'),
      edge: v('--vscode-descriptionForeground', '#8b8b8b'),
      sel: v('--vscode-focusBorder', '#007fd4'),
      link: v('--vscode-textLink-foreground', '#3794ff'),
    };
  }

  function edgePath(p, k) {
    var d = k.dir;
    if (d === 2 || d === 3) { // org chart: bottom (top) center to top (bottom) center
      var sx = p.x + p.w / 2, sy = d === 2 ? p.y + p.h : p.y, ex = k.x + k.w / 2, ey = d === 2 ? k.y : k.y + k.h;
      var my = (sy + ey) / 2;
      return 'M' + r1(sx) + ' ' + r1(sy) + ' C' + r1(sx) + ' ' + r1(my) + ' ' + r1(ex) + ' ' + r1(my) + ' ' + r1(ex) + ' ' + r1(ey);
    }
    if (d === 4) { // tree: elbow from the parent's left part down and right
      var tx = p.x + 12, ty = p.y + p.h, cy = k.y + k.h / 2;
      return 'M' + r1(tx) + ' ' + r1(ty) + ' L' + r1(tx) + ' ' + r1(cy) + ' L' + r1(k.x) + ' ' + r1(cy);
    }
    var right = d >= 0;
    var x1 = right ? p.x + p.w : p.x, y1 = p.y + p.h / 2;
    var x2 = right ? k.x : k.x + k.w, y2 = k.y + k.h / 2;
    var mx = (x1 + x2) / 2;
    return 'M' + r1(x1) + ' ' + r1(y1) + ' C' + r1(mx) + ' ' + r1(y1) + ' ' + r1(mx) + ' ' + r1(y2) + ' ' + r1(x2) + ' ' + r1(y2);
  }

  // Colors are SVG presentation attributes (allowed by the page's CSP; inline style attributes are not). On screen,
  // media/map.css overrides them with the VS Code theme variables, so the map follows a theme change at once; an
  // exported picture keeps the resolved colors in its attributes.
  function iconSvg(kind, t, x, y, C) {
    var cx = x + ICON / 2, cy = y + ICON / 2;
    if (kind === 'priority') {
      return '<g class="ic pr" data-ic="priority"><circle cx="' + r1(cx) + '" cy="' + r1(cy) + '" r="7.5" fill="' + PRIO[t.priority] + '"/><text class="pn" x="' + r1(cx) + '" y="' + r1(cy + 3.6) + '" text-anchor="middle" fill="#ffffff" font-size="10" font-weight="700">' + t.priority + '</text></g>';
    }
    if (kind === 'progress') {
      var f = Math.max(0, Math.min(1, (t.progress - 1) / 8));
      var out = '<g class="ic pg" data-ic="progress"><circle cx="' + r1(cx) + '" cy="' + r1(cy) + '" r="7" fill="none" stroke="#46a758" stroke-width="1.6"/>';
      if (f >= 1) out += '<circle cx="' + r1(cx) + '" cy="' + r1(cy) + '" r="5.2" fill="#46a758"/><path d="M' + r1(cx - 3) + ' ' + r1(cy) + ' l2.2 2.4 l3.8 -4.6" fill="none" stroke="#ffffff" stroke-width="1.6"/>';
      else if (f > 0) {
        var a = f * 2 * Math.PI - Math.PI / 2, rr = 5.2;
        out += '<path d="M' + r1(cx) + ' ' + r1(cy) + ' L' + r1(cx) + ' ' + r1(cy - rr) + ' A' + rr + ' ' + rr + ' 0 ' + (f > 0.5 ? 1 : 0) + ' 1 ' + r1(cx + rr * Math.cos(a)) + ' ' + r1(cy + rr * Math.sin(a)) + ' Z" fill="#46a758"/>';
      }
      return out + '</g>';
    }
    if (kind === 'note') {
      return '<g class="ic nt" data-ic="note"><title>' + esc(t.note.slice(0, 400)) + '</title><rect class="ln" x="' + r1(x + 2) + '" y="' + r1(y + 1) + '" width="12" height="14" rx="2" fill="none" stroke="' + C.edge + '" stroke-width="1.3"/><path class="ln" d="M' + r1(x + 5) + ' ' + r1(y + 5.5) + ' h6 M' + r1(x + 5) + ' ' + r1(y + 8.5) + ' h6 M' + r1(x + 5) + ' ' + r1(y + 11.5) + ' h4" stroke="' + C.edge + '" stroke-width="1.2"/></g>';
    }
    return '<g class="ic lk" data-ic="link"><title>' + esc(t.link) + '</title><rect x="' + r1(x) + '" y="' + r1(y) + '" width="16" height="16" fill="transparent"/><path class="lp" d="M' + r1(x + 6) + ' ' + r1(y + 3) + ' h7 v7 M' + r1(x + 13) + ' ' + r1(y + 3) + ' l-8 8 M' + r1(x + 9) + ' ' + r1(y + 13) + ' h-6 v-6" fill="none" stroke="' + C.link + '" stroke-width="1.5"/></g>';
  }

  function nodeSvg(n, C, opts) {
    var t = n.t, m = n.m, Lv = m.Lv, depth = n.depth;
    var fill = depth === 0 ? C.rootFill : depth === 1 ? C.l1Fill : C.l2Fill;
    var stroke = depth === 0 ? C.rootFill : depth === 1 ? C.l1Stroke : C.l2Stroke;
    var color = depth === 0 ? C.rootText : C.fg;
    var sel = !opts.forExport && n.key === S.sel;
    var out = ['<g class="tp l' + Math.min(depth, 2) + (sel ? ' sel' : '') + '" data-k="' + n.key + '" transform="translate(' + r1(n.x) + ',' + r1(n.y) + ')">'];
    out.push('<rect class="box" width="' + n.w + '" height="' + n.h + '" rx="' + Lv.rx + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.2"/>');
    var x = Lv.padX;
    var bodyH = n.h - Lv.padY * 2;
    for (var i = 0; i < m.icons.length; i++) { out.push(iconSvg(m.icons[i], t, x, Lv.padY + (bodyH - ICON) / 2, C)); x += ICON + GAP; }
    var textH = m.lines.length * m.lh;
    var ty = Lv.padY + (bodyH - textH) / 2;
    out.push('<text class="t" fill="' + color + '" font-size="' + Lv.size + '" font-weight="' + Lv.weight + '">');
    for (var j = 0; j < m.lines.length; j++) out.push('<tspan x="' + r1(x) + '" y="' + r1(ty + j * m.lh + Lv.size * 0.98) + '">' + esc(m.lines[j]) + '</tspan>');
    out.push('</text>');
    x += m.textW + GAP;
    for (var k = 0; k < m.tail.length; k++) { out.push(iconSvg(m.tail[k], t, x, Lv.padY + (bodyH - ICON) / 2, C)); x += ICON + GAP; }
    if (n.collapsed) {
      var d = n.dir, cx, cy;
      if (d === 2) { cx = n.w / 2; cy = n.h + 12; } else if (d === 3) { cx = n.w / 2; cy = -12; } else if (d === 4) { cx = 12; cy = n.h + 12; } else if (d < 0) { cx = -14; cy = n.h / 2; } else { cx = n.w + 14; cy = n.h / 2; }
      var label = n.collapsed > 99 ? '99+' : String(n.collapsed);
      out.push('<g class="fold" data-fold="1"><circle cx="' + r1(cx) + '" cy="' + r1(cy) + '" r="10" fill="' + C.bg + '" stroke="' + C.edge + '" stroke-width="1.2"/><text x="' + r1(cx) + '" y="' + r1(cy + 3.5) + '" text-anchor="middle" fill="' + C.fg + '" font-size="9.5">' + label + '</text></g>');
    }
    out.push('</g>');
    return out.join('');
  }

  /** The whole map (or the branch at rootKey) as SVG text. opts: { forExport, background: 'theme'|'transparent'|'white' } */
  function drawSvg(Lay, opts) {
    var C = palette(true);
    if (opts.forExport && opts.background === 'white') { C = { bg: '#ffffff', fg: '#1f1f1f', rootFill: '#2b6cb0', rootText: '#ffffff', l1Fill: '#f3f6fa', l1Stroke: '#9fb3c8', l2Fill: '#ffffff', l2Stroke: '#c9d3dd', edge: '#7b8794', sel: '#2b6cb0', link: '#1a64c8' }; }
    var nodes = Lay.nodes, box = Lay.box;
    if (opts.branch) {
      var top = Lay.byKey.get(opts.branch);
      var keep = new Set();
      var st = [top];
      while (st.length) { var q = st.pop(); keep.add(q); for (var a = 0; a < q.kids.length; a++) st.push(q.kids[a]); }
      nodes = nodes.filter(function (z) { return keep.has(z); });
      var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      nodes.forEach(function (z) { var e = z.collapsed ? 26 : 0; bx0 = Math.min(bx0, z.x - e); by0 = Math.min(by0, z.y - e); bx1 = Math.max(bx1, z.x + z.w + e); by1 = Math.max(by1, z.y + z.h + e); });
      box = { x0: bx0 - 30, y0: by0 - 30, x1: bx1 + 30, y1: by1 + 30 };
    }
    var W = Math.ceil(box.x1 - box.x0), H = Math.ceil(box.y1 - box.y0);
    var out = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="' + r1(box.x0) + ' ' + r1(box.y0) + ' ' + W + ' ' + H + '" font-family="' + esc(fontFamily) + '">'];
    if (opts.forExport && opts.background !== 'transparent') out.push('<rect x="' + r1(box.x0) + '" y="' + r1(box.y0) + '" width="' + W + '" height="' + H + '" fill="' + C.bg + '"/>');
    out.push('<g class="edges" fill="none" stroke="' + C.edge + '" stroke-width="1.6">');
    var inSet = new Set(nodes);
    for (var i = 0; i < nodes.length; i++) {
      var p = nodes[i];
      for (var k = 0; k < p.kids.length; k++) if (inSet.has(p.kids[k])) out.push('<path d="' + edgePath(p, p.kids[k]) + '"/>');
    }
    out.push('</g><g class="topics">');
    for (var j = 0; j < nodes.length; j++) out.push(nodeSvg(nodes[j], C, opts));
    out.push('</g></svg>');
    return { svg: out.join(''), W: W, H: H, count: nodes.length };
  }

  // ---------- screen ----------
  var host = $('host'), stage = $('stage');
  function render(keepView) {
    if (!S.model) return;
    setFont();
    S.last = computeLayout();
    var d = drawSvg(S.last, {});
    host.innerHTML = d.svg;
    host.style.width = d.W + 'px';
    host.style.height = d.H + 'px';
    $('empty').classList.add('hidden');
    if (!S.view.fitted || !keepView) fit(); else applyView();
    if (S.sel !== null && !S.last.byKey.has(S.sel)) S.sel = null;
    showDetails();
    statusLine();
    post({ type: 'rendered', gen: S.gen, nodes: S.last.nodes.length, count: S.model.count });
  }
  function statusLine() {
    if (!S.model) return;
    $('status').textContent = S.model.count + ' topics · ' + ({ km: 'KityMinder .km', mm: 'FreeMind .mm', opml: 'OPML' })[S.fmt] + (S.readOnly ? ' · read-only' : '') + ' · ' + layoutLabel();
  }
  function layoutLabel() { var o = $('layout').querySelector('option[value="' + layoutMode() + '"]'); return o ? o.textContent : layoutMode(); }
  function applyView() {
    var v = S.view, b = S.last.box;
    host.style.transform = 'translate(' + v.tx + 'px,' + v.ty + 'px) scale(' + v.z + ')';
    host.style.transformOrigin = '0 0';
    host.dataset.x0 = b.x0; host.dataset.y0 = b.y0;
    if (S.editing) placeEditor();
  }
  function fit() {
    var b = S.last.box, r = stage.getBoundingClientRect();
    var W = b.x1 - b.x0, H = b.y1 - b.y0;
    var z = Math.min(1, (r.width - 20) / W, (r.height - 20) / H);
    if (!isFinite(z) || z <= 0) z = 1;
    z = Math.max(0.1, z);
    S.view.z = z; S.view.tx = (r.width - W * z) / 2; S.view.ty = Math.max(10, (r.height - H * z) / 2); S.view.fitted = true; S.view.auto = true;
    applyView();
  }
  /** Screen rectangle (stage coordinates) of a node. */
  function nodeRect(n) {
    var v = S.view, b = S.last.box;
    return { x: v.tx + (n.x - b.x0) * v.z, y: v.ty + (n.y - b.y0) * v.z, w: n.w * v.z, h: n.h * v.z };
  }
  function ensureVisible(n) {
    var r = nodeRect(n), s = stage.getBoundingClientRect(), dx = 0, dy = 0;
    if (r.x < 10) dx = 10 - r.x; else if (r.x + r.w > s.width - 10) dx = s.width - 10 - r.x - r.w;
    if (r.y < 10) dy = 10 - r.y; else if (r.y + r.h > s.height - 10) dy = s.height - 10 - r.y - r.h;
    if (dx || dy) { S.view.tx += dx; S.view.ty += dy; S.view.auto = false; applyView(); }
  }

  function select(k, reveal) {
    S.sel = k;
    var old = host.querySelector('g.tp.sel');
    if (old) old.classList.remove('sel');
    var g = host.querySelector('g.tp[data-k="' + k + '"]');
    if (g) g.classList.add('sel');
    var n = S.last && S.last.byKey.get(k);
    if (n && reveal) ensureVisible(n);
    showDetails();
    if (vscode) vscode.setState({ layout: S.layout, folded: Array.from(S.folded), sel: S.sel });
    post({ type: 'selection', path: n ? n.t.path : null, title: n ? n.t.title : '' });
  }

  function current() { return S.last && S.sel !== null ? (S.last.byKey.get(S.sel) || null) : null; }

  function showDetails() {
    var n = current();
    var dis = !n || S.readOnly || n.t.virtual;
    ['dPriority', 'dProgress', 'dLink', 'dNote'].forEach(function (id) { $(id).disabled = dis; });
    $('dTitle').textContent = n ? (n.t.title || '(no title)') : 'No topic selected';
    if (!n) { $('dPriority').value = '0'; $('dProgress').value = '0'; $('dLink').value = ''; $('dNote').value = ''; return; }
    $('dPriority').value = String(n.t.priority || 0);
    var pg = n.t.progress || 0;
    var opt = $('dProgress').querySelector('option[value="' + pg + '"]');
    if (!opt) { opt = document.createElement('option'); opt.value = String(pg); opt.textContent = Math.round((pg - 1) / 8 * 100) + ' %'; $('dProgress').appendChild(opt); }
    $('dProgress').value = String(pg);
    if (document.activeElement !== $('dLink')) $('dLink').value = n.t.link || '';
    if (document.activeElement !== $('dNote')) $('dNote').value = n.t.note || '';
  }

  // ---------- edits ----------
  function op(o) {
    if (S.readOnly) { flash('This file is read-only here.'); return; }
    if (!S.model) return;
    o.type = 'op';
    o.gen = S.gen;
    post(o);
  }
  var flashTimer = null;
  function flash(msg) {
    $('status').textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(statusLine, 4000);
  }
  function addChild() { var n = current(); if (!n) n = S.last && S.last.root; if (!n) return; op({ op: 'addChild', path: n.t.path }); }
  function addSibling() { var n = current(); if (!n) return; op({ op: n.depth === 0 ? 'addChild' : 'addSibling', path: n.t.path }); }
  function del() { var n = current(); if (!n) return; if (n.depth === 0) { flash('The root topic cannot be deleted.'); return; } op({ op: 'delete', path: n.t.path }); }
  function toggleFold(n) {
    if (!n || !n.t.kids.length) return;
    if (S.fmt === 'opml') {
      if (S.folded.has(n.key)) S.folded.delete(n.key); else S.folded.add(n.key);
      if (vscode) vscode.setState({ layout: S.layout, folded: Array.from(S.folded), sel: S.sel });
      render(true);
      return;
    }
    op({ op: 'fold', path: n.t.path, folded: !n.t.folded });
  }
  function foldAll(f) {
    if (S.fmt === 'opml') {
      S.folded.clear();
      if (f) { var st = S.model.root.kids.slice(); while (st.length) { var t = st.pop(); if (t.kids.length) S.folded.add(key(t.path)); for (var i = 0; i < t.kids.length; i++) st.push(t.kids[i]); } }
      render(true);
      return;
    }
    op({ op: 'foldAll', path: [], folded: f });
  }

  // inline rename
  var editbox = $('editbox');
  function startEdit(n) {
    if (!n || S.readOnly || n.t.virtual) { if (n && n.t.virtual) flash('This outline has several top items: its top line is the file title, not a topic.'); return; }
    S.editing = n.key;
    editbox.value = n.t.title;
    editbox.classList.remove('hidden');
    var Lv = n.m.Lv;
    editbox.style.fontSize = (Lv.size * S.view.z) + 'px';
    editbox.style.fontWeight = Lv.weight;
    placeEditor();
    editbox.focus();
    editbox.select();
  }
  function placeEditor() {
    var n = S.last && S.last.byKey.get(S.editing);
    if (!n) return;
    var r = nodeRect(n);
    editbox.style.left = r.x + 'px'; editbox.style.top = r.y + 'px';
    editbox.style.width = Math.max(r.w, 140) + 'px'; editbox.style.height = Math.max(r.h, 28) + 'px';
  }
  function endEdit(commit) {
    if (S.editing === null) return;
    var k = S.editing;
    S.editing = null;
    var v = editbox.value;
    editbox.classList.add('hidden');
    stage.focus();
    var n = S.last && S.last.byKey.get(k);
    if (commit && n && v !== n.t.title) op({ op: 'rename', path: n.t.path, text: v });
  }
  editbox.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); endEdit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); endEdit(false); }
    else if (e.key === 'Tab') { e.preventDefault(); endEdit(true); }
    e.stopPropagation();
  });
  editbox.addEventListener('blur', function () { if (S.editing !== null) endEdit(true); });

  // ---------- keys ----------
  function siblingsOf(n) { return n.parent ? n.parent.kids : [n]; }
  function move(dirKey) {
    var n = current();
    if (!n) { if (S.last) select(S.last.root.key, true); return; }
    var mode = layoutMode();
    var vertical = mode === 'org' || mode === 'tree';
    var parentKey = vertical ? 'ArrowUp' : (n.dir < 0 ? 'ArrowRight' : 'ArrowLeft');
    var childKey = vertical ? (mode === 'tree' ? 'ArrowRight' : 'ArrowDown') : (n.dir < 0 ? 'ArrowLeft' : 'ArrowRight');
    if (n.depth === 0 && !vertical) {
      var side = n.kids.filter(function (k) { return dirKey === 'ArrowLeft' ? k.dir < 0 : k.dir > 0; });
      if (side.length) select(side[Math.floor((side.length - 1) / 2)].key, true);
      return;
    }
    if (dirKey === parentKey) { if (n.parent) select(n.parent.key, true); return; }
    if (dirKey === childKey) { if (n.kids.length) select(n.kids[Math.floor((n.kids.length - 1) / 2)].key, true); else if (n.collapsed) toggleFold(n); return; }
    var sib = siblingsOf(n);
    var i = sib.indexOf(n);
    var prevKey = vertical && mode === 'org' ? 'ArrowLeft' : 'ArrowUp';
    var nextKey = vertical && mode === 'org' ? 'ArrowRight' : 'ArrowDown';
    if (mode === 'tree' && dirKey === 'ArrowLeft') { if (n.parent) select(n.parent.key, true); return; }
    if (dirKey === prevKey && i > 0) select(sib[i - 1].key, true);
    else if (dirKey === nextKey && i < sib.length - 1) select(sib[i + 1].key, true);
  }
  stage.addEventListener('keydown', function (e) {
    if (e.target !== stage) return;
    var n = current();
    var mod = e.metaKey || e.ctrlKey;
    // Ctrl/Cmd+Z, Ctrl/Cmd+S and other VS Code keys go to VS Code itself: the webview forwards them, and VS Code's undo,
    // redo and save work on this document like in any text editor.
    if (mod) return;
    switch (e.key) {
      case 'Tab': e.preventDefault(); if (e.shiftKey) { if (n && n.parent) select(n.parent.key, true); } else addChild(); break;
      case 'Enter': e.preventDefault(); if (e.shiftKey && n && n.depth > 0) op({ op: 'addSibling', path: n.t.path, before: true }); else addSibling(); break;
      case 'Insert': e.preventDefault(); addChild(); break;
      case 'F2': e.preventDefault(); startEdit(n); break;
      case 'Delete': case 'Backspace': e.preventDefault(); del(); break;
      case ' ': e.preventDefault(); toggleFold(n); break;
      case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': e.preventDefault(); move(e.key); break;
      case 'Escape': S.sel = null; render(true); break;
      default: break;
    }
  });

  // ---------- mouse: select, rename, fold, drag to move, pan, zoom ----------
  function nodeFromEvent(e) {
    var g = e.target && e.target.closest ? e.target.closest('g.tp') : null;
    return g && S.last ? S.last.byKey.get(g.getAttribute('data-k')) : null;
  }
  function dropTarget(e) {
    host.classList.add('probing');
    var el = document.elementFromPoint(e.clientX, e.clientY);
    host.classList.remove('probing');
    var g = el && el.closest ? el.closest('g.tp') : null;
    if (!g) return null;
    var n = S.last.byKey.get(g.getAttribute('data-k'));
    if (!n) return null;
    var r = g.getBoundingClientRect();
    var f = (e.clientY - r.top) / Math.max(1, r.height);
    var where = n.depth === 0 ? 'child' : f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'child';
    return { n: n, where: where, g: g };
  }
  function clearDropMarks() { var olds = host.querySelectorAll('g.tp.drop-child, g.tp.drop-before, g.tp.drop-after'); for (var i = 0; i < olds.length; i++) olds[i].classList.remove('drop-child', 'drop-before', 'drop-after'); }
  stage.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || e.target === editbox) return;
    stage.focus();
    var n = nodeFromEvent(e);
    if (n) {
      var ic = e.target.closest && e.target.closest('[data-ic],[data-fold]');
      if (ic && ic.hasAttribute('data-fold')) { e.preventDefault(); select(n.key); toggleFold(n); return; }
      if (ic && ic.getAttribute('data-ic') === 'link') { e.preventDefault(); select(n.key); post({ type: 'openLink', url: n.t.link }); return; }
      select(n.key);
      if (n.depth > 0 && !S.readOnly) S.drag = { n: n, x: e.clientX, y: e.clientY, on: false, target: null };
      return;
    }
    S.pan = { x: e.clientX, y: e.clientY, tx: S.view.tx, ty: S.view.ty };
    stage.classList.add('panning');
  });
  window.addEventListener('mousemove', function (e) {
    if (S.pan) { S.view.tx = S.pan.tx + e.clientX - S.pan.x; S.view.ty = S.pan.ty + e.clientY - S.pan.y; S.view.auto = false; applyView(); return; }
    var d = S.drag;
    if (!d) return;
    if (!d.on && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 6) return;
    if (!d.on) { d.on = true; var g = host.querySelector('g.tp[data-k="' + d.n.key + '"]'); if (g) g.classList.add('dragging'); stage.classList.add('dragging'); }
    clearDropMarks();
    var t = dropTarget(e);
    d.target = null;
    if (t && t.n !== d.n && !(t.n.key + '.').startsWith(d.n.key + '.')) { d.target = t; t.g.classList.add('drop-' + t.where); }
  });
  window.addEventListener('mouseup', function () {
    if (S.pan) { S.pan = null; stage.classList.remove('panning'); return; }
    var d = S.drag;
    S.drag = null;
    stage.classList.remove('dragging');
    if (!d || !d.on) return;
    clearDropMarks();
    var g = host.querySelector('g.tp.dragging'); if (g) g.classList.remove('dragging');
    var t = d.target;
    if (!t) return;
    if (t.where === 'child') op({ op: 'move', path: d.n.t.path, to: t.n.t.path });
    else {
      var idx = t.n.t.path[t.n.t.path.length - 1] + (t.where === 'after' ? 1 : 0);
      op({ op: 'move', path: d.n.t.path, to: t.n.t.path.slice(0, -1), index: idx });
    }
  });
  stage.addEventListener('dblclick', function (e) { var n = nodeFromEvent(e); if (n && !(e.target.closest && e.target.closest('[data-fold]'))) startEdit(n); });
  stage.addEventListener('wheel', function (e) {
    if (!S.last) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      var r = stage.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      var z0 = S.view.z, z = Math.max(0.1, Math.min(4, z0 * Math.exp(-e.deltaY * 0.0025)));
      S.view.tx = mx - (mx - S.view.tx) * (z / z0); S.view.ty = my - (my - S.view.ty) * (z / z0); S.view.z = z;
    } else { S.view.tx -= e.deltaX; S.view.ty -= e.deltaY; }
    S.view.auto = false;
    applyView();
  }, { passive: false });

  // ---------- toolbar and details ----------
  $('layout').addEventListener('change', function () { S.layout = $('layout').value; if (vscode) vscode.setState({ layout: S.layout, folded: Array.from(S.folded), sel: S.sel }); render(false); stage.focus(); });
  $('addChild').addEventListener('click', function () { addChild(); });
  $('addSibling').addEventListener('click', function () { addSibling(); });
  $('del').addEventListener('click', function () { del(); });
  $('collapseAll').addEventListener('click', function () { foldAll(true); });
  $('expandAll').addEventListener('click', function () { foldAll(false); });
  $('fit').addEventListener('click', function () { fit(); stage.focus(); });
  $('openText').addEventListener('click', function () { post({ type: 'openText' }); });
  $('problemOpen').addEventListener('click', function () { post({ type: 'openText' }); });
  $('proExport').addEventListener('click', function () { post({ type: 'tool', id: 'export' }); });
  $('proConvert').addEventListener('click', function () { post({ type: 'tool', id: 'convert' }); });
  $('proTasks').addEventListener('click', function () { post({ type: 'tool', id: 'tasks' }); });
  function setField(field, value) { var n = current(); if (!n) return; op({ op: 'set', path: n.t.path, field: field, value: value }); }
  $('dPriority').addEventListener('change', function () { setField('priority', Number($('dPriority').value)); });
  $('dProgress').addEventListener('change', function () { setField('progress', Number($('dProgress').value)); });
  $('dLink').addEventListener('change', function () { setField('link', $('dLink').value.trim()); });
  $('dLink').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('dLink').blur(); } });
  $('dNote').addEventListener('change', function () { setField('note', $('dNote').value); });
  $('dNote').addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('dNote').blur(); } });

  // ---------- export (Zovo Pro tool; the extension asks, checks the try and writes the file) ----------
  function b64(buf) {
    var bytes = new Uint8Array(buf), s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  function exportPicture(m) {
    var lay = computeLayout();
    var branch = m.scope === 'branch' && S.sel !== null && lay.byKey.has(S.sel) ? S.sel : '';
    var d = drawSvg(lay, { forExport: true, background: m.background, branch: branch });
    var svg = '<?xml version="1.0" encoding="UTF-8"?>\n' + d.svg;
    if (m.format === 'svg') return Promise.resolve({ data: btoa(unescape(encodeURIComponent(svg))), w: d.W, h: d.H, count: d.count });
    var scale = Math.max(0.5, Math.min(Number(m.scale) || 2, 8));
    var MAXPX = 16000, MAXAREA = 120e6;
    scale = Math.min(scale, MAXPX / d.W, MAXPX / d.H, Math.sqrt(MAXAREA / (d.W * d.H)));
    var W = Math.max(1, Math.round(d.W * scale)), H = Math.max(1, Math.round(d.H * scale));
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas'); c.width = W; c.height = H;
          var g = c.getContext('2d');
          if (m.format === 'pdf' && m.background === 'transparent') { g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H); }
          g.drawImage(img, 0, 0, W, H);
          URL.revokeObjectURL(url);
          c.toBlob(function (blob) {
            if (!blob) { reject(new Error('The picture is too large for this computer.')); return; }
            blob.arrayBuffer().then(function (ab) { resolve({ data: b64(ab), w: W, h: H, scale: scale, count: d.count }); }, reject);
          }, m.format === 'pdf' ? 'image/jpeg' : 'image/png', 0.92);
        } catch (err) { reject(err); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('The map could not be drawn as a picture.')); };
      img.src = url;
    });
  }

  // ---------- messages ----------
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'model') {
      S.gen = m.gen; S.readOnly = !!m.readOnly; S.fmt = m.fmt || S.fmt;
      document.body.classList.toggle('readonly', S.readOnly);
      if (m.error) {
        S.model = null; S.error = m.error;
        $('problemText').textContent = m.error;
        $('problem').classList.remove('hidden');
        host.innerHTML = '';
        $('empty').textContent = 'This file cannot be shown as a mind map. Fix it in the text editor; the map comes back when the file reads again.';
        $('empty').classList.remove('hidden');
        $('status').textContent = 'Error';
        post({ type: 'rendered', gen: S.gen, nodes: 0, error: m.error });
        return;
      }
      $('problem').classList.add('hidden');
      var first = !S.model;
      S.model = m.model;
      if (first && !S.layout) S.layout = '';
      $('layout').value = layoutMode();
      if (m.select) S.sel = key(m.select);
      else if (first) S.sel = typeof saved.sel === 'string' ? saved.sel : 'r';
      render(!first);
      if (S.sel !== null) select(S.sel, true);
      if (m.edit && S.last && S.last.byKey.get(S.sel)) startEdit(S.last.byKey.get(S.sel));
      if (first) stage.focus();
    } else if (m.type === 'export') {
      exportPicture(m).then(function (r) { post({ type: 'exported', id: m.id, ok: true, data: r.data, w: r.w, h: r.h, scale: r.scale || 1, count: r.count }); },
        function (err) { post({ type: 'exported', id: m.id, ok: false, error: String((err && err.message) || err) }); });
    } else if (m.type === 'select') {
      var k = key(m.path || []);
      if (S.last && S.last.byKey.has(k)) select(k, true);
      else if (S.model) { // inside a collapsed branch: open the branches on the way (view only for OPML)
        var p = m.path || [];
        for (var i = 0; i < p.length; i++) S.folded.delete(key(p.slice(0, i)));
        if (S.fmt !== 'opml') post({ type: 'reveal', path: p });
        else { render(true); select(k, true); }
      }
    } else if (m.type === 'showPro') {
      $('pro').classList.toggle('hidden', !m.show);
    } else if (m.type === 'focus') { stage.focus(); }
  });
  // a map the user has not moved or zoomed stays fitted when the editor gets wider or narrower
  window.addEventListener('resize', function () { if (S.last && S.view.fitted) { if (S.view.auto) fit(); else applyView(); } });

  // footer (support links) and start
  var tpl = $('zovo-footer');
  if (tpl && tpl.innerHTML.trim()) $('footer').innerHTML = tpl.innerHTML;
  // the test hook for the real-app gate: read-only facts about the drawing
  window.__mindmap = { state: function () { return { sel: S.sel, layout: layoutMode(), nodes: S.last ? S.last.nodes.length : 0, count: S.model ? S.model.count : 0, editing: S.editing, view: S.view, fmt: S.fmt, readOnly: S.readOnly, error: S.error }; } };
  post({ type: 'ready' });
})();
