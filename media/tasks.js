// Task view (Zovo Pro): every topic of the map as a row with priority, progress, note and link. Filters run here; the
// export buttons ask the extension to save the rows shown. A click on a row selects that topic in the map.
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var $ = function (id) { return document.getElementById(id); };
  var PRIO = ['', '#e5484d', '#f76b15', '#e2a336', '#46a758', '#3e8ed0', '#8e4ec6', '#d6409f', '#12a594', '#7c7c7c'];
  var rows = [];
  var shown = [];
  function filterOf() { return { q: $('q').value, priority: $('fPriority').value, progress: $('fProgress').value, note: $('fNote').checked }; }
  function match(r, f) {
    var q = String(f.q || '').toLowerCase().trim();
    if (q && (r.title + '\n' + r.branch + '\n' + r.note + '\n' + r.link).toLowerCase().indexOf(q) < 0) return false;
    if (f.priority === 'any' && !r.priority) return false;
    if (f.priority === 'none' && r.priority) return false;
    if (/^\d$/.test(f.priority) && r.priority !== Number(f.priority)) return false;
    if (f.progress === 'none' && r.progress !== null) return false;
    if (f.progress === 'open' && (r.progress === null || r.progress >= 100)) return false;
    if (f.progress === 'done' && r.progress !== 100) return false;
    if (f.note && !r.note) return false;
    return true;
  }
  function cell(tr, text, cls) { var td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text; tr.appendChild(td); return td; }
  function draw() {
    var f = filterOf();
    shown = rows.filter(function (r) { return match(r, f); });
    var tb = $('rows');
    tb.textContent = '';
    var frag = document.createDocumentFragment();
    shown.slice(0, 5000).forEach(function (r) {
      var tr = document.createElement('tr');
      tr.className = 'row';
      tr.dataset.path = r.path;
      cell(tr, ' '.repeat(Math.min(r.depth, 12) * 2) + (r.title || '(no title)'), 'title');
      cell(tr, r.branch, 'branch');
      var pc = cell(tr, '', 'prio-cell');
      if (r.priority) { var b = document.createElement('span'); b.className = 'prio'; b.style.background = PRIO[r.priority]; b.textContent = String(r.priority); pc.appendChild(b); }
      cell(tr, r.progress === null ? '' : r.progress + ' %', 'progress');
      cell(tr, r.note, 'note');
      cell(tr, r.link, 'link');
      frag.appendChild(tr);
    });
    tb.appendChild(frag);
    $('count').textContent = shown.length + ' of ' + rows.length + ' topics' + (shown.length > 5000 ? ' (first 5000 shown)' : '');
  }
  ['q', 'fPriority', 'fProgress', 'fNote'].forEach(function (id) { $(id).addEventListener('input', draw); $(id).addEventListener('change', draw); });
  $('csv').addEventListener('click', function () { vscode.postMessage({ type: 'save', kind: 'csv', filter: filterOf() }); });
  $('md').addEventListener('click', function () { vscode.postMessage({ type: 'save', kind: 'md', filter: filterOf() }); });
  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest && e.target.closest('tr.row');
    if (tr) vscode.postMessage({ type: 'reveal', path: tr.dataset.path === '' ? [] : tr.dataset.path.split('.').map(Number) });
  });
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (m && m.type === 'rows') {
      rows = m.rows || [];
      $('file').textContent = m.title || '';
      draw();
      vscode.postMessage({ type: 'shown', count: rows.length, gen: m.gen });
    }
  });
  window.__tasks = { state: function () { return { rows: rows.length, shown: shown.length }; } };
  vscode.postMessage({ type: 'ready' });
})();
