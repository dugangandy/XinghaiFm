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
  /* 安卓壳：没有 showDirectoryPicker，也没有本地目录，只能走服务端 */
  const APP = !!(typeof window !== 'undefined' && window.fmAndroid);
  const MEDIA = FM.media.ALL;
  /* 与主进程 / serve.js 保持一致：分类/专辑/子目录/… 里的音频都要收进来 */
  const MAX_DEPTH = 6;
  const SKIP = /^[._]|^(fm|\$RECYCLE\.BIN|System Volume Information|node_modules)$/i;

  let libs = [];               // [{ id, name, path, missing, fixed, temp }]
  let activeId = null;
  let activeLib = null;
  let mode = 'none';           // 'desktop' | 'handle' | 'files' | 'server' | 'none'
  let rootHandle = null;
  let fileMap = new Map();     // relPath -> File（files 模式）
  let granted = false;
  let serverMode = false;      // 由 tools/serve.js 的 config.json 库列表提供的服务器模式
  let serverVersion = '';      // 服务端 package.json 的版本号（浏览器直连时用来显示）
  let favSet = new Set();      // 当前用户 + 当前库的收藏专辑 id
  let trackFavSet = new Set(); // 当前用户 + 当前库的收藏曲目 id
  let favLibId = '';           // favSet 属于哪个库（拉取失败时判断要不要清空）

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
      ticketCache = Object.create(null);   // 重连后票据可能已过期，下次取媒体重新换
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
    }, function (e) {
      /* 主动取消（切集时 abort）不是断网，别把连接状态改成 offline */
      if (e && e.name === 'AbortError') throw e;
      goOffline();
      throw new Error(U.NET_FAIL);
    });
  }

  /* <audio>/<img> 带不了请求头：能靠 cookie 的就靠 cookie（浏览器/APK，URL 上不挂票据），
     桌面端（fm://app + Bearer，没有 cookie）才换一张短期票据挂 query */
  let ticketCache = Object.create(null);     // scope -> { t, exp }
  async function signedUrl(path) {
    if (!REMOTE) return path;
    const scope = path.indexOf('/api/cover/') === 0 ? 'cover' : 'media';
    const now = Math.floor(Date.now() / 1000);
    let c = ticketCache[scope];
    /* 票据按用途分开取：封面 10 分钟一轮，媒体要顶住单集时长，不能共用一份 */
    if (!c || (c.t && c.exp - now < 60)) {
      const r = await apiFetch('/api/ticket?scope=' + scope, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status === 401 ? '登录已过期，请重新登录' : U.NET_FAIL);
      c = ticketCache[scope] = await r.json();
    }
    if (!c.t) return API_BASE + path;      // cookie 模式：同源请求自带会话 cookie
    return API_BASE + path + (path.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(c.t);
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
        if (!authWarned && FM.ui && FM.ui.toast) FM.ui.toast(U.NET_FAIL, 'warn');
        goOffline();      // 进重试循环，服务器回来会自动恢复
      }
      if (srv) {
        serverMode = true;
        serverVersion = srv.version || '';
        if (srv.multi) {
          try {
            const r = await apiFetch('/api/libs', { cache: 'no-store' });
            const data = await r.json();
            libs = (data.libs || []).map(l => ({
              id: l.id, name: l.name, path: '', missing: !!l.missing, fixed: !!l.fixed,
              dirGroup: !!l.dirGroup
            }));
            activeId = data.active;
          } catch (e) {
            libs = [];
            activeId = null;
          }
        }
        if (!libs.length) {
          libs = [{
            id: 'server', name: srv.rootName || '远程资源库', path: '', missing: false, fixed: true,
            dirGroup: !!srv.dirGroup
          }];
          activeId = 'server';
        }
      } else if (APP) {
        /* 壳里连不上服务端时别退到选目录模式：那条路在 WebView 里根本走不通 */
        libs = [];
        activeId = null;
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
    await loadFavs(activeId);
    /* 恢复索引是在收藏之前渲染的：拿到的收藏要贴回去再刷一遍，否则首屏心是空的 */
    if (FM.lib && FM.lib.applyFavs && FM.lib.albums().length) {
      FM.lib.applyFavs(favSet);
      if (FM.lib.applyTrackFavs) FM.lib.applyTrackFavs(trackFavSet);
      if (FM.ui && FM.ui.renderAll) FM.ui.renderAll({ quiet: true });
    }
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
    if (APP) throw new Error('请先在电脑端添加资源库');
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
    const next = (data.libs || []).map(l => ({
      id: l.id, name: l.name, path: '', missing: !!l.missing, fixed: !!l.fixed,
      dirGroup: !!l.dirGroup
    }));
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
    libs = (data.libs || []).map(l => ({
      id: l.id, name: l.name, path: '', missing: !!l.missing, fixed: !!l.fixed,
      dirGroup: !!l.dirGroup
    }));
    activeId = data.active;
    syncActive();
    applyMode();
    return activeLib;
  }

  /* 「按目录分两级」开关（一层子目录当分类、二层当专辑）
     桌面走 IPC 写 fm.db，服务端走 /api/libdirgroup，纯网页存本地库条目 */
  async function setDirGroup(id, on) {
    const val = !!on;
    const lib = libs.find(l => l.id === id) || activeLib;
    if (DESKTOP_FS) {
      /* 老客户端没有这条通道：invoke 会报 "No handler registered"，这里先说人话 */
      if (typeof window.fmNative.setLibDirGroup !== 'function') {
        throw new Error('客户端版本过旧：请完全退出并重新打开星海 FM');
      }
      const r = await window.fmNative.setLibDirGroup(id, val);
      if (r !== val) throw new Error('开关未写入（资源库可能已被移除）');
    } else if (serverMode) {
      const r = await apiFetch('/api/libdirgroup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id, on: val })
      });
      if (!r.ok) {
        const txt = String((await r.text()) || '').trim();
        /* 404 = 服务端还没这条路由（进程是旧代码），说清楚要重启哪一边，别把 "not found" 甩给用户 */
        if (r.status === 404) throw new Error('服务端版本过旧：请重启运行中的 tools/serve.js 后再试');
        if (r.status === 401) throw new Error('登录已过期，请重新登录后再试');
        if (r.status === 403) throw new Error('没有权限修改这个资源库的分组方式');
        throw new Error(txt.slice(0, 80) || '设置失败');
      }
    } else {
      const list = readWebLibs();
      const l = list.find(x => x.id === id);
      if (l) { l.dirGroup = val; writeWebLibs(list); }
    }
    if (lib) lib.dirGroup = val;
    return val;
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
      libs = (data.libs || []).map(l => ({
        id: l.id, name: l.name, path: '', missing: !!l.missing, fixed: !!l.fixed,
        dirGroup: !!l.dirGroup
      }));
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
    await loadFavs(id);
    if (FM.lib && FM.lib.applyFavs) FM.lib.applyFavs(favSet);
    if (FM.lib && FM.lib.applyTrackFavs) FM.lib.applyTrackFavs(trackFavSet);
    return activeLib;
  }

  async function remove(id) {
    FM.db.dropIndex(id);
    FM.db.dropCats(id);
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
    FM.db.dropCats(id);
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

  /* ── 库元数据（分类 / 专辑整理 / 进度 / 时长）：真数据在 fm.db ──
     桌面本地库走 IPC（本机数据库），浏览器 / APK / 桌面远程走 /api/meta，
     纯网页本地目录没有后端，继续只存本地缓存（不参与同步）。 */
  const META_DEBOUNCE = 900;   // 攒 900ms 再发：连续拖动归类/连续上报进度合成一次
  let metaQueue = null;        // 待发增量 { libId, cats?, albumMeta?, progress?, durations? }
  let metaTimer = 0;
  let metaSending = false;
  let metaRetry = 0;

  function metaChannel() {
    if (DESKTOP_FS) return 'ipc';
    return serverMode ? 'http' : 'local';
  }

  /* 有没有可写的后端：桌面本地库（IPC）和服务器模式（HTTP）都能写，
     纯网页本地目录只能存本地缓存，不用白跑一趟 */
  function canSyncMeta() { return metaChannel() !== 'local'; }

  /* 比「有没有变化」用的归一化：座位顺序/多余字段（addedAt、root、auto）不算变化，
     否则每次回前台都会白重绘一遍，列表滚动位置还会被重置 */
  function normCats(list) {
    return JSON.stringify((list || []).map(function (c) { return [c.id, c.name || '', c.color || '', Number(c.order) || 0]; }));
  }
  function normAlbum(m) {
    return JSON.stringify([(m && m.cats) || [], (m && m.title) || '', m && m.pinned ? 1 : 0, m && m.hidden ? 1 : 0]);
  }
  function normAlbumOf(map, prefix) {
    const out = [];
    Object.keys(map || {}).forEach(function (k) {
      if (prefix && k.indexOf(prefix) !== 0) return;
      out.push([k, normAlbum(map[k])]);
    });
    out.sort();
    return JSON.stringify(out);
  }

  /* 把快照灌进本地缓存（界面全读缓存，改这里就够了）。
     专辑整理按当前库整段替换：库里删掉的条目（取消归类）本地也要跟着消失。 */
  function applyMeta(data) {
    if (!data || data.empty) return false;
    let touched = false;
    if (Array.isArray(data.cats) && Number(data.v) >= 2 && activeId) {
      if (normCats(FM.db.catsFor(activeId)) !== normCats(data.cats)) {
        FM.db.setCatsFor(activeId, data.cats);
        FM.store.touch('cats:' + activeId);
        touched = true;
      }
    }
    if (data.albumMeta && typeof data.albumMeta === 'object' && FM.lib.rootKey) {
      /* 用本地库的 rootKey 做前缀，而不是服务端返回的 data.root 原串：
         两套路径字符串若归一化不一致（大小写 / 尾斜杠 / 分隔符），按 data.root 前缀匹配会
         整段重建，本地缓存里还可能留下两份键让 library 读到旧数据。这里把入站条目统一
         重新挂到本地 rootKey 下（album id 不变），彻底解耦两边的路径表示。 */
      const prefix = FM.lib.rootKey + '|';
      const metas = FM.db.albumMeta();
      const incoming = {};
      Object.keys(data.albumMeta).forEach(function (k) {
        const cut = k.indexOf('|');
        if (cut < 0) return;
        /* 入站条目是服务端快照（不含 root），重新挂到本地 rootKey 时把 root 也补上，
           否则 library.build() 用「meta.root === rootKey」判断归属会得到 false，
           重扫时把 cats/pinned/hidden/title 全清掉（restore() 用宽松判断才没暴露） */
        incoming[prefix + k.slice(cut + 1)] = Object.assign({ root: FM.lib.rootKey }, data.albumMeta[k]);
      });
      if (normAlbumOf(metas, prefix) !== normAlbumOf(incoming, prefix)) {
        Object.keys(metas).forEach(function (k) { if (k.indexOf(prefix) === 0) delete metas[k]; });
        Object.keys(incoming).forEach(function (k) { metas[k] = incoming[k]; });
        FM.db.setAlbumMeta(metas);
        FM.store.touch('albumMeta');
        touched = true;
      }
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

  async function pullMeta() {
    const ch = metaChannel();
    if (ch === 'local') return false;
    let data = null;
    try {
      if (ch === 'ipc') {
        /* 老版本 preload 没有 meta：别把桌面端搞崩，退回只读文件快照 */
        if (!window.fmNative.meta) return false;
        data = await window.fmNative.meta(activeId);
      } else {
        const r = await apiFetch('/api/meta', { cache: 'no-store' });
        if (!r.ok) return false;
        data = await r.json();
      }
    } catch (e) { return false; }
    return applyMeta(data);
  }

  function mergePatch(base, add) {
    if (!add) return base;
    if (add.cats) base.cats = add.cats;
    if (add.albumMeta) Object.assign(base.albumMeta || (base.albumMeta = {}), add.albumMeta);
    if (add.progress) Object.assign(base.progress || (base.progress = {}), add.progress);
    if (add.durations) Object.assign(base.durations || (base.durations = {}), add.durations);
    return base;
  }

  /* 增量写回：本地缓存先改（乐观 UI），这里只负责把变化推给数据库 */
  function pushMeta(patch) {
    if (!patch || !activeId) return false;
    if (metaChannel() === 'local') return false;
    metaQueue = mergePatch(metaQueue || { libId: activeId }, patch);
    clearTimeout(metaTimer);
    metaTimer = setTimeout(flushMeta, META_DEBOUNCE);
    return true;
  }

  /* 数据库每包最多收 500 条 albumMeta（db.js 的 META_LIMIT），超出的会被静默截断：
     大库第一次落库要拆包，否则只有前 500 个专辑的归类能存下来，重开就丢 */
  const META_BATCH = 400;
  function splitPatch(patch) {
    const meta = patch.albumMeta;
    const keys = meta ? Object.keys(meta) : [];
    if (keys.length <= META_BATCH) return [patch];
    const out = [];
    for (let i = 0; i < keys.length; i += META_BATCH) {
      const one = { libId: patch.libId, albumMeta: {} };
      /* 分类 / 进度 / 时长只在第一批带，后面各批只负责专辑整理 */
      if (i === 0) {
        if (patch.cats) one.cats = patch.cats;
        if (patch.progress) one.progress = patch.progress;
        if (patch.durations) one.durations = patch.durations;
      }
      keys.slice(i, i + META_BATCH).forEach(function (k) { one.albumMeta[k] = meta[k]; });
      out.push(one);
    }
    return out;
  }

  async function flushMeta() {
    if (!metaQueue) return false;
    /* 上一发还在飞：稍后再发，别把这一批直接丢掉 */
    if (metaSending) {
      clearTimeout(metaTimer);
      metaTimer = setTimeout(flushMeta, 300);
      return false;
    }
    const patch = metaQueue;
    metaQueue = null;
    metaSending = true;
    let ok = true;
    try {
      const ch = metaChannel();
      const parts = splitPatch(patch);
      const t0 = Date.now();       // 节流窗口起点（见下面的 12 批 / 秒）
      for (let i = 0; i < parts.length; i++) {
        const one = parts[i];
        let sent = false;
        if (ch === 'ipc') {
          sent = !!(await window.fmNative.metaPatch(one.libId, one));
        } else if (ch === 'http') {
          const r = await apiFetch('/api/meta', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(one)
          });
          /* 响应体必须读掉：不消费的话这条连接一直占着，进度每 10 秒一条，很快把同域 6 条连接占满 */
          try { await r.text(); } catch (e) {}
          sent = r.ok;
        }
        if (!sent) { ok = false; break; }
        /* 拆包节流：服务端给 meta 写入的额度是「1 秒 20 次」，这里按每秒 12 批自限。
           小批量只等基础间隔不被拖慢，大批量则在第 12、24… 批把这一秒补齐，绝不撞限额 */
        if (parts.length > 1 && i < parts.length - 1) {
          let wait = 60;
          if ((i + 1) % 12 === 0) wait = Math.max(wait, 1000 - (Date.now() - t0));
          await new Promise(function (res) { setTimeout(res, wait); });
        }
      }
    } catch (e) { ok = false; }
    metaSending = false;
    if (ok) {
      metaRetry = 0;
      /* 分批期间可能又攒了新改动：补排一次，别等下一次用户操作 */
      if (metaQueue) { clearTimeout(metaTimer); metaTimer = setTimeout(flushMeta, 200); }
      return true;
    }
    /* 失败重排一次；再失败就丢弃，下次 pullMeta 会把状态纠正回来（不阻塞播放） */
    if (metaRetry < 1) {
      metaRetry++;
      metaQueue = mergePatch(patch, metaQueue);
      clearTimeout(metaTimer);
      metaTimer = setTimeout(flushMeta, 2000);
    } else {
      metaRetry = 0;
      console.warn('[meta] 写入失败，已放弃本次改动');
      /* 进度也走这个通道：只含进度时别报成「整理」，免得用户误以为分类丢了 */
      try {
        if (FM.ui && FM.ui.toast) {
          const onlyProgress = !patch.cats && !patch.albumMeta;
          FM.ui.toast(onlyProgress ? '播放进度没保存上，请检查连接后重试' : '整理没保存上，请检查连接后重试', 'warn');
        }
      } catch (e) {}
    }
    return false;
  }

  /* 进度上报：仍然每 10 秒一次，只是改走 meta 的增量通道 */
  function pushProgress(rec) {
    if (!rec || !rec.id) return false;
    const one = {};
    one[rec.id] = { p: rec.p, d: rec.d, t: rec.t, done: !!rec.done };
    return pushMeta({ progress: one });
  }

  /* ── 收藏：跟用户绑定，存数据库 ──
     桌面端走 IPC（本机 fm.db），服务端/远程走 /api/favs，网页本地库退回 localStorage。 */
  async function loadFavs(libId) {
    const id = libId || activeId;
    if (!id) { favSet = new Set(); trackFavSet = new Set(); favLibId = ''; return favSet; }
    const next = new Set();
    const nextTracks = new Set();
    try {
      if (DESKTOP_FS) {
        (await window.fmNative.favs(id) || []).forEach(x => next.add(String(x)));
        /* 旧版 preload 没有 favTracks：别让曲目收藏把专辑收藏一起带崩 */
        if (window.fmNative.favTracks) {
          (await window.fmNative.favTracks(id) || []).forEach(x => nextTracks.add(String(x)));
        }
      } else if (serverMode) {
        const r = await apiFetch('/api/favs?libId=' + encodeURIComponent(id), { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        (d.ids || []).forEach(x => next.add(String(x)));
        (d.trackIds || []).forEach(x => nextTracks.add(String(x)));
      } else {
        const v = FM.store.read('favs:' + id, []);
        (Array.isArray(v) ? v : []).forEach(x => next.add(String(x)));
        const tv = FM.store.read('favTracks:' + id, []);
        (Array.isArray(tv) ? tv : []).forEach(x => nextTracks.add(String(x)));
      }
    } catch (e) {
      console.warn('[favs] 读取失败', e);
      /* 拉失败不清空：弱网下别让收藏看起来“丢了”；但换库失败不能留着上一个库的 */
      if (favLibId !== id) { favSet = new Set(); trackFavSet = new Set(); favLibId = ''; }
      return favSet;
    }
    favSet = next;
    trackFavSet = nextTracks;
    favLibId = id;
    return favSet;
  }

  async function setFav(albumId, on) {
    const id = activeId, a = String(albumId || '');
    if (!id || !a) return false;
    const next = !!on;
    if (next) favSet.add(a); else favSet.delete(a);
    try {
      if (DESKTOP_FS) {
        const ok = await window.fmNative.setFav(id, a, next);
        if (ok === false) throw new Error('写入失败');
      } else if (serverMode) {
        const r = await apiFetch('/api/favs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ libId: id, albumId: a, fav: next })
        });
        const txt = await r.text();
        if (!r.ok) throw new Error(txt || 'HTTP ' + r.status);
      } else {
        FM.store.write('favs:' + id, Array.from(favSet));
        FM.store.touch('favs:' + id);
      }
      return true;
    } catch (e) {
      if (next) favSet.delete(a); else favSet.add(a);
      console.warn('[favs] 写入失败', e);
      return false;
    }
  }

  async function setFavTrack(trackId, on) {
    const id = activeId, t = String(trackId || '');
    if (!id || !t) return false;
    const next = !!on;
    if (next) trackFavSet.add(t); else trackFavSet.delete(t);
    try {
      if (DESKTOP_FS) {
        const ok = await window.fmNative.setFavTrack(id, t, next);
        if (ok === false) throw new Error('写入失败');
      } else if (serverMode) {
        const r = await apiFetch('/api/favs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ libId: id, trackId: t, fav: next })
        });
        const txt = await r.text();
        if (!r.ok) throw new Error(txt || 'HTTP ' + r.status);
      } else {
        FM.store.write('favTracks:' + id, Array.from(trackFavSet));
        FM.store.touch('favTracks:' + id);
      }
      return true;
    } catch (e) {
      if (next) trackFavSet.delete(t); else trackFavSet.add(t);
      console.warn('[favs] 曲目收藏写入失败', e);
      return false;
    }
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

  /* opts.refresh=true 表示跳过服务端/主进程的扫描缓存，真的重扫一遍（只给「重新扫描」用） */
  async function scan(onProgress, opts) {
    if (!activeLib) throw new Error('尚未选择资源库');
    const libId = activeId;
    const refresh = !!(opts && opts.refresh);

    /* 服务器模式：目录在跑服务的那台机器上，问它要列表 */
    if (mode === 'server') {
      const res = await apiFetch('/api/scan' + (refresh ? '?refresh=1' : ''), { cache: 'no-store' });
      if (!res.ok) throw new Error(U.NET_FAIL);
      const data = await res.json();
      if (onProgress) onProgress({ phase: 'size', done: data.files.length, total: data.files.length });
      /* root 用服务端回的真实路径：albumMeta 的键是「<路径>|<专辑id>」，和桌面端要对得上。
         scannedAt 也要带上：它是「谁、什么时候扫的」那个时间戳，客户端拿它和服务端的
         /api/scan/at 比，不能换成客户端本地时间（两边时钟一歪就永远比不对） */
      /* 老服务端不返回这个字段：留 undefined，别当成「明确的一层口径」，
         否则 build 会以为分组方式变了，把两层时代建的分类归属当成旧数据清掉 */
      const dirGroup = (data.dirGroup === undefined) ? undefined : !!data.dirGroup;
      if (dirGroup !== undefined) activeLib.dirGroup = dirGroup;
      /* stale：服务端等了 2 分钟还没扫完，先把上次的缓存给我们看，
         它那边还在后台接着扫，扫完落盘后 scannedAt 会变，下次能同步到 */
      return {
        libId, rootName: data.rootName || activeLib.name, root: data.root || 'server', mode,
        files: data.files, scannedAt: Number(data.scannedAt) || 0, dirGroup,
        stale: !!data.stale
      };
    }

    /* 桌面模式：交给主进程读盘，速度更快且无授权问题 */
    if (mode === 'desktop') {
      if (onProgress) onProgress({ phase: 'list', count: 0 });
      const res = await window.fmNative.scan(refresh);
      if (onProgress) onProgress({ phase: 'size', done: res.files.length, total: res.files.length });
      /* 同上：老主进程/preload 没有这个字段时保留 undefined */
      const dirGroup = (res.dirGroup === undefined) ? undefined : !!res.dirGroup;
      if (dirGroup !== undefined) activeLib.dirGroup = dirGroup;
      return {
        libId, rootName: res.rootName || activeLib.name, root: res.root, mode,
        files: res.files, scannedAt: Number(res.scannedAt) || 0, dirGroup,
        stale: !!res.stale
      };
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
      dirGroup: !!activeLib.dirGroup,
      files: items.map(function (it) {
        return { rel: it.rel, name: it.name, ext: it.ext, size: it.size, mtime: it.mtime, depth: it.depth };
      })
    };
  }

  /* 服务端扫描缓存的时间戳（只有一行 settings，很便宜）。
     手机端没有「重新扫描」入口，靠它判断主机上是不是有人扫过更新的结果 */
  async function scanStamp() {
    if (mode !== 'server') return 0;
    try {
      const res = await apiFetch('/api/scan/at', { cache: 'no-store' });
      if (!res.ok) return 0;
      const j = await res.json();
      return Number(j && j.scannedAt) || 0;
    } catch (e) { return 0; }
  }

  /* ── 取文件 ── */
  /* 桌面模式：直接给 fm:// 流式地址，由主进程按 Range 读盘，不整本读进内存 */
  function mediaUrl(rel) {
    return 'fm://app/__media/' + rel.split('/').map(encodeURIComponent).join('/');
  }

  function extOf(rel) {
    const s = String(rel || '');
    const dot = s.lastIndexOf('.');
    return dot < 0 ? '' : s.slice(dot + 1).toLowerCase();
  }

  /* 转码失败要能被界面区分开：带 code 的 Error
     （no-ffmpeg / ffmpeg-failed / bad-format / busy / no-encoder / aborted） */
  function tcError(code, message) {
    const e = new Error(message || '转换失败');
    e.code = code || 'ffmpeg-failed';
    return e;
  }

  /* ── 转码：Chromium 解不了的格式先转成 mp3 / mp4 再播 ──
     只有桌面本地库（IPC）和服务器模式（HTTP）能转，纯浏览器本地目录没有 ffmpeg。
     成功返回 { url, ext, cached }，不需要转码时返回 null。
     opts.signal 用来取消：用户切到别的集时，上一个文件就别再转了。 */
  let tcSeq = 0;

  async function prepare(rel, opts) {
    if (!FM.media.needsTranscode(extOf(rel))) return null;
    const signal = opts && opts.signal;
    if (signal && signal.aborted) throw tcError('aborted');
    if (mode === 'desktop' && window.fmNative && window.fmNative.prepare) {
      /* IPC 本身没法取消，只能带个 id 过去：切集时再发一条 cancel 让主进程停掉 ffmpeg */
      const id = 'tc' + (++tcSeq);
      const onAbort = function () {
        if (window.fmNative.cancelPrepare) window.fmNative.cancelPrepare(id);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      let r;
      try {
        r = await window.fmNative.prepare(rel, id);
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      if (signal && signal.aborted) throw tcError('aborted');
      if (!r) throw tcError('ffmpeg-failed');
      if (r.error) throw tcError(r.error, r.message);
      return r;
    }
    if (mode === 'server') {
      let res;
      try {
        res = await apiFetch('/api/prepare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rel: rel }),
          signal: signal
        });
      } catch (e) {
        /* fetch 的取消会抛 AbortError，统一换成带 code 的 tcError，上层不用关心细节 */
        if (e && e.name === 'AbortError') throw tcError('aborted');
        throw e;
      }
      if (!res.ok) {
        let txt = '';
        try { txt = (await res.text()).trim(); } catch (e) {}
        /* 501 = 服务器上没装 ffmpeg；429 = 切集太快被限流（一秒 5 次）。
           这两种都不是「文件坏了」，文案要分开，别让用户去查文件 */
        if (res.status === 429) throw tcError('busy', txt);
        throw tcError(res.status === 501 ? 'no-ffmpeg' : (/^(ffmpeg-failed|bad-format)$/.test(txt) ? txt : 'ffmpeg-failed'), txt);
      }
      const data = await res.json();
      /* <audio>/<video> 带不了请求头：桌面远程模式要靠票据挂在 query 上 */
      return { url: await signedUrl(data.url), ext: data.ext, cached: !!data.cached };
    }
    /* 走到这里说明确实需要转码，但当前是纯浏览器目录（files / handle）——没有 ffmpeg。
       给个能指向出路的错误，别让它一路走到 <audio> 才报「播放失败」。 */
    throw tcError('no-encoder');
  }

  /* ── 时长：只读文件头，不转码（转码格式的曲目靠它拿时长）── */
  async function duration(rel) {
    try {
      if (mode === 'desktop' && window.fmNative && window.fmNative.probeDur) {
        return Number(await window.fmNative.probeDur(rel)) || 0;
      }
      if (mode === 'server') {
        const r = await apiFetch('/api/duration?rel=' + encodeURIComponent(rel), { cache: 'no-store' });
        if (!r.ok) return 0;
        const j = await r.json();
        return Number(j && j.d) || 0;
      }
    } catch (e) {}
    return 0;
  }

  async function src(rel, opts) {
    /* 需要转码的格式只在显式要求时才转：ui.js 的时长探测也会调 src()，
       默认转码会让「打开一张 wma 专辑」并发转几十集。 */
    if (opts && opts.prepare) {
      const tc = await prepare(rel, { signal: opts.signal });
      if (tc && tc.url) return { url: tc.url, revoke: null, transcoded: true };
    }
    /* 安卓壳：已下载的曲目优先播本机 127.0.0.1 文件，不直连服务器、不耗流量 */
    if (APP && FM.android && FM.android.downloaded && FM.android.downloaded(rel)) {
      const local = FM.android.localUrl ? FM.android.localUrl(rel) : '';
      if (local) return { url: local, revoke: null };
    }
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
    load, add, activate, remove, rename, relocate, openLib, pullMeta, pushMeta, flushMeta, canSyncMeta, pushProgress, refreshLibs,
    setDirGroup,
    loadFavs, setFav, setFavTrack,
    scan, scanStamp, getFile, src, prepare, duration, grant, adoptFiles, supportsPicker,
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
    get favIds() { return favSet; },
    get favTrackIds() { return trackFavSet; },
    get version() { return serverVersion; },
    get mode() { return mode; },
    get rootName() { return activeLib ? activeLib.name : ''; },
    get granted() { return granted; },
    get hasSource() { return !!activeLib; }
  };
})(window.FM);
