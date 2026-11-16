'use strict';
// Core tests without VS Code: lossless parse and save of real KM, FreeMind/Freeplane and OPML files, every edit and
// what it leaves untouched, broken files, conversion between all formats, the Markdown outline, the task table and
// the PDF wrapper.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const X = require('../src/core/xmldoc');
const F = require('../src/core/formats');
const C = require('../src/core/convert');
const { minimalEdit } = F;

const REAL = path.join(__dirname, 'fixtures', 'real');
const read = (f) => fs.readFileSync(path.join(REAL, f), 'utf8');
const REALS = fs.readdirSync(REAL).filter((f) => F.formatOf(f));
const titles = (t) => C.walk(t).map(([x, d]) => `${d}:${x.title}`);
const edit = (text, fmt, ...ops) => { const d = F.load(text, fmt); let r; for (const o of ops) r = F.applyOp(d, o); return { text: F.save(d), r, d }; };
/** Lines of b that differ from a (same line count expected). */
function changedLines(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push([x[i], y[i]]);
  return out;
}

test('real files: 8 fixtures from 8 repositories, 2 KM, 4 MM (FreeMind 0.9, 1.0, Freeplane), 2 OPML', () => {
  assert.equal(REALS.length, 8);
  assert.equal(REALS.filter((f) => /\.km$/.test(f)).length, 2);
  assert.equal(REALS.filter((f) => /\.mm$/.test(f)).length, 4);
  assert.equal(REALS.filter((f) => /\.opml$/.test(f)).length, 2);
});

test('lossless: load + save of every real file gives the same bytes', () => {
  for (const f of REALS) {
    const t = read(f);
    const d = F.load(t, F.formatOf(f));
    assert.equal(F.save(d), t, f);
  }
});

test('model: topic counts and root titles of the real files', () => {
  const want = { 'overview.km': [21, '缓存篇'], 'observability.km': [26, 'Observability'], '3steps.mm': [9, '3 Simple steps\nto test your new\nArduino Clone'], 'CoffeeScad.mm': [109, 'CoffeeScad'], 'new.mm': [3, 'new'], 'MVC-MVP-MVVM.mm': [34, '思维导图'], 'assessment_mindset.opml': [731, 'Target'], 'note-blocks.opml': [1, 'Heading with note'] };
  for (const f of REALS) {
    const m = F.toModel(F.load(read(f), F.formatOf(f)));
    assert.deepEqual([m.count, m.root.title], want[f], f);
  }
});

test('model: notes, folded, side, rich titles and links read from FreeMind', () => {
  const m = F.toModel(F.load(read('3steps.mm'), 'mm'));
  assert.equal(m.root.rich, true);
  assert.equal(m.root.link, 'blogging.mm');
  assert.match(m.root.kids[0].note, /^You've built your latest/);
  assert.match(m.root.kids[0].note, /Follow these three steps to check it out\.$/);
  assert.equal(m.root.kids[0].side, 'right');
  const c = F.toModel(F.load(read('CoffeeScad.mm'), 'mm'));
  assert.equal(c.root.kids[0].title, 'Componens');
  assert.equal(c.root.kids[0].folded, true);
  const n = F.toModel(F.load(read('note-blocks.opml'), 'opml'));
  assert.equal(n.root.note, 'First paragraph with *emphasis* and **strong**.\n\nSecond paragraph after a blank line.');
});

test('KM edit: a rename changes only that text; every other key (unknown ones too) stays', () => {
  const t = read('observability.km');
  const { text } = edit(t, 'km', { op: 'rename', path: [0], text: 'Overview' });
  const diff = changedLines(t, text);
  assert.equal(diff.length, 1);
  assert.match(diff[0][1], /"text": "Overview"/);
  assert.ok(text.includes('"layout_right_offset"'));
  const e = minimalEdit(t, text);
  assert.ok(e.end - e.start < 10, 'the edit replaces a few characters only');
});

test('KM edit: add child, sibling, note, priority, progress, link, fold; then delete', () => {
  const t = read('overview.km');
  let r = edit(t, 'km', { op: 'addChild', path: [0], text: 'CDN' });
  let m = F.toModel(r.d);
  const n0 = m.root.kids[0].kids.length;
  assert.equal(m.root.kids[0].kids[n0 - 1].title, 'CDN');
  assert.deepEqual(r.r.select, [0, n0 - 1]);
  assert.equal(r.r.edit, true);
  const nd = r.d.obj.root.children[0].children[n0 - 1].data;
  assert.match(nd.id, /^[0-9a-z]{12}$/);
  assert.ok(nd.created > 1.7e12);
  r = edit(r.text, 'km',
    { op: 'set', path: [0, n0 - 1], field: 'note', value: 'Edge cache\nsecond line' },
    { op: 'set', path: [0, n0 - 1], field: 'priority', value: 2 },
    { op: 'set', path: [0, n0 - 1], field: 'progress', value: 5 },
    { op: 'set', path: [0, n0 - 1], field: 'link', value: 'https://example.com/cdn' },
    { op: 'fold', path: [0], folded: true });
  m = F.toModel(r.d);
  const k = m.root.kids[0].kids[n0 - 1];
  assert.deepEqual([k.note, k.priority, k.progress, k.link], ['Edge cache\nsecond line', 2, 5, 'https://example.com/cdn']);
  assert.equal(m.root.kids[0].folded, true);
  assert.equal(r.d.obj.root.children[0].data.expandState, 'collapse');
  r = edit(r.text, 'km', { op: 'fold', path: [0], folded: false }, { op: 'delete', path: [0, n0 - 1] });
  assert.equal(r.d.obj.root.children[0].data.expandState, 'expand');
  assert.equal(F.toModel(r.d).count, 21);
  // setting a field back to empty removes the key
  r = edit(read('overview.km'), 'km', { op: 'set', path: [0], field: 'priority', value: 3 }, { op: 'set', path: [0], field: 'priority', value: 0 });
  assert.equal(r.text, read('overview.km'));
});

test('KM: indentation, line ends and the final newline are kept; compact files stay compact', () => {
  const compact = '{"root":{"data":{"id":"a","text":"Root","x-custom":{"k":[1,2]}},"children":[]},"template":"right","theme":"x"}';
  const r = edit(compact, 'km', { op: 'rename', path: [], text: 'Main' });
  assert.equal(r.text, compact.replace('"Root"', '"Main"'));
  assert.equal(F.toModel(F.load(compact, 'km')).layout, 'right');
  const crlf = JSON.stringify({ root: { data: { text: 'R' }, children: [] } }, null, 2).replace(/\n/g, '\r\n') + '\r\n';
  assert.equal(edit(crlf, 'km', { op: 'rename', path: [], text: 'S' }).text, crlf.replace('"R"', '"S"'));
});

test('MM edit: a rename touches only that node\'s TEXT and MODIFIED; VSHIFT, HGAP, STYLE and everything else stay', () => {
  const t = read('CoffeeScad.mm');
  const { text } = edit(t, 'mm', { op: 'rename', path: [0], text: 'Components & "parts"' });
  const diff = changedLines(t, text);
  assert.equal(diff.length, 1);
  assert.match(diff[0][1], /TEXT="Components &amp; &quot;parts&quot;"/);
  assert.match(diff[0][1], /^<node CREATED="1355011154340" FOLDED="true" ID="ID_1966678095" MODIFIED="\d+" POSITION="right" TEXT=/);
  assert.equal(X.parse(text) && F.toModel(F.load(text, 'mm')).root.kids[0].title, 'Components & "parts"');
});

test('MM edit: renaming a rich-text (HTML) title writes plain TEXT and drops that HTML only', () => {
  const t = read('3steps.mm');
  const r = edit(t, 'mm', { op: 'rename', path: [], text: 'Three steps' });
  const m = F.toModel(r.d);
  assert.equal(m.root.title, 'Three steps');
  assert.equal(m.root.rich, false);
  assert.match(m.root.kids[0].note, /^You've built/);
  assert.ok(!/TYPE="NODE"[\s\S]*3 Simple steps/.test(r.text));
  assert.ok(r.text.includes('LINK="blogging.mm"'));
});

test('MM edit: a new child in a Freeplane map gets ID, CREATED, MODIFIED, POSITION and the file\'s indentation; styles stay', () => {
  const t = read('new.mm');
  const r = edit(t, 'mm', { op: 'addChild', path: [], text: 'Third' });
  assert.ok(r.text.includes('<map_styles>'));
  assert.ok(r.text.includes('<hook NAME="MapStyle"'));
  const m = F.toModel(F.load(r.text, 'mm'));
  const k = m.root.kids[m.root.kids.length - 1];
  assert.equal(k.title, 'Third');
  assert.match(r.text, /\n {8}<node TEXT="Third" ID="ID_\d+" CREATED="\d+" MODIFIED="\d+" POSITION="(left|right)"\/>/);
  // removing it again gives the original bytes
  const back = edit(r.text, 'mm', { op: 'delete', path: [m.root.kids.length - 1] });
  assert.equal(back.text, t);
});

test('MM edit: a child under a self-closing node, notes, priority and progress icons; the result reads again', () => {
  const t = read('CoffeeScad.mm');
  const m0 = F.toModel(F.load(t, 'mm'));
  // find a leaf
  const leaf = C.walk(m0.root).find(([x]) => !x.kids.length && x.path.length >= 2)[0];
  let r = edit(t, 'mm', { op: 'addChild', path: leaf.path, text: 'Under a leaf' });
  let m = F.toModel(F.load(r.text, 'mm'));
  const at = (mm, p) => p.reduce((x, i) => x.kids[i], mm.root);
  assert.equal(at(m, leaf.path).kids[0].title, 'Under a leaf');
  r = edit(r.text, 'mm',
    { op: 'set', path: leaf.path, field: 'note', value: 'Line one\nLine <two> & three' },
    { op: 'set', path: leaf.path, field: 'priority', value: 4 },
    { op: 'set', path: leaf.path, field: 'progress', value: 5 },
    { op: 'set', path: leaf.path, field: 'link', value: 'https://example.com/a?b=1&c=2' });
  m = F.toModel(F.load(r.text, 'mm'));
  const x = at(m, leaf.path);
  assert.deepEqual([x.note, x.priority, x.progress, x.link], ['Line one\nLine <two> & three', 4, 5, 'https://example.com/a?b=1&c=2']);
  assert.match(r.text, /<icon BUILTIN="full-4"\/>/);
  assert.match(r.text, /<icon BUILTIN="50%"\/>/);
  assert.match(r.text, /<richcontent TYPE="NOTE"><html><head><\/head><body><p>Line one<\/p><p>Line &lt;two&gt; &amp; three<\/p><\/body><\/html><\/richcontent>/);
  // progress in MM snaps to the icons: 0, 25, 50, 75, 100 %
  r = edit(r.text, 'mm', { op: 'set', path: leaf.path, field: 'progress', value: 6 }, { op: 'set', path: leaf.path, field: 'priority', value: 0 });
  m = F.toModel(F.load(r.text, 'mm'));
  assert.equal(at(m, leaf.path).progress, 7);
  assert.equal(at(m, leaf.path).priority, 0);
  assert.ok(!/full-4/.test(r.text));
});

test('MM: a FreeMind file without indentation gets new nodes without indentation', () => {
  const t = '<map version="1.0.1">\n<node TEXT="Root" ID="ID_1">\n<node TEXT="A" ID="ID_2" POSITION="right"/>\n</node>\n</map>\n';
  const r = edit(t, 'mm', { op: 'addSibling', path: [0], text: 'B' });
  assert.match(r.text, /<node TEXT="A" ID="ID_2" POSITION="right"\/>\n<node TEXT="B" ID="ID_\d+" CREATED="\d+" MODIFIED="\d+" POSITION="left"\/>\n<\/node>/);
  const r2 = edit(t, 'mm', { op: 'addChild', path: [0], text: 'A1' });
  assert.match(r2.text, /<node TEXT="A" ID="ID_2" POSITION="right">\n<node TEXT="A1" ID="ID_\d+" CREATED="\d+" MODIFIED="\d+"\/>\n<\/node>/);
  // attribute TEXT in another letter case (seen in a real file) is read and renamed in place
  const odd = '<map version="1.0.0"><node Text="Mixed"><node TEXT="x" POSITION="right"/></node></map>';
  assert.equal(F.toModel(F.load(odd, 'mm')).root.title, 'Mixed');
  assert.equal(edit(odd, 'mm', { op: 'rename', path: [], text: 'Fixed' }).text, odd.replace('Text="Mixed"', 'Text="Fixed"'));
});

test('MM: new lines and tabs in a title are written as character references and read back', () => {
  const t = '<map version="1.0.1">\n<node TEXT="Root">\n</node>\n</map>\n';
  const r = edit(t, 'mm', { op: 'rename', path: [], text: 'two\nlines\tand "quotes"' });
  assert.ok(r.text.includes('TEXT="two&#10;lines&#9;and &quot;quotes&quot;"'));
  assert.equal(F.toModel(F.load(r.text, 'mm')).root.title, 'two\nlines\tand "quotes"');
});

test('OPML edit: rename, note, priority, progress and link use text, _note, _priority, _progress and url; head stays', () => {
  const t = read('assessment_mindset.opml');
  const r = edit(t, 'opml',
    { op: 'rename', path: [0], text: 'Infra' },
    { op: 'set', path: [0], field: 'note', value: 'Two\nlines' },
    { op: 'set', path: [0], field: 'priority', value: 1 },
    { op: 'set', path: [0], field: 'progress', value: 9 },
    { op: 'set', path: [0], field: 'link', value: 'https://example.com' });
  assert.match(r.text, /<outline text="Infra" _note="Two&#10;lines" _priority="1" _progress="100" url="https:\/\/example.com">/);
  assert.ok(r.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.0">\n    <head>\n        <title>Target</title>'));
  const k = F.toModel(F.load(r.text, 'opml')).root.kids[0];
  assert.deepEqual([k.title, k.note, k.priority, k.progress, k.link], ['Infra', 'Two\nlines', 1, 9, 'https://example.com']);
  // fold is a view setting in OPML: the file does not change
  assert.equal(edit(t, 'opml', { op: 'fold', path: [0], folded: true }).text, t);
});

test('OPML: several top outlines get a stand-in root (the file title) that is not written', () => {
  const t = '<?xml version="1.0"?>\n<opml version="2.0">\n  <head>\n    <title>Plan</title>\n  </head>\n  <body>\n    <outline text="A" _complete="true"/>\n    <outline text="B"/>\n  </body>\n</opml>\n';
  const d = F.load(t, 'opml');
  const m = F.toModel(d);
  assert.equal(m.root.virtual, true);
  assert.equal(m.root.title, 'Plan');
  assert.equal(m.root.kids[0].progress, 9, '_complete="true" reads as done');
  assert.equal(edit(t, 'opml', { op: 'rename', path: [], text: 'X' }).text, t);
  const r = edit(t, 'opml', { op: 'addChild', path: [], text: 'C' });
  assert.match(r.text, /<outline text="B"\/>\n {4}<outline text="C"\/>\n {2}<\/body>/);
  const r2 = edit(t, 'opml', { op: 'addChild', path: [1], text: 'B1' });
  assert.match(r2.text, /<outline text="B">\n {6}<outline text="B1"\/>\n {4}<\/outline>/);
});

test('ops: sibling before and after, delete keeps a sensible selection, the root cannot go', () => {
  const t = JSON.stringify({ root: { data: { text: 'R' }, children: [{ data: { text: 'A' }, children: [] }, { data: { text: 'B' }, children: [] }] } });
  let r = edit(t, 'km', { op: 'addSibling', path: [0], text: 'A2' });
  assert.deepEqual(titles(F.toModel(r.d).root), ['0:R', '1:A', '1:A2', '1:B']);
  assert.deepEqual(r.r.select, [1]);
  r = edit(t, 'km', { op: 'addSibling', path: [0], text: 'A0', before: true });
  assert.deepEqual(titles(F.toModel(r.d).root), ['0:R', '1:A0', '1:A', '1:B']);
  r = edit(t, 'km', { op: 'addSibling', path: [], text: 'C' });
  assert.deepEqual(titles(F.toModel(r.d).root), ['0:R', '1:A', '1:B', '1:C'], 'Enter on the root adds a child');
  r = edit(t, 'km', { op: 'delete', path: [1] });
  assert.deepEqual(r.r.select, [0]);
  r = edit(r.text, 'km', { op: 'delete', path: [0] });
  assert.deepEqual(r.r.select, []);
  assert.throws(() => edit(t, 'km', { op: 'delete', path: [] }), /root topic cannot be deleted/);
  assert.throws(() => edit(t, 'km', { op: 'rename', path: [5], text: 'x' }), /no longer in the file/);
  assert.throws(() => edit(t, 'km', { op: 'nope', path: [] }), /Unknown edit/);
});

test('ops: drag to move: into another branch, before/after in the same parent, never into its own branch', () => {
  const T = (text, ...k) => ({ data: { text }, children: k });
  const t = JSON.stringify({ root: T('R', T('A', T('A1'), T('A2')), T('B'), T('C')) });
  let r = edit(t, 'km', { op: 'move', path: [0, 1], to: [1] });
  assert.deepEqual(titles(F.toModel(r.d).root), ['0:R', '1:A', '2:A1', '1:B', '2:A2', '1:C']);
  assert.deepEqual(r.r.select, [1, 0]);
  r = edit(t, 'km', { op: 'move', path: [2], to: [], index: 0 });
  assert.deepEqual(titles(F.toModel(r.d).root), ['0:R', '1:C', '1:A', '2:A1', '2:A2', '1:B']);
  r = edit(t, 'km', { op: 'move', path: [0], to: [], index: 3 });
  assert.deepEqual(titles(F.toModel(r.d).root), ['0:R', '1:B', '1:C', '1:A', '2:A1', '2:A2']);
  assert.deepEqual(r.r.select, [2]);
  r = edit(t, 'km', { op: 'move', path: [0], to: [2] }); // A into C, C sits after A
  assert.deepEqual(titles(F.toModel(r.d).root), ['0:R', '1:B', '1:C', '2:A', '3:A1', '3:A2']);
  assert.deepEqual(r.r.select, [1, 0]);
  assert.throws(() => edit(t, 'km', { op: 'move', path: [0], to: [0, 1] }), /own branch/);
  assert.equal(edit(t, 'km', { op: 'move', path: [1], to: [], index: 1 }).text, t, 'dropping in place changes nothing');
  // in FreeMind a topic that becomes a main topic gets a side
  const mm = '<map version="1.0.1">\n<node TEXT="R">\n<node TEXT="A" POSITION="right">\n<node TEXT="A1"/>\n</node>\n</node>\n</map>\n';
  const m = edit(mm, 'mm', { op: 'move', path: [0, 0], to: [] });
  assert.match(m.text, /<node TEXT="A1" POSITION="left"\/>/);
});

test('ops: collapse all and expand all write the fold state of every branch', () => {
  const t = read('CoffeeScad.mm');
  const r = edit(t, 'mm', { op: 'foldAll', path: [], folded: true });
  const m = F.toModel(r.d);
  const branches = C.walk(m.root).filter(([x]) => x.kids.length && x.path.length);
  assert.ok(branches.length > 5);
  assert.ok(branches.every(([x]) => x.folded));
  const e = edit(r.text, 'mm', { op: 'foldAll', path: [], folded: false });
  assert.ok(C.walk(F.toModel(e.d).root).every(([x]) => !x.folded));
});

test('broken files: clear messages with a line number where there is one', () => {
  assert.throws(() => F.load('{"root": {"data": {"text": "a"}}, }', 'km'), (e) => e instanceof F.MapError && /not valid JSON/.test(e.message));
  assert.throws(() => F.load('{\n"root":\n{\n"data": {"text": "a"\n}\n', 'km'), (e) => /not valid JSON/.test(e.message));
  assert.throws(() => F.load('{"template":"default"}', 'km'), /no "root" topic/);
  assert.throws(() => F.load('{"root":{"data":{},"children":{}}}', 'km'), /not a list/);
  assert.throws(() => F.load('', 'km'), /empty/);
  assert.throws(() => F.load('<map version="1.0.1">\n<node TEXT="a">\n</map>\n', 'mm'), (e) => /not valid XML/.test(e.message) && e.line === 3);
  assert.throws(() => F.load('<opml><body><outline text="x"/></body></opml>', 'mm'), /not a FreeMind or Freeplane map/);
  assert.throws(() => F.load('<map version="1.0.1"></map>', 'mm'), /no root topic/);
  assert.throws(() => F.load('<opml version="2.0"><head/></opml>', 'opml'), /no <body>/);
  assert.throws(() => F.load('\u0000\u0001binary', 'opml'), /not valid XML|not OPML/);
  assert.throws(() => F.load('<map version="1.0.1"><node TEXT="a" ID=x></node></map>', 'mm'), /not valid XML/);
  assert.throws(() => F.load('<opml version="2.0"><body>\n<<outline text="x"/>\n</body></opml>', 'opml'), (e) => /A "<" that does not start a tag/.test(e.message) && e.line === 2);
  assert.throws(() => F.load('<opml version="2.0"><body><1outline/></body></opml>', 'opml'), /does not start a tag/);
});

test('xml: deep files do not overflow the stack; comments, CDATA and DOCTYPE stay', () => {
  const depth = 20000;
  const t = '<map version="1.0.1">' + '<node TEXT="n">'.repeat(depth) + '</node>'.repeat(depth) + '</map>';
  const d = F.load(t, 'mm');
  assert.equal(F.save(d), t);
  assert.equal(F.toModel(d).count, depth);
  const s = '<?xml version="1.0"?>\n<!DOCTYPE opml [ <!ENTITY x "y"> ]>\n<!-- c -->\n<opml version="2.0"><body><outline text="a"><![CDATA[ raw <b> ]]></outline></body></opml>';
  assert.equal(F.save(F.load(s, 'opml')), s);
});

test('convert: every real file to KM, MM, OPML and Markdown and back keeps the topic tree', () => {
  for (const f of REALS) {
    const root = F.toModel(F.load(read(f), F.formatOf(f))).root;
    const want = titles(root).map((x) => x.replace(/\n+/g, ' ').trim());
    for (const kind of ['km', 'mm', 'opml']) {
      const out = C.write(root, kind, 'Title');
      const back = F.toModel(F.load(out, kind)).root;
      assert.deepEqual(titles(back).map((x) => x.replace(/\n+/g, ' ').trim()), want, `${f} -> ${kind}`);
    }
    const md = C.write(root, 'md');
    const back = C.fromMarkdown(md, 'x');
    assert.equal(C.walk(back).length, C.walk(root).length, `${f} -> md`);
    const notes = (r) => C.walk(r).map(([x]) => x.note.replace(/\s+/g, ' ').trim());
    assert.deepEqual(notes(back), notes(root), `${f} -> md notes`);
  }
});

test('convert: notes, priority, progress, links and fold state go along', () => {
  const t = C.topic('Root');
  const a = C.topic('A'); a.note = 'note a\nline 2'; a.priority = 3; a.progress = 5; a.link = 'https://example.com/x?y=1&z=2';
  const b = C.topic('B'); b.folded = true; b.kids.push(C.topic('B1'));
  t.kids.push(a, b);
  for (const kind of ['km', 'mm', 'opml']) {
    const m = F.toModel(F.load(C.write(t, kind), kind)).root;
    const x = m.kids[0];
    assert.deepEqual([x.note, x.priority, x.progress, x.link], ['note a\nline 2', 3, 5, 'https://example.com/x?y=1&z=2'], kind);
    if (kind !== 'opml') assert.equal(m.kids[1].folded, true, kind);
  }
  const mm = C.write(t, 'mm');
  assert.match(mm, /^<map version="1\.0\.1">/);
  assert.match(mm, /POSITION="right"[^>]*>[\s\S]*POSITION="left"/);
  const km = JSON.parse(C.write(t, 'km'));
  assert.equal(km.root.children[1].data.expandState, 'collapse');
});

test('markdown: headings, lists, task boxes, links and paragraphs become a map; front matter and code stay out of titles', () => {
  const md = '---\ntitle: x\n---\n# Trip\n\nAll about the trip.\n\n## Before\n\n- [x] Book flights\n- [ ] Pack\n  - Passport\n  - [Map](https://example.com/map)\n\n## During\n\nSee the plan.\n\n```\n# not a heading\n```\n\n1. Day one\n2. Day two\n';
  const t = C.fromMarkdown(md, 'fallback');
  assert.equal(t.title, 'Trip');
  assert.equal(t.note, 'All about the trip.');
  assert.deepEqual(titles(t), ['0:Trip', '1:Before', '2:Book flights', '2:Pack', '3:Passport', '3:Map', '1:During', '2:Day one', '2:Day two']);
  assert.equal(t.kids[0].kids[0].progress, 9);
  assert.equal(t.kids[0].kids[1].progress, 1);
  assert.equal(t.kids[0].kids[1].kids[1].link, 'https://example.com/map');
  assert.match(t.kids[1].note, /See the plan\.\n\n```\n# not a heading\n```/);
  // two H1s: the file name is the root
  const two = C.fromMarkdown('# A\n# B\n', 'notes');
  assert.deepEqual(titles(two), ['0:notes', '1:A', '1:B']);
  // and back: map -> markdown -> map gives the same tree
  const again = C.fromMarkdown(C.toMarkdown(t), 'x');
  assert.deepEqual(titles(again), titles(t));
  assert.equal(again.kids[0].kids[1].kids[1].link, 'https://example.com/map');
});

test('tasks: rows, filters, CSV (quotes and formula guard) and a Markdown table', () => {
  const root = F.toModel(F.load(read('overview.km'), 'km')).root;
  const rows = C.taskRows(root);
  assert.equal(rows.length, 21);
  assert.equal(rows[0].depth, 0);
  assert.equal(rows[1].branch, '缓存篇');
  const t = C.topic('R');
  const a = C.topic('=SUM(A1) "x", y'); a.priority = 1; a.progress = 9; a.note = 'n1\nn2';
  const b = C.topic('b|c'); b.progress = 5;
  t.kids.push(a, b);
  t.path = []; a.path = [0]; b.path = [1];
  const r = C.taskRows(t);
  assert.deepEqual(C.filterRows(r, { priority: 'any' }).map((x) => x.path), ['0']);
  assert.deepEqual(C.filterRows(r, { progress: 'open' }).map((x) => x.path), ['1']);
  assert.deepEqual(C.filterRows(r, { progress: 'done' }).map((x) => x.path), ['0']);
  assert.deepEqual(C.filterRows(r, { progress: 'none' }).map((x) => x.path), ['']);
  assert.deepEqual(C.filterRows(r, { note: true }).map((x) => x.path), ['0']);
  assert.deepEqual(C.filterRows(r, { q: 'B|C' }).map((x) => x.path), ['1']);
  const csv = C.rowsCsv(r);
  assert.ok(csv.startsWith('Topic,Branch,Level,Priority,Progress %,Note,Link\r\n'));
  assert.ok(csv.includes('"\'=SUM(A1) ""x"", y",R,1,1,100,"n1\nn2",'));
  const md = C.rowsMarkdown(r, 'f.km');
  assert.ok(md.includes('| b\\|c | R |  | 50 % |  |  |'));
  assert.ok(md.includes('n1<br>n2'));
});

test('pdf: a one-page PDF around a JPEG with the right page size and a valid xref', () => {
  // smallest JPEG header with an SOF0 segment: 3 x 2 pixels
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
  assert.deepEqual(C.jpegSize(jpeg), { w: 3, h: 2 });
  assert.equal(C.jpegSize(Buffer.from('not a jpeg')), null);
  const pdf = C.pdfFromJpeg(jpeg, 800, 400, 2);
  const s = pdf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.includes('/MediaBox [0 0 300 150]'));
  assert.ok(s.includes('/Filter /DCTDecode /Length 23'));
  const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.ok(s.slice(xref).startsWith('xref\n0 7\n'));
  const offs = s.slice(xref).split('\n').slice(3, 9).map((l) => Number(l.slice(0, 10)));
  offs.forEach((o, i) => assert.ok(s.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
});

test('text edits: a line diff turns the old text into the new one with small, ordered replaces', () => {
  const apply = (t, es) => { let o = t; for (const e of es.slice().reverse()) o = o.slice(0, e.start) + e.text + o.slice(e.end); return o; };
  for (const f of REALS) {
    const t = read(f);
    const fmt = F.formatOf(f);
    for (const ops of [[{ op: 'addChild', path: [0] }], [{ op: 'foldAll', path: [], folded: true }], [{ op: 'set', path: [], field: 'note', value: 'a\nb' }], [{ op: 'rename', path: [], text: 'R' }]]) {
      const d = F.load(t, fmt);
      try { for (const o of ops) F.applyOp(d, o); } catch (e) { continue; }
      const out = F.save(d);
      const es = F.textEdits(t, out);
      assert.equal(apply(t, es), out, `${f} ${ops[0].op}`);
      for (let i = 1; i < es.length; i++) assert.ok(es[i].start >= es[i - 1].end, 'ordered, no overlap');
    }
  }
  const t = 'a\nb\nc\nd\ne\n';
  assert.deepEqual(F.textEdits(t, 'a\nB\nc\nd\nE\n'), [{ start: 2, end: 3, text: 'B' }, { start: 8, end: 9, text: 'E' }]);
  assert.deepEqual(F.textEdits(t, t), []);
});

test('minimal edit: replaces only the changed middle', () => {
  assert.deepEqual(minimalEdit('abcdef', 'abXYef'), { start: 2, end: 4, text: 'XY' });
  assert.deepEqual(minimalEdit('aaa', 'aaaa'), { start: 3, end: 3, text: 'a' });
  assert.deepEqual(minimalEdit('abc', 'abc'), { start: 3, end: 3, text: '' });
});

test('layout code is the XMind Viewer\'s, copied unchanged', () => {
  const ours = fs.readFileSync(path.join(__dirname, '..', 'media', 'layout.js'));
  const theirs = path.join(__dirname, '..', '..', 'xmind-viewer-vscode', 'src', 'webview', 'layout.js');
  if (fs.existsSync(theirs)) assert.ok(ours.equals(fs.readFileSync(theirs)));
  const L = require('../media/layout.js');
  const n = (w, h, kids = []) => ({ t: { side: '' }, w, h, kids });
  const root = n(80, 30, [n(40, 20), n(40, 20), n(40, 20)]);
  L.layout(root, 'map');
  assert.ok(root.kids.some((k) => k.x > 0) && root.kids.some((k) => k.x < 0), 'both sides');
});
