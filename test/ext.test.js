'use strict';
// Extension tests with the vscode stub: the listing, activation, the custom editor (model, edits through the text
// document, broken files, links), the three Pro tools with 1 free try each (A then B, reload, Cancel), the webview CSP,
// the copied modules, README and walkthrough text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ZOVO_PRO_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-pro-')), 'pro.json');
const { loadExtension, tmpDir, cleanup } = require('./support/vscode-stub');
const { editorHtml, tasksHtml } = require('../src/html');
const F = require('../src/core/formats');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const REAL = path.join(__dirname, 'fixtures', 'real');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await tick(5); } return f(); };
test.after(() => { cleanup(); fs.rmSync(path.dirname(process.env.ZOVO_PRO_FILE), { recursive: true, force: true }); });

// 3 x 2 pixel JPEG header (enough for the PDF wrapper) and a 1 x 1 PNG
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function workspace() {
  const dir = tmpDir('mindmap-ws-');
  fs.mkdirSync(path.join(dir, 'maps', 'sub'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'samples', 'project-plan.km'), path.join(dir, 'maps', 'plan.km'));
  fs.copyFileSync(path.join(REAL, 'overview.km'), path.join(dir, 'maps', 'OVERVIEW.KM'));
  fs.copyFileSync(path.join(REAL, 'CoffeeScad.mm'), path.join(dir, 'maps', 'coffee.mm'));
  fs.copyFileSync(path.join(REAL, 'note-blocks.opml'), path.join(dir, 'maps', 'sub', 'notes.opml'));
  fs.writeFileSync(path.join(dir, 'maps', 'sub', 'broken.mm'), '<map version="1.0.1">\n<node TEXT="a">\n</map>\n');
  fs.writeFileSync(path.join(dir, 'outline.md'), '# Trip\n\n## Before\n\n- Book\n- Pack\n');
  return dir;
}
function activate(folder, state) {
  const s = loadExtension();
  if (folder) s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(folder), name: 'ws' }];
  if (state) for (const [k, v] of state) s.state.set(k, v);
  // the webview: answers like the real page does after drawing or exporting
  s.log.onPost = (panel, m) => {
    if (m.type === 'model') panel.send({ type: 'rendered', gen: m.gen, nodes: m.model ? m.model.count : 0, count: m.model ? m.model.count : 0, error: m.error });
    if (m.type === 'export') {
      const data = m.format === 'svg' ? Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>') : m.format === 'pdf' ? JPEG : PNG;
      panel.send({ type: 'exported', id: m.id, ok: true, data: data.toString('base64'), w: 3, h: 2, scale: m.scale || 1, count: 7 });
    }
    if (m.type === 'rows') panel.send({ type: 'shown', count: m.rows.length });
  };
  s.api = s.ext.activate(s.context);
  return s;
}
async function openMap(s, file) {
  const uri = s.vscode.Uri.file(file);
  await s.vscode.commands.executeCommand(`zovoMindmap.openWith`, uri);
  const ses = s.api.editor.sessionFor(uri);
  await until(() => ses.lastRender);
  return ses;
}
const models = (s) => s.log.posted.filter((m) => m.type === 'model');
const lastModel = (s) => models(s).slice(-1)[0];

test('listing: name, phrase first, 5 keywords from the row, engines, publisher, repository, icon, activation', () => {
  assert.equal(pkg.displayName, 'Mindmap Editor: KM, MM & OPML');
  assert.ok(pkg.displayName.length <= 30);
  assert.ok(pkg.description.startsWith('Mindmap editor'));
  assert.deepEqual(pkg.keywords, ['mindmap', 'mind map', 'brainstorming', 'outline', 'notes']);
  assert.equal(pkg.engines.vscode, '^1.75.0');
  assert.equal(pkg.publisher, 'zovo'); assert.equal(pkg.name, 'zovo-mindmap-editor'); assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository.url, 'https://github.com/theluckystrike/mindmap-editor-vscode');
  const png = fs.readFileSync(path.join(ROOT, 'icon.png'));
  assert.equal(png.readUInt32BE(16), 128); assert.equal(png.readUInt32BE(20), 128);
  assert.ok(pkg.activationEvents.every((e) => /^(onCustomEditor|onCommand):zovoMindmap\.|^onUri$/.test(e)), pkg.activationEvents.join());
  assert.ok(pkg.activationEvents.includes('onUri'));
  assert.ok(!pkg.activationEvents.some((e) => e === '*' || e === 'onStartupFinished'));
});

test('listing: .km opens by default; .mm and .opml only on request (priority option), so the XMind viewer keeps them', () => {
  const ce = pkg.contributes.customEditors;
  assert.equal(ce.length, 2);
  assert.deepEqual(ce[0].selector, [{ filenamePattern: '*.km' }]);
  assert.equal(ce[0].priority, 'default');
  assert.deepEqual(ce[1].selector, [{ filenamePattern: '*.mm' }, { filenamePattern: '*.opml' }]);
  assert.equal(ce[1].priority, 'option');
  assert.equal(pkg.contributes.languages, undefined);
});

test('listing: menus have no title keys, Explorer Pro entries are palette-hidden "Zovo Pro: " wrappers, regexes are escaped once', () => {
  const menus = pkg.contributes.menus;
  for (const [where, items] of Object.entries(menus)) for (const it of items) assert.equal(it.title, undefined, `${where} ${it.command}`);
  const wrappers = pkg.contributes.commands.filter((c) => /\.zovoPro\./.test(c.command));
  assert.deepEqual(wrappers.map((c) => c.command.split('.').pop()), ['export', 'convert', 'tasks']);
  assert.ok(wrappers.every((c) => c.title.startsWith('Zovo Pro: ')));
  for (const w of wrappers) assert.ok(menus.commandPalette.some((m) => m.command === w.command && m.when === 'false'), w.command);
  const ctx = menus['explorer/context'].find((m) => m.command === 'zovoMindmap.openWith');
  assert.equal(ctx.when, 'resourceExtname =~ /^\\.(km|mm|opml)$/i && !explorerResourceIsFolder');
  const re = /resourceExtname =~ \/(.*?)\/i/.exec(ctx.when)[1];
  for (const f of ['a.km', 'B.MM', 'c.opml', 'SAMPLE.OPML']) assert.ok(new RegExp(re, 'i').test(path.extname(f)), f);
  assert.ok(!new RegExp(re, 'i').test('.md'));
  assert.ok(menus['explorer/context'].some((m) => m.command === 'zovoMindmap.zovoPro.convert' && /explorerResourceIsFolder &&/.test(m.when)));
  for (const c of pkg.contributes.commands) if (!/\.zovoPro\./.test(c.command) && c.category !== 'Zovo Pro') assert.equal(c.category, 'Mindmap', c.command);
});

test('activation shows nothing: no message, no panel, no editor, no URL; every contributed command is registered', () => {
  const s = activate(workspace());
  assert.equal(s.log.info.length + s.log.warn.length + s.log.error.length, 0);
  assert.equal(s.log.panel, undefined);
  assert.equal(s.log.external.length, 0);
  for (const c of pkg.contributes.commands) assert.ok(s.commands.has(c.command), c.command);
  assert.deepEqual([...s.providers.customs.keys()], ['zovoMindmap.editor', 'zovoMindmap.editorOption']);
});

test('editor: a .km file opens as a model; a FreeMind file opens with the option view type; nothing is written on open', async () => {
  const dir = workspace();
  const s = activate(dir);
  const file = path.join(dir, 'maps', 'plan.km');
  const before = fs.readFileSync(file, 'utf8');
  const ses = await openMap(s, file);
  assert.equal(s.log.editors[0].viewType, 'zovoMindmap.editor');
  const m = lastModel(s);
  assert.equal(m.fmt, 'km');
  assert.equal(m.model.root.title, 'Website relaunch');
  assert.equal(m.model.count, 25);
  assert.ok(ses.lastRender && !ses.lastRender.error);
  const html = ses.panel.webview.html;
  assert.match(html, /id="stage"/);
  assert.match(html, /media\/map\.js/);
  await openMap(s, path.join(dir, 'maps', 'coffee.mm'));
  assert.equal(s.log.editors[1].viewType, 'zovoMindmap.editorOption');
  assert.equal(lastModel(s).model.count, 109);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(s.log.info.length + s.log.warn.length + s.log.error.length, 0, 'nothing popped up');
  assert.equal(s.log.edits.length, 0);
});

test('editor: an edit from the map is one small text edit of the document (dirty, not saved), and the map redraws with the new topic selected', async () => {
  const dir = workspace();
  const s = activate(dir);
  const file = path.join(dir, 'maps', 'coffee.mm');
  const disk = fs.readFileSync(file, 'utf8');
  const ses = await openMap(s, file);
  const n = models(s).length;
  ses.panel.send({ type: 'op', op: 'addChild', path: [1] });
  await until(() => models(s).length > n);
  const m = lastModel(s);
  const k = m.model.root.kids[1];
  assert.equal(k.kids[k.kids.length - 1].title, 'New topic');
  assert.deepEqual(m.select, [1, k.kids.length - 1]);
  assert.equal(m.edit, true, 'the new topic opens for typing');
  assert.equal(s.log.edits.length, 1);
  const we = s.log.edits[0];
  const [edits] = [...we.map.values()];
  assert.equal(edits.length, 2, 'FOLDED="true" of the parent and the new node');
  assert.ok(edits.every((e) => e.text.length < 200), 'only the changed parts are replaced');
  assert.equal(ses.document.isDirty, true);
  assert.equal(fs.readFileSync(file, 'utf8'), disk, 'the file on disk changes only on save');
  // rename it, then set a note: each is its own edit (one undo step each)
  ses.panel.send({ type: 'op', op: 'rename', path: m.select, text: 'Parts list' });
  await until(() => s.log.edits.length === 2);
  ses.panel.send({ type: 'op', op: 'set', path: m.select, field: 'note', value: 'Check stock' });
  await until(() => s.log.edits.length === 3 && lastModel(s).model.root.kids[1].kids.slice(-1)[0].note);
  const t = lastModel(s).model.root.kids[1].kids.slice(-1)[0];
  assert.deepEqual([t.title, t.note], ['Parts list', 'Check stock']);
  await ses.document.save();
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(saved.includes('TEXT="Parts list"'));
  assert.ok(saved.includes('VSHIFT="-114"'), 'other attributes stay');
  // an edit that changes nothing writes nothing
  ses.panel.send({ type: 'op', op: 'rename', path: [0], text: 'Componens' });
  await tick(30);
  assert.equal(s.log.edits.length, 3);
  assert.equal(s.log.error.length, 0);
});

test('editor: a change typed in the text editor redraws the map; an op on a topic that is gone shows an error and changes nothing', async () => {
  const dir = workspace();
  const s = activate(dir);
  const file = path.join(dir, 'maps', 'plan.km');
  const ses = await openMap(s, file);
  const we = new s.vscode.WorkspaceEdit();
  const txt = ses.document.getText();
  const i = txt.indexOf('"Website relaunch"');
  we.replace(ses.document.uri, new s.vscode.Range(ses.document.positionAt(i), ses.document.positionAt(i + 18)), '"Site relaunch"');
  await s.vscode.workspace.applyEdit(we);
  await until(() => lastModel(s).model && lastModel(s).model.root.title === 'Site relaunch', 2000);
  assert.equal(lastModel(s).model.root.title, 'Site relaunch');
  ses.panel.send({ type: 'op', op: 'delete', path: [42] });
  await until(() => s.log.error.length);
  assert.match(s.log.error[0].text, /The change was not made: That topic is no longer in the file/);
});

test('editor: a broken file shows the reason with a line number and no crash; fixing the text brings the map back', async () => {
  const dir = workspace();
  const s = activate(dir);
  const ses = await openMap(s, path.join(dir, 'maps', 'sub', 'broken.mm'));
  const m = lastModel(s);
  assert.match(m.error, /not valid XML: <node> is not closed at the end of the file|does not match/);
  assert.match(m.error, /line \d/);
  assert.equal(ses.lastRender.error, m.error);
  ses.panel.send({ type: 'op', op: 'addChild', path: [] });
  await until(() => s.log.error.length);
  assert.equal(s.log.edits.length, 0, 'no edit on a broken file');
  const we = new s.vscode.WorkspaceEdit();
  we.replace(ses.document.uri, new s.vscode.Range(ses.document.positionAt(0), ses.document.positionAt(ses.document.getText().length)), '<map version="1.0.1">\n<node TEXT="a"/>\n</map>\n');
  await s.vscode.workspace.applyEdit(we);
  await until(() => lastModel(s).model, 2000);
  assert.equal(lastModel(s).model.root.title, 'a');
});

test('editor: links open in the browser only on a click (http/https), files open in VS Code, other schemes are refused', async () => {
  const dir = workspace();
  const s = activate(dir);
  const ses = await openMap(s, path.join(dir, 'maps', 'plan.km'));
  assert.equal(s.log.external.length, 0);
  ses.panel.send({ type: 'openLink', url: 'https://example.com/style-guide' });
  await until(() => s.log.external.length);
  assert.deepEqual(s.log.external, ['https://example.com/style-guide']);
  ses.panel.send({ type: 'openLink', url: 'javascript:alert(1)' });
  await until(() => s.log.info.length);
  assert.match(s.log.info[0].text, /opens outside VS Code/);
  assert.equal(s.log.external.length, 1);
  ses.panel.send({ type: 'openLink', url: 'coffee.mm' });
  await until(() => s.log.editors.length === 2);
  assert.equal(s.log.editors[1].viewType, 'zovoMindmap.editorOption');
  ses.panel.send({ type: 'openText' });
  await until(() => s.log.commands.some((c) => c[0] === 'vscode.openWith' && c[2] === 'default'));
});

test('new mind map: picks a format, saves a starter map and opens it in the editor', async () => {
  const dir = workspace();
  const s = activate(dir);
  s.ui.quick.push((items) => items.find((i) => i.id === 'opml'));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'ideas.opml')));
  await s.vscode.commands.executeCommand('zovoMindmap.newMap');
  const text = fs.readFileSync(path.join(dir, 'ideas.opml'), 'utf8');
  const m = F.toModel(F.load(text, 'opml'));
  assert.equal(m.root.title, 'Central topic');
  assert.equal(m.count, 5);
  assert.equal(s.log.editors[0].viewType, 'zovoMindmap.editorOption');
  for (const k of ['km', 'mm']) {
    s.ui.quick.push((items) => items.find((i) => i.id === k));
    s.ui.save.push(s.vscode.Uri.file(path.join(dir, `ideas.${k}`)));
    await s.vscode.commands.executeCommand('zovoMindmap.newMap');
    assert.equal(F.toModel(F.load(fs.readFileSync(path.join(dir, `ideas.${k}`), 'utf8'), k)).count, 5);
  }
});

test('Pro export: map A as PNG (dialogs, file written, try counted); map B opens the Zovo Pro panel and writes nothing; Cancel uses no try; reload keeps it', async () => {
  const dir = workspace();
  const s = activate(dir);
  const a = s.vscode.Uri.file(path.join(dir, 'maps', 'plan.km'));
  const b = s.vscode.Uri.file(path.join(dir, 'maps', 'OVERVIEW.KM'));
  s.ui.quick.push(undefined);
  assert.equal(await s.api.tools.exportTool(a), undefined);
  assert.equal(s.api.pro.left('export'), 1, 'Escape at the first pick: no try used');
  s.ui.quick.push((i) => i.find((x) => x.id === 'png'), (i) => i.find((x) => x.id === 'transparent'), (i) => i.find((x) => x.id === 4));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'maps', 'plan.png')));
  const r = await s.api.tools.exportTool(a);
  assert.equal(r.format, 'png');
  const exp = s.log.posted.filter((m) => m.type === 'export').slice(-1)[0];
  assert.deepEqual([exp.format, exp.scope, exp.background, exp.scale], ['png', 'map', 'transparent', 4]);
  assert.ok(fs.readFileSync(path.join(dir, 'maps', 'plan.png')).equals(PNG));
  assert.equal(s.api.pro.left('export'), 0);
  assert.ok(s.log.status.some((t) => /free try of "Export picture" used/.test(t)));
  s.ui.quick.push((i) => i.find((x) => x.id === 'svg'), (i) => i[0]);
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'maps', 'overview.svg')));
  assert.equal(await s.api.tools.exportTool(b), undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'maps', 'overview.svg')));
  assert.ok(s.log.info.find((m) => /Export picture is part of Zovo Pro/.test(m.text) && m.opts.modal), JSON.stringify(s.log.info.map((m) => m.text)));
  assert.equal(s.api.pro.left('convert'), 1, 'the other tools keep their try');
  assert.equal(s.api.pro.left('tasks'), 1);
  const s2 = activate(dir, s.state);
  assert.equal(s2.api.pro.left('export'), 0);
  assert.equal(await s2.api.tools.exportTool(a), undefined, 'map A again after a reload: the panel too');
  assert.equal(s.log.external.length + s2.log.external.length, 0, 'no URL opened');
});

test('Pro export: the selected branch as PDF (a JPEG on one page) and SVG text', async () => {
  const dir = workspace();
  const s = activate(dir);
  s.state.set('zovoMindmap.proTrial', {});
  const a = path.join(dir, 'maps', 'plan.km');
  const ses = await openMap(s, a);
  ses.panel.send({ type: 'selection', path: [1], title: 'Content' });
  s.ui.quick.push((i) => i.find((x) => x.id === 'pdf'), (i) => i.find((x) => x.id === 'branch'), (i) => { assert.ok(!i.some((x) => x.id === 'transparent'), 'no transparent PDF'); return i.find((x) => x.id === 'white'); }, (i) => i.find((x) => x.id === 2));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'maps', 'plan-Content.pdf')));
  const r = await s.api.tools.exportTool(s.vscode.Uri.file(a));
  assert.equal(r.format, 'pdf');
  const exp = s.log.posted.filter((m) => m.type === 'export').slice(-1)[0];
  assert.deepEqual([exp.scope, exp.background, exp.scale], ['branch', 'white', 2]);
  const pdf = fs.readFileSync(path.join(dir, 'maps', 'plan-Content.pdf'), 'latin1');
  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.ok(pdf.includes('/DCTDecode'));
  assert.ok(pdf.includes('/MediaBox [0 0 1.13 0.75]'), 'page size = pixels / scale * 0.75');
});

test('Pro convert: file A (FreeMind) to OPML opens the result; file B opens the Zovo Pro panel; Cancel uses no try', async () => {
  const dir = workspace();
  const s = activate(dir);
  const a = s.vscode.Uri.file(path.join(dir, 'maps', 'coffee.mm'));
  s.ui.quick.push((i) => { assert.ok(!i.some((x) => x.id === 'mm'), 'not to its own format'); return i.find((x) => x.id === 'opml'); });
  s.ui.save.push(undefined);
  assert.equal(await s.api.tools.convertTool(a), undefined);
  assert.equal(s.api.pro.left('convert'), 1, 'Cancel at the save dialog: no try');
  s.ui.quick.push((i) => i.find((x) => x.id === 'opml'));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'maps', 'coffee.opml')));
  const r = await s.api.tools.convertTool(a);
  assert.equal(r.written.length, 1);
  const out = F.toModel(F.load(fs.readFileSync(path.join(dir, 'maps', 'coffee.opml'), 'utf8'), 'opml'));
  assert.equal(out.count, 109);
  assert.equal(out.root.title, 'CoffeeScad');
  assert.ok(s.log.editors.some((e) => /coffee\.opml$/.test(e.uri.fsPath)), 'the result opens in the map');
  assert.equal(s.api.pro.left('convert'), 0);
  const b = s.vscode.Uri.file(path.join(dir, 'maps', 'plan.km'));
  s.ui.quick.push((i) => i.find((x) => x.id === 'mm'));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'maps', 'plan.mm')));
  assert.equal(await s.api.tools.convertTool(b), undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'maps', 'plan.mm')));
  assert.ok(s.log.info.find((m) => /Convert maps is part of Zovo Pro/.test(m.text) && m.opts.modal));
  const s2 = activate(dir, s.state);
  assert.equal(s2.api.pro.left('convert'), 0);
});

test('Pro convert: a folder to Markdown (skip existing, broken file reported) and a Markdown outline to a map', async () => {
  const dir = workspace();
  const s = activate(dir);
  fs.writeFileSync(path.join(dir, 'maps', 'plan.md'), 'existing');
  s.ui.quick.push((i) => i.find((x) => x.id === 'md'), (i) => i.find((x) => x.id === 'skip'));
  const r = await s.api.tools.convertTool(s.vscode.Uri.file(path.join(dir, 'maps')));
  assert.deepEqual(r.written.map((u) => path.relative(dir, u.fsPath)).sort(), [path.join('maps', 'OVERVIEW.md'), path.join('maps', 'coffee.md'), path.join('maps', 'sub', 'notes.md')].sort());
  assert.equal(r.skipped.length, 1);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].why, /not valid XML/);
  assert.equal(fs.readFileSync(path.join(dir, 'maps', 'plan.md'), 'utf8'), 'existing');
  assert.match(fs.readFileSync(path.join(dir, 'maps', 'sub', 'notes.md'), 'utf8'), /^# Heading with note\n\n> First paragraph/);
  const rep = s.vscode.workspace.textDocuments.find((x) => x.languageId === 'markdown');
  assert.match(rep.getText(), /3 written, 1 skipped, 1 failed\./);
  assert.equal(s.api.pro.left('convert'), 0);
  // a fresh computer: Markdown outline to a .km map
  const s3 = activate(dir);
  s3.state.set('zovoMindmap.proTrial', {});
  s3.ui.quick.push((i) => { assert.ok(!i.some((x) => x.id === 'md')); return i.find((x) => x.id === 'km'); });
  s3.ui.save.push(s3.vscode.Uri.file(path.join(dir, 'outline.km')));
  await s3.api.tools.convertTool(s3.vscode.Uri.file(path.join(dir, 'outline.md')));
  const m = F.toModel(F.load(fs.readFileSync(path.join(dir, 'outline.km'), 'utf8'), 'km'));
  assert.equal(m.root.title, 'Trip');
  assert.equal(m.count, 4);
});

test('Pro task view: map A shows every topic (try counted after the table showed); CSV export of the filtered rows; map B opens the Zovo Pro panel', async () => {
  const dir = workspace();
  const s = activate(dir);
  const a = s.vscode.Uri.file(path.join(dir, 'maps', 'plan.km'));
  const t = await s.api.tools.tasksTool(a);
  await t.shown;
  const rowsMsg = s.log.posted.find((m) => m.type === 'rows');
  assert.equal(rowsMsg.rows.length, 25);
  assert.ok(rowsMsg.rows.some((r) => r.title === 'Clearer pricing' && r.progress === 50));
  await until(() => s.api.pro.left('tasks') === 0);
  assert.ok(s.log.status.some((x) => /free try of "Task view" used/.test(x)));
  assert.equal(t.panel.id, 'zovoMindmap.tasks');
  const html = t.panel.webview.html;
  assert.match(html, /default-src 'none'/);
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'tasks.csv')));
  t.panel.send({ type: 'save', kind: 'csv', filter: { progress: 'open' } });
  await until(() => fs.existsSync(path.join(dir, 'tasks.csv')));
  const csv = fs.readFileSync(path.join(dir, 'tasks.csv'), 'utf8');
  assert.ok(csv.startsWith('﻿Topic,Branch,Level,Priority,Progress %,Note,Link\r\n'));
  const open = rowsMsg.rows.filter((r) => r.progress !== null && r.progress < 100).length;
  assert.equal(open, 4);
  assert.equal(csv.trim().split('\r\n').length, 1 + open, 'the open topics only');
  const b = s.vscode.Uri.file(path.join(dir, 'maps', 'OVERVIEW.KM'));
  assert.equal(await s.api.tools.tasksTool(b), undefined);
  assert.ok(s.log.info.find((m) => /Task view is part of Zovo Pro/.test(m.text) && m.opts.modal));
  assert.equal(s.log.posted.filter((m) => m.type === 'rows').length, 1, 'no table for map B');
});

test('Pro tools from the toolbar and the Explorer entries reach the same tools; a licensed user never sees the panel', async () => {
  const dir = workspace();
  const s = activate(dir);
  const a = path.join(dir, 'maps', 'plan.km');
  const ses = await openMap(s, a);
  ses.panel.send({ type: 'tool', id: 'tasks' });
  await until(() => s.log.posted.some((m) => m.type === 'rows'));
  await until(() => s.api.pro.left('tasks') === 0);
  s.ui.quick.push((i) => i.find((x) => x.id === 'km'));
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'coffee-copy.km')));
  await s.vscode.commands.executeCommand('zovoMindmap.zovoPro.convert', s.vscode.Uri.file(path.join(dir, 'maps', 'coffee.mm')));
  assert.ok(fs.existsSync(path.join(dir, 'coffee-copy.km')));
  assert.equal(s.api.pro.left('convert'), 0);
});

test('Pro panel text: 1 free try per tool; proinfo config matches; reach config matches the tools', () => {
  const cfg = require('../src/license/config.js');
  assert.equal(cfg.listing, 'mindmap');
  assert.equal(cfg.pro_info.triesKey, 'zovoMindmap.proTrial');
  assert.deepEqual(cfg.pro_info.tools.map((t) => t.id), ['export', 'convert', 'tasks']);
  assert.equal(cfg.pro_info.triesMax, undefined);
  const pro = require('../src/pro');
  assert.equal(pro.TRIAL_USES, 1);
  assert.equal(pro.TRIAL_KEY, cfg.pro_info.triesKey);
  assert.deepEqual(cfg.pro_info.tools.map((t) => t.title), Object.values(pro.FEATURES).map((f) => f.title));
  const rc = require('../src/reach-config');
  assert.deepEqual(rc.tools.map((t) => t.id), Object.keys(pro.FEATURES));
  assert.equal(rc.triesKey, pro.TRIAL_KEY);
});

test('license module and rating module are byte-identical to the factory copies', () => {
  const S = path.join(ROOT, '..', '..', 'sprint');
  if (!fs.existsSync(S)) return;
  for (const f of ['index.js', 'license.js', 'sponsors.js', 'gumroad.js', 'proinfo.js', 'reach1.js']) assert.ok(fs.readFileSync(path.join(ROOT, 'src', 'license', f)).equals(fs.readFileSync(path.join(S, 'license', f))), f);
  assert.ok(fs.readFileSync(path.join(ROOT, 'src', 'rate.js')).equals(fs.readFileSync(path.join(S, 'rating', 'rate.js'))));
});

test('webview pages: CSP default-src none, no eval, no inline script without nonce, no remote origins; titles escaped', () => {
  for (const html of [
    editorHtml({ cspSource: 'vscode-resource:', layoutUri: 'l.js', scriptUri: 'm.js', styleUri: 's.css', title: 'a<b>.km' }),
    tasksHtml({ cspSource: 'vscode-resource:', scriptUri: 't.js', styleUri: 's.css', title: 'a<b>.km' }),
  ]) {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
    assert.match(csp, /^default-src 'none'/);
    assert.ok(!/connect-src|https?:|unsafe-eval|unsafe-inline|wasm/.test(csp), csp);
    assert.ok(!/<script(?![^>]*nonce=)/.test(html));
    assert.ok(html.includes('a&lt;b&gt;.km'));
  }
  for (const f of ['map.js', 'tasks.js', 'layout.js']) {
    const js = fs.readFileSync(path.join(ROOT, 'media', f), 'utf8');
    assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|new Worker|eval\(|new Function|import\(/.test(js), f);
    assert.ok(!/style="/.test(js), `${f}: no inline style attributes (the CSP blocks them)`);
  }
});

test('no network or process code in the shipped extension code', () => {
  const files = ['extension.js', 'editor.js', 'tools.js', 'html.js', 'pro.js', 'reach.js', 'reach-config.js', 'core/xmldoc.js', 'core/formats.js', 'core/convert.js'];
  for (const f of files) {
    const t = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    assert.ok(!/require\(['"](https?|net|tls|dgram|child_process|http2)['"]\)|fetch\(|WebSocket/.test(t), f);
  }
});

test('README, CHANGELOG and walkthrough: screenshot path, the Pro line, no rival names, cross-sell ids exist', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('](images/screenshot.png)'));
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'screenshot.png')), 'the screenshot is in the source tree');
  assert.match(readme, /Zovo Pro: USD 19 once/);
  assert.match(readme, /Made by Zovo/);
  const all = [readme, fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), ...fs.readdirSync(path.join(ROOT, 'walkthrough')).map((f) => fs.readFileSync(path.join(ROOT, 'walkthrough', f), 'utf8')), JSON.stringify(pkg)].join('\n');
  assert.ok(!/markmap|souche|mind-elixir|xmind (?:zen|pro)|baidu|naotu|百度|simplemind|mindnode|mindmeister|coggle|miro/i.test(all), 'no rival names');
  const prods = path.join(ROOT, '..');
  const ids = new Set();
  if (fs.existsSync(prods)) for (const d of fs.readdirSync(prods)) { try { const p = JSON.parse(fs.readFileSync(path.join(prods, d, 'package.json'), 'utf8')); ids.add(`${p.publisher}.${p.name}`); } catch (e) { /* not a product */ } }
  const steps = pkg.contributes.walkthroughs[0].steps;
  const links = steps.flatMap((st) => [...st.description.matchAll(/extension\.open\?%5B%22([^%]+)%22%5D/g)].map((m) => m[1]));
  assert.deepEqual(links, ['zovo.xmind-mind-map-viewer', 'zovo.zovo-markdown-editor', 'zovo.mermaid-viewer']);
  if (ids.size) for (const l of links) assert.ok(ids.has(l), l);
});
