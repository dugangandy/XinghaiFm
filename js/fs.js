/* ── fs.js · 资源库与扫描 ─────────────────────────────── *
 *
 * 「资源库」= 一个目录。桌面版把库列表交给主进程（config.json），
 * 网页版把库列表存 localStorage、目录句柄存 IndexedDB；同一时刻只有一个当前库，
 * 扫描、取文件、封面都只作用于当前库。
 */
(function (FM) {
  'use strict';
  const U = FM.util;

  const NATIVE = !!(typeof window !== 'undefined' && window.fmNative && window.fmNative.isDesktop);
  const MEDIA = FM.media.ALL;
  const MAX_DEPTH = 3;
  const SKIP = /^[._]|^(fm|\$RECYCLE\.BIN|System Volume Information|node_modules)$/i;

  let libs = [];               // [{ id, name, path, missing, fixed, temp }]
  let activeId = null;
  let activeLib = null;
  let mode = 'none';           // 'desktop' | 'handle' | 'files' | 'server' | 'none'
  let rootHandle = null;
  let fileMap = new Map();     // relPath -> File（files 模式）
  let granted = false;
  let serverMode = false;      // 由 tools/serve.js 的 config.json 库列表提供的服务器模式

  /* 桌面端连远程后端：本地 UI 不变，数据通路全部走远端 API。
     有 REMOTE 时 NATIVE 只代表"跑在 Electron 里"，不再代表"用本地文件"。 */
  const REMOTE = NATIVE && window.fmNative.remote && window.fmNative.remote.base
    ? window.fmNative.remote : null;
  const API_BASE = REMOTE ? REMOTE.base : '';
  const API_TOKEN = REMOTE ? REMOTE.token : '';
  const DESKTOP_FS = NATIVE && !REMOTE;   // 真的在读写本机目录

  /* ── 远程链路状态：断线自动探测，恢复后通知界面刷新 ── */
  const LINK_RETRY = [3000, 6000, 9000, 15000, 30000];   // 退避：封顶 30 秒
  let linkState = 'unknown';    // unknown | online | offline | auth
  let linkTimer = 0;
  let linkTries = 0;
  let linkBusy = false;
  const linkSubs = [];

  function onLink(fn) {
    linkSubs.push(fn);
    if (REMOTE) { try { fn(linkState, null); } catch (e) {} }
  }
  function setLink(next) {
    if (linkState === next) return;
    const prev = linkState;
    linkState = next;
    linkSubs.forEach(function (fn) { try { fn(next, prev); } catch (e) {} });
  }
  function markOnline() {
    if (!REMOTE) return;
    linkTries = 0;
    clearTimeout(linkTimer);
    if (linkState === 'offline' || linkState === 'auth') {
      ticketCache = null;          // 重连后票据可能已过期，下次取媒体重新换
      setLink('online');
    } else if (linkState === 'unknown') {
      setLink('online');
    }
  }
  function goOffline() {
    if (!REMOTE || linkState === 'offline' || linkState === 'auth') return;
    setLink('offline');
    scheduleProbe(0);
  }
  function scheduleProbe(delay) {
    if (!REMOTE) return;
    clearTimeout(linkTimer);
    const wait = delay == null ? LINK_RETRY[Math.min(linkTries, LINK_RETRY.length - 1)] : delay;
    linkTimer = setTimeout(probe, wait);
  }
  async function probe() {
    if (!REMOTE || linkBusy) return;
    linkBusy = true;
    let ok = false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(function () { ctrl.abort(); }, 5000);
      const r = await fetch(API_BASE + '/api/config', {
        cache: 'no-store', signal: ctrl.signal,
        headers: API_TOKEN ? { Authorization: 'Bearer ' + API_TOKEN } : {}
      });
      clearTimeout(t);
      if (r.ok) { ok = true; }
      else if (r.status === 401) { setLink('auth'); return; }   // 授权失效：别无限重试，让用户重连
    } catch (e) {
      /* 网络还没通 */
    } finally {
      linkBusy = false;
    }
    if (ok) { markOnline(); return; }
    linkTries++;
    setLink('offline');
    scheduleProbe();
  }

  let authWarned = false;
  function notifyRemoteAuth() {
    if (authWarned) return;
    authWarned = true;
    if (FM.ui && FM.ui.toast) FM.ui.toast('远程服务器未授权，请在资源库菜单里重新连接', 'warn');
  }

  function apiFetch(path, opts) {
    const o = Object.assign({}, opts || {});
    const headers = Object.assign({}, o.headers || {});
    if (API_TOKEN) headers.Authorization = 'Bearer ' + API_TOKEN;
    o.headers = headers;
    return fetch(API_BASE + path, o).then(function (r) {
      if (!REMOTE) return r;
      if (r.ok) markOnline();
      else if (r.status === 401) { notifyRemoteAuth(); setLink('auth'); }
      else if (r.status >= 500) goOffline();
      return r;
    }, function (err) {
      goOffline();
      throw err;
    });
  }

  /* <audio>/<img> 带不了请求头：换一张短期票据挂 query，长期 token 不进 URL */
  let ticketCache = null;   // { t, exp }
  async function signedUrl(path) {
    if (!REMOTE) return path;
    const now = Math.floor(Date.now() / 1000);
    if (!ticketCache || ticketCache.exp - now < 60) {
      const r = await apiFetch('/api/ticket', { cache: 'no-store' });
      if (!r.ok) throw new Error('远程票据获取失败（' + r.status + '）');
      ticketCache = await r.json();
    }
    if (!ticketCache.t) return API_BASE + path;
    return API_BASE + path + (path.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(ticketCache.t);
  }

  /* ── IndexedDB：仅存目录 handle ── */
  function idb() {
    return new Promise(function (res, rej) {
      let req;
      try { req = indexedDB.open('fm-store', 1); } catch (e) { return rej(e); }
      req.onupgradeneeded = () => { try { req.result.createObjectStore('kv'); } catch (e) {} };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  async function idbSet(key, val) {
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      db.close();
      return true;
    } catch (e) { return false; }
  }

  async function idbGet(key) {
    try {
      const db = await idb();
      const val = await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readonly');
        const r = tx.objectStore('kv').get(key);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      db.close();
      return val;
    } catch (e) { return null; }
  }

  async function idbDel(key) {
    try {
      const db = await idb();
      await new Promise((res) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(key);
        tx.oncomplete = res; tx.onerror = res;
      });
      db.close();
    } catch (e) {}
  }

  /* ── 权限 ── */
  async function verify(handle) {
    if (!handle || !handle.queryPermission) return false;
    const opts = { mode: 'read' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return false;
  }

  async function requestAccess(handle) {
    if (!handle || !handle.requestPermission) return false;
    try {
      return (await handle.requestPermission({ mode: 'read' })) === 'granted';
    } catch (e) { return false; }
  }

  /* ── 选择目录 ── */
  function supportsPicker() {
    return typeof window.showDirectoryPicker === 'function' && window.isSecureContext;
  }

  function pickViaInput() {
    return new Promise(function (res, rej) {
      const input = document.getElementById('dirInput');
      const onChange = function () {
        input.removeEventListener('change', onChange);
        if (!input.files || !input.files.length) return rej(new Error('cancelled'));
        res(Array.from(input.files));
        input.value = '';
      };
      input.addEventListener('change', onChange);
      input.click();
    });
  }

  /* 同源探测：只有 serve.js 读到 libs（config.json）时才会回 server:true */
  async function detectServer() {
    try {
      const res = await apiFetch('/api/config', { cache: 'no-store' });
      if (!res.ok) return null;
      const j = await res.json();
      return j && j.server ? j : null;
    } catch (e) { return null; }
  }

  /* ── 当前库 ── */
  function syncActive() {
    activeLib = libs.find(l => l.id === activeId) || null;
    if (!activeLib) {
      mode = 'none'; granted = false; rootHandle = null; fileMap = new Map();
    }
  }

  function applyMode() {
    if (!activeLib) return;
    if (DESKTOP_FS) { mode = 'desktop'; granted = true; }
    else if (serverMode) { mode = 'server'; granted = true; }
    else if (activeLib.temp) { mode = 'files'; granted = true; }
    else { mode = 'handle'; }
  }

  function readWebLibs() {
    const v = FM.store.read('libs', []);
    return Array.isArray(v) ? v.filter(l => l && l.id) : [];
  }

  function writeWebLibs(list) {
    FM.store.write('libs', list);
    FM.store.touch('libs');
  }

  async function load() {
    if (DESKTOP_FS) {
      const res = await window.fmNative.libs();
      libs = res.libs;
      activeId = res.active;
    } else {
      const srv = await detectServer();
      if (REMOTE && !srv) {
        /* 配了远端却连不上：明说，别让人以为书丢了（未授权时上面的提示已经说过一次） */
        if (!authWarned && FM.ui && FM.ui.toast) FM.ui.toast('连不上远程服务器，请检查地址或网络', 'warn');
        goOffline();      // 进重试循环，服务器回来会自动恢复
      }
      if (srv) {
        serverMode = true;
        if (srv.multi) {
          try {
            const r = await apiFetch('/api/libs', { cache: 'no-store' });
            const data = await r.json();
            libs = (data.libs || []).map(l => ({ id: l.id, name: l.name, path: '', missing: !!l.missing, fixed: !!l.fixed }));
            activeId = data.active;
          } catch (e) {
            libs = [];
            activeId = null;
          }
        }
        if (!libs.length) {
          libs = [{ id: 'server', name: srv.rootName || '远程资源库', path: '', missing: false, fixed: true }];
          activeId = 'server';
        }
      } else {
        libs = readWebLibs();
        activeId = FM.store.read('activeLib', null);
        if (!libs.some(l => l.id === activeId)) activeId = libs[0] ? libs[0].id : null;
        if (activeId) {
          const h = await idbGet('handle:' + activeId);
          if (h) { rootHandle = h; granted = await verify(h); }
          else {
            /* 浏览器把目录句柄清掉了（清过浏览数据？）：库留在列表里但标成不可用，
               界面上给「重新添加资源库」，不至于变成点一下就报错的幽灵条目 */
            const l = libs.find(x => x.id === activeId);
            if (l) l.missing = true;
            rootHandle = null;
            granted = false;
          }
        }
      }
    }
    syncActive();
    applyMode();
    return { libs: libs.slice(), active: activeId, missing: !!(activeLib && activeLib.missing) };
  }

  async function add(preset) {
    if (DESKTOP_FS) {
      const res = await window.fmNative.addLib(preset);
      if (!res) { const err = new Error('cancelled'); err.name = 'AbortError'; throw err; }
      const list = await window.fmNative.libs();
      libs = list.libs;
      activeId = list.active;
      syncActive();
      applyMode();
      return activeLib;
    }
    if (serverMode) {
      const p = String(preset || '').trim();
      if (!p) throw new Error('服务器模式需要填入服务器上的目录路径');
      return libMutate('add', { path: p });
    }
    if (!supportsPicker()) return adoptFiles(await pickViaInput());

    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'fm-lib', mode: 'read', startIn: 'downloads' });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      return adoptFiles(await pickViaInput());
    }
    const id = 'l' + Date.now().toString(36);
    await idbSet('handle:' + id, handle);
    const list = readWebLibs();
    list.push({ id: id, name: handle.name, path: handle.name });
    writeWebLibs(list);
    libs = list;
    activeId = id;
    rootHandle = handle;
    granted = true;
    FM.store.write('activeLib', id);
    FM.store.touch('activeLib');
    syncActive();
    applyMode();
    return activeLib;
  }

  /* 重新拉一次库列表（服务器模式下桌面端可能刚加了库），返回列表是否变了 */
  async function refreshLibs() {
    if (!serverMode) return false;
    let data = null;
    try {
      const r = await apiFetch('/api/libs', { cache: 'no-store' });
      if (!r.ok) return false;
      data = await r.json();
    } catch (e) { return false; }
    const next = (data.libs || []).map(l => ({ id: l.id, name: l.name, path: '', missing: !!l.missing, fixed: !!l.fixed }));
    const same = next.length === libs.length && next.every(function (l, i) {
      const o = libs[i];
      return o && o.id === l.id && o.name === l.name && o.missing === l.missing;
    });
    libs = next;
    if (!libs.some(l => l.id === activeId)) activeId = data.active;
    syncActive();
    applyMode();
    return !same;
  }

  /* 服务器模式：让服务端改桌面端的 config.json，然后刷新本地列表 */
  async function libMutate(action, extra) {
    const r = await apiFetch('/api/lib', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, extra || {}))
    });
    if (!r.ok) throw new Error((await r.text()) || '资源库操作失败');
    const data = await r.json();
    libs = (data.libs || []).map(l => ({ id: l.id, name: l.name, path: '', missing: !!l.missing, fixed: !!l.fixed }));
    activeId = data.active;
    syncActive();
    applyMode();
    return activeLib;
  }

  async function activate(id) {
    const lib = libs.find(l => l.id === id);
    if (!lib) throw new Error('资源库不存在');
    if (id === activeId && activeLib) return activeLib;

    if (DESKTOP_FS) {
      if (lib.missing) throw new Error('资源库目录不存在：' + lib.name);
      if (!(await window.fmNative.activate(id))) throw new Error('切换资源库失败');
    } else if (serverMode) {
      if (lib.missing) throw new Error('资源库目录不存在：' + lib.name);
      const r = await apiFetch('/api/activate?id=' + encodeURIComponent(id), { cache: 'no-store' });
      if (!r.ok) throw new Error('切换资源库失败');
      const data = await r.json();
      libs = (data.libs || []).map(l => ({ id: l.id, name: l.name, path: '', missing: !!l.missing, fixed: !!l.fixed }));
      activeId = data.active;
    } else {
      if (lib.temp) throw new Error('当前是临时目录，不支持切换');
      const h = await idbGet('handle:' + id);
      if (!h) throw new Error('目录授权已失效，请重新添加这个资源库');
      const ok = (await verify(h)) || (await requestAccess(h));
      if (!ok) throw new Error('目录授权被拒绝');
      rootHandle = h;
      FM.store.write('activeLib', id);
      FM.store.touch('activeLib');
    }

    activeId = id;
    granted = true;
    syncActive();
    applyMode();
    return activeLib;
  }

  async function remove(id) {
    FM.db.dropIndex(id);
    if (DESKTOP_FS) {
      const res = await window.fmNative.removeLib(id);
      const list = await window.fmNative.libs();
      libs = list.libs;
      activeId = res.active;
    } else if (serverMode) {
      return libMutate('remove', { id: id });
    } else if (libs.some(l => l.temp)) {
      throw new Error('临时资源库不能移除');
    } else {
      const list = readWebLibs().filter(l => l.id !== id);
      writeWebLibs(list);
      await idbDel('handle:' + id);
      libs = list;
      if (activeId === id) {
        activeId = list[0] ? list[0].id : null;
        rootHandle = null;
      }
    }
    FM.db.dropIndex(id);
    syncActive();
    if (!activeLib) return null;
    applyMode();
    if (DESKTOP_FS || serverMode) {
      granted = true;
    } else if (!rootHandle) {
      /* 移走当前库后要顺手接上下一个库的句柄，否则切过去没权限 */
      const h = await idbGet('handle:' + activeId);
      if (h) { rootHandle = h; granted = await verify(h); }
      else granted = false;
    }
    return activeLib;
  }

  async function rename(id, name) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return activeLib;
    if (DESKTOP_FS) {
      const v = await window.fmNative.renameLib(id, clean);
      if (v) {
        const i = libs.findIndex(l => l.id === id);
        if (i >= 0) libs[i] = Object.assign({}, libs[i], v);
      }
    } else if (serverMode) {
      await libMutate('rename', { id: id, name: clean });
    } else {
      const list = readWebLibs();
      const l = list.find(x => x.id === id);
      if (l) { l.name = clean; writeWebLibs(list); libs = list; }
    }
    syncActive();
    return activeLib;
  }

  /* ── 元数据：从服务端拉、把进度推回去 ── */
  async function pullMeta() {
    if (!serverMode) return false;
    let data = null;
    try {
      const r = await apiFetch('/api/meta', { cache: 'no-store' });
      if (!r.ok) return false;
      data = await r.json();
    } catch (e) { return false; }
    if (!data || data.empty) return false;
    let touched = false;

    if (Array.isArray(data.cats) && data.cats.length) {
      FM.db.setCats(data.cats);
      FM.store.touch('cats');
      touched = true;
    }
    if (data.albumMeta && typeof data.albumMeta === 'object') {
      const metas = FM.db.albumMeta();
      let hit = 0;
      Object.keys(data.albumMeta).forEach(function (k) {
        if (k.indexOf('|') < 0) return;
        metas[k] = data.albumMeta[k];
        hit++;
      });
      if (hit) { FM.db.setAlbumMeta(metas); FM.store.touch('albumMeta'); touched = true; }
    }
    if (data.durations && typeof data.durations === 'object') {
      const durs = FM.db.durations();
      let ch = 0;
      Object.keys(data.durations).forEach(function (k) {
        const v = Number(data.durations[k]) || 0;
        if (v > 0 && durs[k] !== v) { durs[k] = v; ch++; }
      });
      if (ch) { FM.db.setDurations(durs); FM.store.touch('durations'); touched = true; }
    }
    if (data.progress && typeof data.progress === 'object') {
      const prog = FM.db.progress();
      let ch = 0;
      Object.keys(data.progress).forEach(function (k) {
        const b = data.progress[k];
        if (!b) return;
        const a = prog[k];
        if (!a || (Number(b.t) || 0) > (Number(a.t) || 0)) { prog[k] = b; ch++; }
      });
      if (ch) { FM.db.setProgress(prog); FM.store.touch('progress'); touched = true; }
    }
    return touched;
  }

  async function pushProgress(rec) {
    if (!serverMode || !rec || !rec.id) return false;
    try {
      await apiFetch('/api/progress', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ libId: activeId }, rec))
      });
      return true;
    } catch (e) { return false; }
  }

  async function openLib(id) {
    if (!DESKTOP_FS) return false;
    try { return await window.fmNative.openLib(id || activeId); } catch (e) { return false; }
  }

  async function relocate(id) {
    if (!DESKTOP_FS) throw new Error('当前模式不支持重新定位');
    const v = await window.fmNative.relocate(id);
    if (!v) return null;
    const i = libs.findIndex(l => l.id === id);
    if (i >= 0) libs[i] = Object.assign({}, libs[i], v);
    syncActive();
    return v;
  }

  function adoptFiles(files) {
    fileMap = new Map();
    let top = '';
    files.forEach(function (f) {
      const p = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
      const segs = p.split('/');
      if (!top) top = segs[0];
      const rel = segs.slice(1).join('/') || f.name;
      fileMap.set(rel, f);
    });
    const name = top || '临时目录';
    libs = [{ id: 'tmp', name: name, path: name, missing: false, temp: true }];
    activeId = 'tmp';
    syncActive();
    mode = 'files';
    granted = true;
    return activeLib;
  }

  async function grant() {
    if (DESKTOP_FS) return true;
    if (serverMode) return true;
    if (!rootHandle) return false;
    granted = await requestAccess(rootHandle);
    return granted;
  }

  /* ── 扫描 ── */
  async function walkHandle(dir, prefix, depth, out, onProgress) {
    for await (const entry of dir.entries()) {
      const name = entry[0], handle = entry[1];
      if (SKIP.test(name)) continue;
      const rel = prefix ? prefix + '/' + name : name;
      if (handle.kind === 'directory') {
        if (depth < MAX_DEPTH) await walkHandle(handle, rel, depth + 1, out, onProgress);
      } else {
        const dot = name.lastIndexOf('.');
        const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
        if (!MEDIA[ext]) continue;
        out.push({ rel, name, ext, handle, depth, size: 0, mtime: 0 });
        if (onProgress && out.length % 80 === 0) onProgress({ phase: 'list', count: out.length });
      }
    }
  }

  async function walkFiles(files, onProgress) {
    const out = [];
    files.forEach(function (f) {
      const p = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
      const segs = p.split('/');
      const rel = segs.slice(1).join('/') || f.name;
      const name = segs[segs.length - 1];
      const dot = name.lastIndexOf('.');
      const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
      if (!MEDIA[ext]) return;
      out.push({ rel, name, ext, depth: segs.length - 1, size: f.size, mtime: f.lastModified, file: f });
    });
    if (onProgress) onProgress({ phase: 'list', count: out.length });
    return out;
  }

  async function resolveSizes(items, onProgress) {
    const total = items.length;
    let cursor = 0, done = 0;
    const CONC = 12;
    async function worker() {
      while (cursor < total) {
        const item = items[cursor++];
        if (item.handle) {
          try {
            const f = await item.handle.getFile();
            item.size = f.size;
            item.mtime = f.lastModified;
          } catch (e) { item.size = 0; }
        }
        done++;
        if (onProgress && done % 60 === 0) onProgress({ phase: 'size', done, total });
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(CONC, total); i++) workers.push(worker());
    await Promise.all(workers);
    if (onProgress) onProgress({ phase: 'size', done: total, total });
  }

  async function scan(onProgress) {
    if (!activeLib) throw new Error('尚未选择资源库');
    const libId = activeId;

    /* 服务器模式：目录在跑服务的那台机器上，问它要列表 */
    if (mode === 'server') {
      const res = await apiFetch('/api/scan', { cache: 'no-store' });
      if (!res.ok) throw new Error('服务器扫描失败：HTTP ' + res.status);
      const data = await res.json();
      if (onProgress) onProgress({ phase: 'size', done: data.files.length, total: data.files.length });
      /* root 用服务端回的真实路径：albumMeta 的键是「<路径>|<专辑id>」，和桌面端要对得上 */
      return { libId, rootName: data.rootName || activeLib.name, root: data.root || 'server', mode, files: data.files };
    }

    /* 桌面模式：交给主进程读盘，速度更快且无授权问题 */
    if (mode === 'desktop') {
      if (onProgress) onProgress({ phase: 'list', count: 0 });
      const res = await window.fmNative.scan();
      if (onProgress) onProgress({ phase: 'size', done: res.files.length, total: res.files.length });
      return { libId, rootName: res.rootName || activeLib.name, root: res.root, mode, files: res.files };
    }

    let items;
    if (mode === 'handle') {
      items = [];
      await walkHandle(rootHandle, '', 1, items, onProgress);
    } else {
      items = await walkFiles(Array.from(fileMap.values()), onProgress);
    }
    if (onProgress) onProgress({ phase: 'size', done: 0, total: items.length });
    await resolveSizes(items, onProgress);
    return {
      libId,
      rootName: activeLib.name,
      root: activeLib.path || activeLib.name,
      mode,
      files: items.map(function (it) {
        return { rel: it.rel, name: it.name, ext: it.ext, size: it.size, mtime: it.mtime, depth: it.depth };
      })
    };
  }

  /* ── 取文件 ── */
  /* 桌面模式：直接给 fm:// 流式地址，由主进程按 Range 读盘，不整本读进内存 */
  function mediaUrl(rel) {
    return 'fm://app/__media/' + rel.split('/').map(encodeURIComponent).join('/');
  }

  async function src(rel) {
    if (mode === 'server') return { url: await signedUrl('/api/media/' + rel.split('/').map(encodeURIComponent).join('/')), revoke: null };
    if (mode === 'desktop') return { url: mediaUrl(rel), revoke: null };
    const file = await getFile(rel);
    const url = URL.createObjectURL(file);
    return { url: url, revoke: function () { URL.revokeObjectURL(url); } };
  }

  async function getFile(rel) {
    if (mode === 'files') {
      const f = fileMap.get(rel);
      if (!f) throw new Error('文件已不在目录中：' + rel);
      return f;
    }
    if (!rootHandle) throw new Error('资源库未授权');
    if (!granted) {
      const ok = await grant();
      if (!ok) throw new Error('目录授权已失效，请重新添加这个资源库');
    }
    const segs = rel.split('/');
    try {
      let dir = rootHandle;
      for (let i = 0; i < segs.length - 1; i++) dir = await dir.getDirectoryHandle(segs[i]);
      const fh = await dir.getFileHandle(segs[segs.length - 1]);
      return await fh.getFile();
    } catch (e) {
      throw new Error('读取失败，文件可能已被移动：' + rel);
    }
  }

  FM.fs = {
    load, add, activate, remove, rename, relocate, openLib, pullMeta, pushProgress, refreshLibs,
    scan, getFile, src, grant, adoptFiles, supportsPicker,
    apiFetch, signedUrl,
    libs: () => libs.slice(),
    active: () => activeLib,
    get activeId() { return activeId; },
    get native() { return DESKTOP_FS; },
    get desktop() { return NATIVE; },
    get remote() { return REMOTE; },
    get link() { return linkState; },
    onLink,
    get server() { return serverMode; },
    get mode() { return mode; },
    get rootName() { return activeLib ? activeLib.name : ''; },
    get granted() { return granted; },
    get hasSource() { return !!activeLib; }
  };
})(window.FM);
