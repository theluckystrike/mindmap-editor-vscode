'use strict';
// Mindmap Editor: KM, MM & OPML by Zovo. A custom text editor that shows .km files (by default) and FreeMind .mm and
// OPML files (through "Open With" or the Explorer menu) as a mind map you edit with the keyboard and the mouse. Every
// change is a normal text edit of the file. No telemetry, no network. Activation shows nothing: no message, no popup.
const vscode = require('vscode');
const path = require('path');
const { MapEditorProvider, VIEW_TYPE, viewTypeFor } = require('./editor');
const { createTools, MAP_RE } = require('./tools');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createReach } = require('./reach');
const reachConfig = require('./reach-config');
const convert = require('./core/convert');

const PREFIX = 'zovoMindmap';
const EXT_ID = 'zovo.zovo-mindmap-editor';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

const STARTER = () => {
  const t = convert.topic('Central topic');
  const a = convert.topic('First idea'); a.kids.push(convert.topic('A detail'));
  const b = convert.topic('Second idea');
  const c = convert.topic('Questions'); c.note = 'Press Tab to add a child topic, Enter for a sibling, F2 to rename.';
  t.kids.push(a, b, c);
  return t;
};

function activate(context) {
  const sub = (d) => context.subscriptions.push(d);
  let rating = { success() {}, failure() {} };
  try { rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'Mindmap Editor' }); } catch (e) { /* rating is optional */ }
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  const pro = createPro({ vscode, context });
  const reach = createReach({ vscode, ...reachConfig, context, licensed: () => !!pro.licensed, shown: () => setting('showProTools', true) !== false });
  reach.registerCtx();
  sub(pro.onDidChange(() => reach.refresh()));

  const samples = vscode.Uri.joinPath(context.extensionUri, 'samples').fsPath;
  let tools = null;
  const editor = MapEditorProvider.register(context, {
    rating, reach,
    isSample: (uri) => uri.fsPath.startsWith(samples),
    onTool: (id, uri) => {
      const cmd = { export: `${PREFIX}.exportPicture`, convert: `${PREFIX}.convert`, tasks: `${PREFIX}.taskView` }[id];
      if (cmd) vscode.commands.executeCommand(cmd, uri);
    },
  });
  tools = createTools({ context, pro, editor });

  const reg = (id, fn) => sub(vscode.commands.registerCommand(id, async (...a) => {
    try { return await fn(...a); } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); return undefined; }
  }));

  reg(`${PREFIX}.openWith`, async (arg) => {
    let uri = arg && arg.scheme ? arg : null;
    if (!uri) { const ed = vscode.window.activeTextEditor; if (ed && MAP_RE.test(ed.document.uri.path)) uri = ed.document.uri; }
    if (!uri) {
      // a file VS Code shows as binary has no text editor: take the active tab's file
      const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab;
      const u = tab && tab.input && tab.input.uri;
      if (u && MAP_RE.test(u.path)) uri = u;
    }
    if (!uri) { vscode.window.showInformationMessage('Open a .km, .mm or .opml file first, or right-click one in the Explorer.'); return undefined; }
    return vscode.commands.executeCommand('vscode.openWith', uri, viewTypeFor(uri));
  });
  reg(`${PREFIX}.openAsText`, async (arg) => {
    const s = editor.sessionFor(arg && arg.scheme ? arg : null);
    const uri = arg && arg.scheme ? arg : s ? s.document.uri : null;
    if (uri) return vscode.commands.executeCommand('vscode.openWith', uri, 'default', { viewColumn: vscode.ViewColumn.Beside, preview: false });
    return undefined;
  });
  reg(`${PREFIX}.newMap`, async () => {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const kind = await vscode.window.showQuickPick([
      { label: 'KityMinder map (.km)', id: 'km' },
      { label: 'FreeMind map (.mm)', id: 'mm' },
      { label: 'OPML outline (.opml)', id: 'opml' },
    ], { title: 'New mind map: file format', ignoreFocusOut: true });
    if (!kind) return undefined;
    const base = folder ? folder.uri.fsPath : require('os').homedir();
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(base, `mindmap.${kind.id}`)), filters: { [kind.label]: [kind.id] }, title: 'Save the new mind map' });
    if (!target) return undefined;
    await vscode.workspace.fs.writeFile(target, Buffer.from(convert.write(STARTER(), kind.id, 'Central topic'), 'utf8'));
    await vscode.commands.executeCommand('vscode.openWith', target, viewTypeFor(target), { preview: false });
    return target;
  });
  reg(`${PREFIX}.openSample`, async () => {
    const uri = vscode.Uri.joinPath(context.extensionUri, 'samples', 'project-plan.km');
    return vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { preview: false });
  });
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${PREFIX}.start`, false));
  reg(`${PREFIX}.exportPicture`, reach.wrap((arg) => tools.exportTool(arg && arg.scheme ? arg : undefined)));
  reg(`${PREFIX}.convert`, reach.wrap((arg, uris) => tools.convertTool(arg && arg.scheme ? arg : undefined, uris)));
  reg(`${PREFIX}.taskView`, reach.wrap((arg) => tools.tasksTool(arg && arg.scheme ? arg : undefined)));

  sub(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${PREFIX}.showProTools`)) { reach.refresh(); editor.refreshPro(); }
    if (e.affectsConfiguration(`${PREFIX}.showSupportLinks`)) editor.reloadAll();
  }));
  sub(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  return { editor, tools, pro, reach, VIEW_TYPE };
}

function deactivate() {}

module.exports = { activate, deactivate };
