/* ── preload.js · 暴露给渲染进程的原生能力 ────────────── */
const { contextBridge, ipcRenderer } = require('electron');

/* 远程后端配置（remote.json）：启动时同步读一次，页面据此决定走本地 IPC 还是远端 API */
let remote = null;
try { remote = ipcRenderer.sendSync('fm:remote'); } catch (e) {}

contextBridge.exposeInMainWorld('fmNative', {
  isDesktop: true,
  remote: remote,
  setRemote: (cfg) => ipcRenderer.invoke('fm:setRemote', cfg),
  platform: process.platform,
  electron: process.versions.electron,
  libs: () => ipcRenderer.invoke('fm:libs'),
  addLib: (p) => ipcRenderer.invoke('fm:addLib', p),
  activate: (id) => ipcRenderer.invoke('fm:activate', id),
  renameLib: (id, name) => ipcRenderer.invoke('fm:renameLib', id, name),
  relocate: (id) => ipcRenderer.invoke('fm:relocate', id),
  removeLib: (id) => ipcRenderer.invoke('fm:removeLib', id),
  scan: () => ipcRenderer.invoke('fm:scan'),
  covers: () => ipcRenderer.invoke('fm:covers'),
  openLib: (id) => ipcRenderer.invoke('fm:openLib', id),
  reveal: (rel) => ipcRenderer.invoke('fm:reveal', rel),
  saveMeta: (libPath, json) => ipcRenderer.invoke('fm:saveMeta', libPath, json),
  loadMeta: (libPath) => ipcRenderer.invoke('fm:loadMeta', libPath)
});
