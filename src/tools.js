'use strict';
// The three Zovo Pro tools: Export picture (PNG, SVG, PDF), Convert maps (KM, MM, OPML, Markdown; one file or a
// folder) and Task view (a table of every topic, CSV and Markdown export). Each checks src/pro.js before it starts and
// counts its free try only after the result exists (file written or table shown). Cancel or an error uses no try.
const vscode = require('vscode');
const path = require('path');
const formats = require('./core/formats');
const convert = require('./core/convert');
const { tasksHtml } = require('./html');
const { viewTypeFor } = require('./editor');

const MAP_RE = /\.(km|mm|opml)$/i;
const MD_RE = /\.(md|markdown)$/i;
const MAX_FOLDER_FILES = 500;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'out', 'dist', '.vscode-test']);

const pick = (items, o) => vscode.window.showQuickPick(items, { ignoreFocusOut: true, ...o });
const isUri = (a) => !!(a && typeof a === 'object' && a.scheme && a.path !== undefined);

function createTools({ context, pro, editor }) {
  /** The text of a file: the open document (also unsaved changes) or the file on disk. */
  async function readText(uri) {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  }
  /** Topic tree of a map or Markdown file; throws MapError with a clear message on a broken file. */
  async function treeOf(uri) {
    const text = await readText(uri);
    const name = path.basename(uri.path);
    if (MD_RE.test(name)) return convert.fromMarkdown(text, name.replace(/\.[^.]+$/, ''));
    const fmt = formats.formatOf(name);
    if (!fmt) throw new formats.MapError(`${name} is not a .km, .mm, .opml or Markdown file.`);
    const d = formats.load(text, fmt);
    const m = formats.toModel(d);
    if (fmt === 'opml' && m.root.virtual && d.title) m.root.title = d.title;
    return m.root;
  }
  const targetMap = (arg) => {
    if (isUri(arg)) return arg;
    const s = editor.sessionFor(null);
    if (s) return s.document.uri;
    const ed = vscode.window.activeTextEditor;
    if (ed && (MAP_RE.test(ed.document.uri.path))) return ed.document.uri;
    return null;
  };
  const exists = async (uri) => { try { await vscode.workspace.fs.stat(uri); return true; } catch (e) { return false; } };
  const swapExt = (uri, ext) => vscode.Uri.file(uri.fsPath.replace(/\.[^./\\]+$/, '') + ext);

  // ---------------------------------------------------------------- 1. Export picture
  async function exportTool(arg) {
    const uri = targetMap(arg);
    if (!uri || !MAP_RE.test(uri.path)) { vscode.window.showInformationMessage('Open a .km, .mm or .opml mind map first, then export it as a picture.'); return undefined; }
    if (!(await pro.allowed('export', arg))) return undefined;
    const s = editor.sessionFor(uri) || (await editor.open(uri));
    if (!s) return undefined;
    await Promise.race([s.rendered, new Promise((r) => setTimeout(r, 15000))]);
    if (s.error || !s.model) { vscode.window.showErrorMessage(`This map cannot be exported: ${s.error || 'it is not drawn yet.'}`); return undefined; }
    const fmt = await pick([
      { label: 'PNG picture', description: 'sharp at 2x, or 4x poster size', id: 'png' },
      { label: 'SVG picture', description: 'vector, any size', id: 'svg' },
      { label: 'PDF document', description: 'one page the size of the map', id: 'pdf' },
    ], { title: 'Export picture (Zovo Pro): format' });
    if (!fmt) return undefined;
    let scope = 'map';
    const sel = s.selected;
    if (sel && sel.path && sel.path.length) {
      const sc = await pick([
        { label: 'Whole map', id: 'map' },
        { label: 'Selected branch', description: sel.title.slice(0, 60), id: 'branch' },
      ], { title: 'Export picture: what to export' });
      if (!sc) return undefined;
      scope = sc.id;
    }
    const bgItems = [{ label: 'VS Code theme colors', id: 'theme' }, { label: 'White background', id: 'white' }];
    if (fmt.id !== 'pdf') bgItems.splice(1, 0, { label: 'Transparent background', description: 'theme colors, no background', id: 'transparent' });
    const bg = await pick(bgItems, { title: 'Export picture: background' });
    if (!bg) return undefined;
    let scale = 1;
    if (fmt.id !== 'svg') {
      const sz = await pick([{ label: '2x', description: 'sharp on high-density screens', id: 2 }, { label: '1x', description: 'screen size', id: 1 }, { label: '4x poster', description: 'for printing large', id: 4 }], { title: 'Export picture: size' });
      if (!sz) return undefined;
      scale = sz.id;
    }
    const base = uri.fsPath.replace(/\.[^./\\]+$/, '') + (scope === 'branch' ? '-' + (sel.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'branch') : '');
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${base}.${fmt.id}`), filters: { [fmt.label]: [fmt.id] }, title: 'Save the picture' });
    if (!target) return undefined;
    const r = await s.exportPicture({ format: fmt.id, scope, background: bg.id, scale });
    let bytes = Buffer.from(r.data, 'base64');
    if (fmt.id === 'pdf') {
      const size = convert.jpegSize(bytes) || { w: r.w, h: r.h };
      bytes = convert.pdfFromJpeg(bytes, size.w, size.h, r.scale || 1);
    }
    await vscode.workspace.fs.writeFile(target, bytes);
    await pro.produced('export');
    vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}: ${r.count} topics, ${r.w} x ${r.h}${fmt.id === 'svg' ? '' : ' px'}.`);
    return { target, format: fmt.id, bytes: bytes.length, w: r.w, h: r.h, count: r.count };
  }

  // ---------------------------------------------------------------- 2. Convert
  async function listFolder(dir) {
    const out = [];
    const st = [dir];
    while (st.length && out.length < MAX_FOLDER_FILES) {
      const d = st.pop();
      let entries = [];
      try { entries = await vscode.workspace.fs.readDirectory(d); } catch (e) { continue; }
      entries.sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, type] of entries) {
        const u = vscode.Uri.joinPath(d, name);
        if (type === vscode.FileType.Directory) { if (!SKIP_DIRS.has(name) && !name.startsWith('.')) st.push(u); } else if (MAP_RE.test(name) && out.length < MAX_FOLDER_FILES) out.push(u);
      }
    }
    return out;
  }

  async function convertTool(arg, uris) {
    let src = isUri(arg) ? arg : targetMap(arg);
    if (Array.isArray(uris) && uris.length > 1) src = uris[0];
    if (!src) {
      const f = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: false, filters: { 'Mind maps and outlines': ['km', 'mm', 'opml', 'md', 'markdown'] }, title: 'Convert mind maps: pick a file or a folder' });
      if (!f || !f[0]) return undefined;
      src = f[0];
    }
    let isDir = false;
    try { isDir = (await vscode.workspace.fs.stat(src)).type === vscode.FileType.Directory; } catch (e) { vscode.window.showErrorMessage(`Not found: ${src.fsPath}`); return undefined; }
    if (!isDir && !MAP_RE.test(src.path) && !MD_RE.test(src.path)) { vscode.window.showInformationMessage('Pick a .km, .mm, .opml or Markdown file, or a folder of mind maps.'); return undefined; }
    if (!(await pro.allowed('convert', arg))) return undefined;
    const fromFmt = isDir ? '' : (MD_RE.test(src.path) ? 'md' : formats.formatOf(src.path));
    const items = Object.entries(convert.KINDS).filter(([k]) => k !== fromFmt).map(([k, v]) => ({ label: v.label, id: k }));
    const to = await pick(items, { title: isDir ? `Convert every map in ${path.basename(src.fsPath)} to` : `Convert ${path.basename(src.fsPath)} to` });
    if (!to) return undefined;
    const ext = convert.KINDS[to.id].ext;

    if (!isDir) {
      let tree;
      try { tree = await treeOf(src); } catch (e) { vscode.window.showErrorMessage(`${path.basename(src.fsPath)} could not be converted: ${e.message}`); return undefined; }
      const target = await vscode.window.showSaveDialog({ defaultUri: swapExt(src, ext), filters: { [to.label]: [ext.slice(1)] }, title: 'Save the converted file' });
      if (!target) return undefined;
      const text = convert.write(tree, to.id, tree.title);
      await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
      await pro.produced('convert');
      if (to.id === 'md') await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { viewColumn: vscode.ViewColumn.Beside, preview: false });
      else await vscode.commands.executeCommand('vscode.openWith', target, viewTypeFor(target), { viewColumn: vscode.ViewColumn.Beside, preview: false });
      return { written: [target], skipped: [], failed: [] };
    }

    const files = (await listFolder(src)).filter((u) => formats.formatOf(u.path) !== to.id);
    if (!files.length) { vscode.window.showInformationMessage(`No .km, .mm or .opml files to convert in ${path.basename(src.fsPath)}.`); return undefined; }
    const clash = [];
    for (const f of files) if (await exists(swapExt(f, ext))) clash.push(f);
    let replace = false;
    if (clash.length) {
      const c = await pick([
        { label: 'Skip files that exist', description: `${clash.length} of ${files.length} have a ${ext} file already`, id: 'skip' },
        { label: 'Replace them', id: 'replace' },
      ], { title: `Convert ${files.length} files: some outputs exist` });
      if (!c) return undefined;
      replace = c.id === 'replace';
    }
    const written = [], skipped = [], failed = [];
    const seen = new Set();
    for (const f of files) {
      const target = swapExt(f, ext);
      // two sources with one base name (a.km and a.mm): the first wins, the second is reported
      if (seen.has(target.fsPath)) { skipped.push({ uri: f, why: `another file already wrote ${path.basename(target.fsPath)}` }); continue; }
      seen.add(target.fsPath);
      if (!replace && clash.includes(f)) { skipped.push({ uri: f, why: 'output exists' }); continue; }
      try {
        const tree = await treeOf(f);
        await vscode.workspace.fs.writeFile(target, Buffer.from(convert.write(tree, to.id, tree.title), 'utf8'));
        written.push(target);
      } catch (e) { failed.push({ uri: f, why: e.message }); }
    }
    if (written.length) await pro.produced('convert');
    const rel = (u) => path.relative(src.fsPath, u.fsPath);
    const lines = [`# Converted to ${to.label}`, '', `Folder: ${src.fsPath}`, '', `${written.length} written, ${skipped.length} skipped, ${failed.length} failed.`, ''];
    if (written.length) lines.push('## Written', '', ...written.map((u) => `- ${rel(u)}`), '');
    if (skipped.length) lines.push('## Skipped', '', ...skipped.map((x) => `- ${rel(x.uri)}: ${x.why}`), '');
    if (failed.length) lines.push('## Not converted', '', ...failed.map((x) => `- ${rel(x.uri)}: ${x.why}`), '');
    const report = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.join('\n') });
    await vscode.window.showTextDocument(report, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    return { written, skipped, failed };
  }

  // ---------------------------------------------------------------- 3. Task view
  const taskPanels = new Map();
  async function tasksTool(arg) {
    const uri = targetMap(arg);
    if (!uri || !MAP_RE.test(uri.path)) { vscode.window.showInformationMessage('Open a .km, .mm or .opml mind map first, then open its task view.'); return undefined; }
    let tree;
    try { tree = await treeOf(uri); } catch (e) { vscode.window.showErrorMessage(`The task view needs a map that reads: ${e.message}`); return undefined; }
    const existing = taskPanels.get(uri.toString());
    if (existing) { existing.panel.reveal(undefined, false); return existing; }
    if (!(await pro.allowed('tasks', arg))) return undefined;
    const name = path.basename(uri.fsPath);
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('zovoMindmap.tasks', `Tasks: ${name}`, vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true });
    const wv = panel.webview;
    wv.html = tasksHtml({ cspSource: wv.cspSource, styleUri: wv.asWebviewUri(vscode.Uri.joinPath(media, 'map.css')).toString(), scriptUri: wv.asWebviewUri(vscode.Uri.joinPath(media, 'tasks.js')).toString(), title: `Tasks: ${name}` });
    const t = { panel, uri, rows: convert.taskRows(tree), counted: false, shown: null };
    let shownResolve;
    t.shown = new Promise((r) => { shownResolve = r; });
    taskPanels.set(uri.toString(), t);
    const send = () => { try { wv.postMessage({ type: 'rows', rows: t.rows, title: name }); } catch (e) { /* closed */ } };
    const subs = [];
    subs.push(wv.onDidReceiveMessage(async (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') send();
      else if (m.type === 'shown') {
        if (!t.counted) { t.counted = true; await pro.produced('tasks'); }
        shownResolve(m);
      } else if (m.type === 'save') {
        const rows = convert.filterRows(t.rows, m.filter || {});
        const kind = m.kind === 'md' ? 'md' : 'csv';
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(uri.fsPath.replace(/\.[^./\\]+$/, '') + `-tasks.${kind}`), filters: kind === 'md' ? { Markdown: ['md'] } : { CSV: ['csv'] }, title: 'Save the task table' });
        if (!target) return;
        const text = kind === 'md' ? convert.rowsMarkdown(rows, name) : '﻿' + convert.rowsCsv(rows);
        await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
        vscode.window.showInformationMessage(`Saved ${rows.length} rows to ${path.basename(target.fsPath)}.`);
      } else if (m.type === 'reveal') {
        const s = editor.sessionFor(uri) || (await editor.open(uri, vscode.ViewColumn.One));
        if (s) { if (s.panel.reveal) s.panel.reveal(undefined, true); s.post({ type: 'select', path: m.path }); }
      }
    }));
    subs.push(vscode.workspace.onDidChangeTextDocument(async (e) => {
      if (e.document.uri.toString() !== uri.toString() || !e.contentChanges.length) return;
      try { t.rows = convert.taskRows(await treeOf(uri)); send(); } catch (err) { /* broken while typing: keep the last rows */ }
    }));
    panel.onDidDispose(() => { taskPanels.delete(uri.toString()); for (const d of subs) d.dispose(); });
    return t;
  }

  return { exportTool, convertTool, tasksTool, treeOf, listFolder, taskPanels };
}

module.exports = { createTools, MAP_RE, MD_RE };
