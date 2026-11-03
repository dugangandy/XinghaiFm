/* ── preload.js · 暴露给渲染进程的原生能力 ────────────── */
const { contextBridge, ipcRenderer } = require('electron');

/* 远程后端配置（remote.json）：启动时同步读一次，页面据此决定走本地 IPC 还是远端 API */
let remote = null;
try { remote = ipcRenderer.sendSync('fm:remote'); } catch (e) {}

/* 应用版本号：main 里 app.getVersion() 同步取一次 */
let appVersion = '';
try { appVersion = ipcRenderer.sendSync('fm:version') || ''; } catch (e) {}

/* 是否启用了硬件加速：界面据此决定上不上重特效（毛玻璃、混合模式、逐帧动画） */
let gpuAccel = false;
try { gpuAccel = !!ipcRenderer.sendSync('fm:gpu'); } catch (e) {}

contextBridge.exposeInMainWorld('fmNative', {
  isDesktop: true,
  remote: remote,
  gpuAccel: gpuAccel,
  setRemote: (cfg) => ipcRenderer.invoke('fm:setRemote', cfg),
  platform: process.platform,
  electron: process.versions.electron,
  version: appVersion,
  libs: () => ipcRenderer.invoke('fm:libs'),
  addLib: (p) => ipcRenderer.invoke('fm:addLib', p),
  activate: (id) => ipcRenderer.invoke('fm:activate', id),
  renameLib: (id, name) => ipcRenderer.invoke('fm:renameLib', id, name),
  relocate: (id) => ipcRenderer.invoke('fm:relocate', id),
  removeLib: (id) => ipcRenderer.invoke('fm:removeLib', id),
  scan: () => ipcRenderer.invoke('fm:scan'),
  covers: () => ipcRenderer.invoke('fm:covers'),
  searchCover: (title) => ipcRenderer.invoke('fm:searchCover', title),
  saveCover: (dirName, payload) => ipcRenderer.invoke('fm:saveCover', dirName, payload),
  deleteCover: (dirName) => ipcRenderer.invoke('fm:deleteCover', dirName),
  openLib: (id) => ipcRenderer.invoke('fm:openLib', id),
  reveal: (rel) => ipcRenderer.invoke('fm:reveal', rel),
  /* 转码：wma/ape/wv/flv 先转成 mp3/mp4 再播，返回 { url } 或 { error }。
     id 用来取消：页面切到别的集时调 cancelPrepare(id)，主进程会停掉这次转码 */
  prepare: (rel, id) => ipcRenderer.invoke('fm:prepare', rel, id),
  cancelPrepare: (id) => ipcRenderer.send('fm:tcCancel', id),
  probeDur: (rel) => ipcRenderer.invoke('fm:probeDur', rel),
  /* 转码进度（同一时间只有一个任务在跑），页面据此显示百分比 */
  onTc: (cb) => ipcRenderer.on('fm:tc', (e, info) => { try { cb(info); } catch (err) {} }),
  /* saveMeta 只用于导出 .fm-meta.json 快照；读写分类/进度一律走 meta / metaPatch */
  saveMeta: (libPath, json) => ipcRenderer.invoke('fm:saveMeta', libPath, json),
  loadMeta: (libPath) => ipcRenderer.invoke('fm:loadMeta', libPath),
  meta: (libId) => ipcRenderer.invoke('fm:meta', libId),
  metaPatch: (libId, patch) => ipcRenderer.invoke('fm:metaPatch', libId, patch),
  favs: (libId) => ipcRenderer.invoke('fm:favs', libId),
  setFav: (libId, albumId, on) => ipcRenderer.invoke('fm:setFav', libId, albumId, on),
  favTracks: (libId) => ipcRenderer.invoke('fm:favTracks', libId),
  setFavTrack: (libId, trackId, on) => ipcRenderer.invoke('fm:setFavTrack', libId, trackId, on),
  /* 后台补完封面时通知一次，页面据此重读封面索引 */
  onCovers: (cb) => ipcRenderer.on('fm:covers', (e, info) => { try { cb(info); } catch (err) {} })
});
