'use strict';
// Webview HTML for the mind map editor. No vscode import, so tests can check the CSP: default-src 'none', no remote
// origin, no connect-src, no 'unsafe-eval' and no 'unsafe-inline' for scripts: scripts only with the page nonce
// (media/layout.js, media/map.js), pictures only from the extension (cspSource), data: and blob: URIs (the PNG and PDF
// export draws the map's SVG on a canvas through a blob: URL).
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

const PREFIX = 'zovoMindmap';
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function csp(cspSource, n) {
  return ["default-src 'none'", `style-src ${cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`, `img-src ${cspSource} data: blob:`, `font-src ${cspSource}`].join('; ');
}

const PRIORITY_OPTIONS = ['<option value="0">None</option>', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((p) => `<option value="${p}">${p}</option>`)].join('');
const PROGRESS_OPTIONS = '<option value="0">None</option><option value="1">0 % (not started)</option><option value="3">25 %</option><option value="5">50 %</option><option value="7">75 %</option><option value="9">100 % (done)</option>';

/** p: { cspSource, layoutUri, scriptUri, styleUri, title, showSupportLinks, showPro, head?(nonce), nonce? } */
function editorHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>
</head>
<body>
<div id="toolbar" role="toolbar" aria-label="Mind map">
  <span class="file" id="file" title="${attr(p.title)}">${attr(p.title)}</span>
  <label class="lbl" for="layout">Layout</label>
  <select id="layout" title="How the map is laid out on screen (the file is not changed)">
    <option value="map">Map, both sides</option><option value="right">Right</option><option value="left">Left</option><option value="tree">Tree</option><option value="org">Org chart</option>
  </select>
  <button id="addChild" title="Add a child topic (Tab)">Child</button>
  <button id="addSibling" title="Add a topic after the selected one (Enter)">Sibling</button>
  <button id="del" title="Delete the selected topic and its branch (Delete)">Delete</button>
  <button id="collapseAll" title="Collapse every branch">Collapse all</button>
  <button id="expandAll" title="Expand every branch">Expand all</button>
  <button id="fit" title="Fit the map in the window">Fit</button>
  <button id="openText" title="Open the file as text beside the map">Text</button>
  <span id="pro" class="pro${p.showPro === false ? ' hidden' : ''}">
    <button id="proExport" title="Zovo Pro: export the map or a branch as PNG, SVG or PDF">Export picture</button>
    <button id="proConvert" title="Zovo Pro: convert this map to KM, MM, OPML or a Markdown outline">Convert</button>
    <button id="proTasks" title="Zovo Pro: every topic with priority, progress and notes as a table">Task view</button>
  </span>
</div>
<div id="problem" class="hidden" role="alert"><span id="problemText"></span> <button id="problemOpen">Open as text</button></div>
<div id="main">
  <div id="stage" tabindex="0" aria-label="Mind map. Tab adds a child, Enter a sibling, F2 renames, Delete removes, Space collapses, arrow keys move between topics, drag a topic onto another to move it.">
    <div id="host"></div>
    <textarea id="editbox" class="hidden" spellcheck="false" aria-label="Topic text"></textarea>
    <div id="empty" class="notice">Reading the mind map...</div>
  </div>
  <aside id="details" aria-label="Topic details">
    <div class="dhead" id="dTitle">No topic selected</div>
    <label for="dPriority">Priority</label>
    <select id="dPriority">${PRIORITY_OPTIONS}</select>
    <label for="dProgress">Progress</label>
    <select id="dProgress">${PROGRESS_OPTIONS}</select>
    <label for="dLink">Link</label>
    <input id="dLink" type="text" spellcheck="false" placeholder="https://... or a file path">
    <label for="dNote">Note</label>
    <textarea id="dNote" spellcheck="true" placeholder="A note for this topic"></textarea>
    <div class="keys"><b>Keys</b>: Tab child, Enter sibling, F2 rename, Delete, Space collapse, arrows move, drag to move, Ctrl/Cmd+Z undo.</div>
  </aside>
</div>
<div id="status" aria-live="polite"></div>
<div id="footer"></div>
<template id="zovo-footer">${footer}</template>
<script nonce="${n}">var module = { exports: {} };</script>
<script nonce="${n}" src="${attr(p.layoutUri)}"></script>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

/** The task view (Zovo Pro) page. */
function tasksHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<link rel="stylesheet" href="${attr(p.styleUri)}">
<title>${attr(p.title)}</title>
</head>
<body class="tasks">
<div id="toolbar" role="toolbar" aria-label="Task view">
  <span class="file" id="file">${attr(p.title)}</span>
  <input id="q" type="search" placeholder="Filter topics, notes, links" aria-label="Filter">
  <select id="fPriority" aria-label="Priority filter"><option value="">Any priority</option><option value="any">With a priority</option><option value="none">No priority</option>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((x) => `<option value="${x}">Priority ${x}</option>`).join('')}</select>
  <select id="fProgress" aria-label="Progress filter"><option value="">Any progress</option><option value="open">Open (under 100 %)</option><option value="done">Done (100 %)</option><option value="none">No progress</option></select>
  <label class="chk"><input id="fNote" type="checkbox"> With a note</label>
  <button id="csv" title="Save the rows shown as a CSV file">Export CSV</button>
  <button id="md" title="Save the rows shown as a Markdown table">Export Markdown</button>
  <span id="count" class="stats"></span>
</div>
<main><table id="table"><thead><tr><th>Topic</th><th>Branch</th><th>Priority</th><th>Progress</th><th>Note</th><th>Link</th></tr></thead><tbody id="rows"></tbody></table></main>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { editorHtml, tasksHtml, csp, PREFIX };
