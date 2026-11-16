'use strict';
// Zovo Pro for Mindmap Editor: KM, MM & OPML, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license by apply.sh; pro.js copied from the MDX Preview listing). Three Pro tools, 1 free try each on
// this computer (owner decision 15 Nov: TRIAL_USES = 1). The count is per tool, not per file: one use on any map or
// folder uses that tool's try. A try counts only after the tool showed its result (picture or converted files written,
// task table shown); Escape, Cancel or an error never uses one.
// Nothing about Pro shows on open or activation: the panel appears only after a click on a Pro tool with no tries left.
const { createLicense } = require('./license');
const { currentSurface } = require('./reach');

const SKU = 'mindmap-editor-pro';
const TRIAL_USES = 1;
const TRIAL_KEY = 'zovoMindmap.proTrial';

const FEATURES = {
  export: {
    title: 'Export picture',
    detail: 'Saves the whole map or the selected branch as a PNG (up to 4x poster size), SVG or PDF picture, with the VS Code theme colors, white or a transparent background.',
  },
  convert: {
    title: 'Convert maps',
    detail: 'Converts a map between KityMinder .km, FreeMind .mm, OPML and a Markdown heading and list outline, or every map in a folder at once, keeping titles, notes, links, priority and progress.',
  },
  tasks: {
    title: 'Task view',
    detail: 'Lists every topic with its priority, progress, note and link as a table you can filter, and saves the rows as CSV or Markdown.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function surfaceOf(arg) {
  const s = currentSurface();
  if (s) return s;
  if (arg && typeof arg === 'object' && typeof arg.surface === 'string') return arg.surface;
  return undefined;
}

function createPro({ vscode, context, license, prefix = 'zovoMindmap', productName = 'Mindmap Editor: KM, MM & OPML' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  // Counts never go down in a session: globalState can hand back an older value for a moment after a write, so the
  // highest count seen here wins.
  const seen = {};
  const used = (f) => Math.max(Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0, seen[f] || 0);
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one panel. */
  async function allowed(f, arg) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    const surface = surfaceOf(arg);
    return !!(await lic.requirePro(feat.title, { detail: feat.detail, toolId: f, triesUsed: used(f), tools: TOOLS, ...(surface ? { surface } : {}) }));
  }

  /** After the tool showed its result: counts one free try (nothing when licensed). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    for (const k of Object.keys(seen)) m[k] = Math.max(Number(m[k]) || 0, seen[k]);
    m[f] = used(f) + 1;
    seen[f] = m[f];
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try of "${FEATURES[f].title}" used on this computer${l ? `, ${l} left` : ''}.`, 8000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left, used,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS, surfaceOf };
