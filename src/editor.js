'use strict';
// MapEditorProvider: a custom text editor for .km (default) and .mm / .opml (on request, "Open With"). The file stays a
// normal VS Code text document: each edit in the map is one WorkspaceEdit on the document text, so undo, redo, save,
// hot exit, the dirty dot and git work as for any text file. Only the changed part of the text is replaced
// (src/core/formats.js keeps every other byte). A file that is only opened is never written.
const vscode = require('vscode');
const path = require('path');
const formats = require('./core/formats');
const { editorHtml } = require('./html');
const support = require('./support');

const VIEW_TYPE = 'zovoMindmap.editor'; // .km, priority default
const VIEW_TYPE_OPTION = 'zovoMindmap.editorOption'; // .mm and .opml, priority option (Open With)
/** The view type for a file: .km opens with the default one, .mm and .opml with the option one. */
const viewTypeFor = (uri) => (/\.km$/i.test(uri.path) ? VIEW_TYPE : VIEW_TYPE_OPTION);
const PREFIX = 'zovoMindmap';
const MAX_BYTES = 20 * 1024 * 1024;

const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

class MapEditorProvider {
  constructor(ctx, hooks) {
    this.ctx = ctx;
    this.hooks = hooks || {}; // { rating, reach, isSample(uri), onTool(id, uri) }
    this.sessions = new Map();
    this.lastActive = null;
  }

  static register(ctx, hooks) {
    const p = new MapEditorProvider(ctx, hooks);
    for (const vt of [VIEW_TYPE, VIEW_TYPE_OPTION]) ctx.subscriptions.push(vscode.window.registerCustomEditorProvider(vt, p, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
    return p;
  }

  html(webview, title) {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    const u = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
    const reach = this.hooks.reach;
    return editorHtml({
      cspSource: webview.cspSource, layoutUri: u('layout.js'), scriptUri: u('map.js'), styleUri: u('map.css'), title: title || 'Mind map',
      showSupportLinks: support.showLinks(vscode, PREFIX), showPro: setting('showProTools', true) !== false,
      head: reach ? (n) => reach.headHtml(n) : undefined,
    });
  }

  async resolveCustomTextEditor(document, panel) {
    const key = document.uri.toString();
    const fmt = formats.formatOf(document.uri.path);
    const fsReadOnly = (() => { try { return vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) === false; } catch (e) { return false; } })();
    const s = {
      document, panel, fmt, gen: 0, queue: Promise.resolve(), counted: false, timer: null, lastWritten: null, select: null, edit: false,
      readOnly: fsReadOnly || ['git', 'gitlens', 'vscode-scm'].includes(document.uri.scheme), selected: null, exports: new Map(), seq: 0,
      ready: null, readyResolve: null, rendered: null, renderedResolve: null, lastRender: null, error: '',
    };
    s.ready = new Promise((r) => { s.readyResolve = r; });
    s.rendered = new Promise((r) => { s.renderedResolve = r; });
    this.sessions.set(key, s);
    this.lastActive = s;
    const wv = panel.webview;
    const reach = this.hooks.reach;
    wv.options = { enableScripts: true, enableCommandUris: [...new Set([...support.commandUris(PREFIX), ...(reach ? reach.commandIds() : [])])], localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] };
    wv.html = this.html(wv, path.basename(document.uri.path));
    const subs = [];
    if (reach) subs.push(reach.attach(wv, panel));
    const post = (m) => { try { const p = wv.postMessage(m); return p && p.then ? p.then(undefined, () => false) : Promise.resolve(p); } catch (e) { return Promise.resolve(false); } };
    s.post = post;
    s.load = () => {
      s.gen++;
      const text = document.getText();
      let msg;
      try {
        if (text.length > MAX_BYTES) throw new formats.MapError(`This file is larger than ${MAX_BYTES / 1024 / 1024} MB, too large to draw as a map. Open it as text instead.`);
        const doc = formats.load(text, fmt);
        s.model = formats.toModel(doc);
        s.error = '';
        msg = { type: 'model', gen: s.gen, fmt, model: s.model, readOnly: s.readOnly, select: s.select, edit: s.edit };
      } catch (e) {
        s.model = null;
        s.error = e instanceof formats.MapError ? e.message + (e.line && !/\bline \d/.test(e.message) ? ` (line ${e.line})` : '') : `This file could not be read: ${String((e && e.message) || e)}`;
        msg = { type: 'model', gen: s.gen, fmt, error: s.error, readOnly: s.readOnly };
      }
      s.select = null; s.edit = false;
      return post(msg);
    };
    s.exportPicture = (opts) => new Promise((resolve, reject) => {
      const id = ++s.seq;
      const t = setTimeout(() => { s.exports.delete(id); reject(new Error('The map did not answer in time. Try again.')); }, 60000);
      s.exports.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      post({ type: 'export', id, ...opts });
    });

    subs.push(wv.onDidReceiveMessage((m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      switch (m.type) {
        case 'ready': s.load(); s.readyResolve(); break;
        case 'rendered':
          s.lastRender = m;
          if (!s.counted && m.gen === s.gen) {
            s.counted = true;
            if (m.error) { if (this.hooks.rating) this.hooks.rating.failure(); }
            else if (this.hooks.rating && !(this.hooks.isSample && this.hooks.isSample(document.uri))) this.hooks.rating.success(document.uri);
          }
          s.renderedResolve(m);
          break;
        case 'op':
          s.queue = s.queue.then(() => this.onOps(s, [m])).catch((e) => vscode.window.showErrorMessage(`The change was not made: ${String((e && e.message) || e).split('\n')[0]}`));
          break;
        case 'reveal': {
          const p = Array.isArray(m.path) ? m.path.map(Number) : [];
          const ops = [];
          for (let i = 0; i < p.length; i++) ops.push({ op: 'fold', path: p.slice(0, i), folded: false });
          s.queue = s.queue.then(() => this.onOps(s, ops, p)).catch(() => undefined);
          break;
        }
        case 'selection': s.selected = m.path ? { path: m.path, title: String(m.title || '') } : null; break;
        case 'exported': {
          const w = s.exports.get(m.id);
          if (!w) break;
          s.exports.delete(m.id);
          if (m.ok) w.resolve(m); else w.reject(new Error(m.error || 'The picture could not be made.'));
          break;
        }
        case 'openText': vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', { viewColumn: vscode.ViewColumn.Beside, preview: false }); break;
        case 'openLink': this.openLink(document.uri, String(m.url || '')); break;
        case 'undo': case 'redo': vscode.commands.executeCommand(m.type); break;
        case 'tool': if (this.hooks.onTool) this.hooks.onTool(String(m.id), document.uri); break;
        default: break;
      }
    }));
    subs.push(vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== document || !e.contentChanges.length) return;
      clearTimeout(s.timer);
      // our own edit redraws at once; a change from the text editor waits for typing to pause
      const own = document.getText() === s.lastWritten;
      s.timer = setTimeout(() => s.load(), own ? 0 : 250);
    }));
    if (panel.onDidChangeViewState) subs.push(panel.onDidChangeViewState(() => { if (panel.active) this.lastActive = s; }));
    panel.onDidDispose(() => {
      clearTimeout(s.timer);
      for (const d of subs) { try { d.dispose(); } catch (e) { /* gone */ } }
      for (const w of s.exports.values()) w.reject(new Error('The map was closed.'));
      if (this.sessions.get(key) === s) this.sessions.delete(key);
      if (this.lastActive === s) this.lastActive = null;
    });
  }

  /** Applies edits from the map to the document text as one WorkspaceEdit (one undo step). */
  async onOps(s, ops, selectAfter) {
    if (s.readOnly) return false;
    const text = s.document.getText();
    const doc = formats.load(text, s.fmt);
    let res = null, changed = false;
    for (const o of ops) {
      const r = formats.applyOp(doc, o);
      changed = changed || r.changed;
      res = r;
    }
    const select = selectAfter || (res ? res.select : null);
    if (!changed) {
      if (select) s.post({ type: 'select', path: select });
      return false;
    }
    const next = formats.save(doc);
    if (next === text) return false;
    const we = new vscode.WorkspaceEdit();
    for (const e of formats.textEdits(text, next)) we.replace(s.document.uri, new vscode.Range(s.document.positionAt(e.start), s.document.positionAt(e.end)), e.text);
    s.lastWritten = next;
    s.select = select;
    s.edit = !!(res && res.edit);
    const ok = await vscode.workspace.applyEdit(we);
    if (!ok) { s.lastWritten = null; s.select = null; s.edit = false; throw new Error('VS Code did not accept the edit'); }
    return true;
  }

  async openLink(docUri, url) {
    if (!url) return;
    if (/^(https?|mailto):/i.test(url)) { await vscode.env.openExternal(vscode.Uri.parse(url)); return; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:/i.test(url)) { vscode.window.showInformationMessage(`This link opens outside VS Code: ${url}`); return; }
    const p = /^file:/i.test(url) ? vscode.Uri.parse(url).fsPath : path.resolve(path.dirname(docUri.fsPath), decodeURIComponent(url.split('#')[0]));
    const target = vscode.Uri.file(p);
    try { await vscode.workspace.fs.stat(target); } catch (e) { vscode.window.showWarningMessage(`The linked file was not found: ${p}`); return; }
    const f = formats.formatOf(p);
    await vscode.commands.executeCommand('vscode.openWith', target, f ? viewTypeFor(target) : 'default');
  }

  /** The session of a document, or the last active map. */
  sessionFor(uri) { return uri ? this.sessions.get(uri.toString()) || null : this.lastActive; }

  /** Opens a map file in this editor and waits until it was drawn. */
  async open(uri, column) {
    let s = this.sessions.get(uri.toString());
    if (!s) {
      await vscode.commands.executeCommand('vscode.openWith', uri, viewTypeFor(uri), { viewColumn: column || vscode.ViewColumn.Active, preview: false });
      s = this.sessions.get(uri.toString());
    } else if (s.panel.reveal) s.panel.reveal(undefined, false);
    if (!s) return null;
    await Promise.race([s.rendered, new Promise((r) => setTimeout(r, 15000))]);
    return s;
  }

  refreshPro() {
    const show = setting('showProTools', true) !== false;
    for (const s of this.sessions.values()) s.post({ type: 'showPro', show });
  }
  reloadAll() { for (const s of this.sessions.values()) { s.panel.webview.html = this.html(s.panel.webview, path.basename(s.document.uri.path)); } }
}

module.exports = { MapEditorProvider, VIEW_TYPE, VIEW_TYPE_OPTION, viewTypeFor };
