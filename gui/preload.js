'use strict';
/**
 * preload —— 唯一的桥。
 * 渲染进程拿不到 Node，只能通过这里暴露的几个方法跟主进程说话。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  envCheck: () => ipcRenderer.invoke('env-check'),
  pickOutput: (p) => ipcRenderer.invoke('pick-output', p),
  pickDir: (p) => ipcRenderer.invoke('pick-dir', p),
  openFile: (f) => ipcRenderer.invoke('open-file', f),
  revealFile: (f) => ipcRenderer.invoke('reveal-file', f),
  openExternal: (u) => ipcRenderer.invoke('open-external', u),
  start: (opts) => ipcRenderer.invoke('start-download', opts),
  cancel: () => ipcRenderer.invoke('cancel-download'),
  onLog: (cb) => ipcRenderer.on('dl:log', (_e, p) => cb(p)),
  onProgress: (cb) => ipcRenderer.on('dl:progress', (_e, p) => cb(p)),
  onDone: (cb) => ipcRenderer.on('dl:done', (_e, p) => cb(p)),
});
