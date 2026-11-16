'use strict';
// REACH1: this listing's Pro tools for the map toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  prefix: 'zovoMindmap',
  triesKey: 'zovoMindmap.proTrial',
  slot: '#toolbar',
  tools: [
    { id: 'export', title: 'Export picture', command: 'zovoMindmap.exportPicture' },
    { id: 'convert', title: 'Convert maps', command: 'zovoMindmap.convert' },
    { id: 'tasks', title: 'Task view', command: 'zovoMindmap.taskView' },
  ],
};
