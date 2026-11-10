/* ── covers.js · 专辑封面 ───────────────────────────────
 *
 * 封面由 cover-fetch.js 抓取（帆书官方 → 豆瓣 → 喜马拉雅），存在库根目录下的 .fm-covers/。
 * 这里只负责读那份索引、把封面地址挂到专辑上：目录名完全一致就直接用；
 * 换了名字的同名专辑（比如多了「完结」「高清」这类后缀）按相似度复用同一张图。
 */
(function (FM) {
  'use strict';

  const DIR = '.fm-covers';
  const THRESHOLD = 0.8;        // 相似度低于这个就不硬套，宁可继续用渐变封面

  let raw = null;               // 原始索引：目录名 -> { file, title, albumId, score }
  let urlOf = new Map();        // 目录名 -> <img> 能直接用的地址
  let index = [];               // [{ key, norm, url }]
  let cache = new Map();
  let coverVer = new Map();     // 目录名 -> 换图版本号（加在 URL 上，逼浏览器重新取图）
  let loadedLib = '';           // coverVer 属于哪个库：换库要清空，否则同名目录会带上别的库的版本号
  let loaded = false;
  let blobRevs = [];            // 当前 urlOf 里那批 blob URL 的回收函数

  /* blob URL 不能立刻回收：DOM 里可能还挂着上一轮的地址。延迟 60 秒，
     足够界面完成一次 apply / render，又不至于反复 load 时无限累积。 */
  function scheduleRevoke(list) {
    if (!list || !list.length) return;
    setTimeout(function () {
      list.forEach(function (fn) { try { fn(); } catch (e) {} });
    }, 60000);
  }

  /* 只留字母数字，书名里的书名号、空格、感叹号、竖线都不参与比较 */
  function norm(s) {
    const m = String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu);
    return m ? m.join('') : '';
  }

  function bigrams(s) {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    if (s.length === 1) set.add(s);
    return set;
  }

  function dice(a, b) {
    const A = bigrams(a), B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let hit = 0;
    A.forEach(function (x) { if (B.has(x)) hit++; });
    return (2 * hit) / (A.size + B.size);
  }

  function similar(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    /* 一方完整包含另一方（常见于「……全集」「……完结」这种后缀），直接算高度相似 */
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return Math.min(a.length, b.length) / Math.max(a.length, b.length) > 0.45 ? 0.92 : 0.6;
    return dice(a, b);
  }

  /* libId 不给就落到当前库 */
  function urlFor(file, libId) {
    /* 桌面端封面地址必须带库：文件名可能两库相同（早期数据的文件名只有目录哈希），
       不带库时主进程按「当前库」解析，切库后同 URL 会直接命中浏览器缓存拿到旧库的图 */
    if (FM.fs.native) {
      const lib = libId === undefined ? (FM.fs.activeId || '') : libId;
      return 'fm://app/__cover/' + encodeURIComponent(file) + (lib ? '?lib=' + encodeURIComponent(lib) : '');
    }
    return null;
  }

  /* libId 不给就读当前库（沿用原来的行为） */
  async function readIndex(libId) {
    const id = libId === undefined ? (FM.fs.activeId || '') : libId;
    if (FM.fs.server) {
      try {
        const q = libId === undefined ? '' : '?libId=' + encodeURIComponent(id);
        const r = await FM.fs.apiFetch('/api/covers' + q, { cache: 'no-store' });
        return r.ok ? await r.json() : null;
      } catch (e) { return null; }
    }
    if (FM.fs.native) {
      /* 带上库：主进程的「当前库」可能已经被另一次切库改掉了 */
      try { return await window.fmNative.covers(id); } catch (e) { return null; }
    }
    /* 纯网页本地目录：目录句柄只对当前库有效，别的库读不到 */
    if (libId !== undefined) return null;
    try {
      const f = await FM.fs.getFile(DIR + '/covers.json');
      return JSON.parse(await f.text());
    } catch (e) { return null; }
  }

  /* 网页版没有自定义协议，只能把图片读成 blob URL。
     每个 URL 都把回收函数带出来，否则重读索引时旧 URL 全泄漏。 */
  async function blobUrls(entries) {
    const out = new Map();
    const revs = [];
    const list = entries.slice();
    let cursor = 0;
    async function worker() {
      while (cursor < list.length) {
        const e = list[cursor++];
        try {
          const r = await FM.fs.src(DIR + '/' + e.file);
          if (r && r.url) out.set(e.key, r.url);
          if (r && r.revoke) revs.push(r.revoke);
        } catch (err) {}
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(6, list.length); i++) workers.push(worker());
    await Promise.all(workers);
    return { map: out, revs: revs };
  }

  async function load() {
    /* 记下开始时的库：切库瞬间可能有两次 load 交错，后回来的旧库结果不能盖掉新库那份 */
    const wantLib = FM.fs.activeId || '';
    const got = await readIndex();
    if (wantLib !== (FM.fs.activeId || '')) return 0;   /* 期间切库了，这批索引直接丢掉 */
    raw = got;
    loaded = true;
    /* 换了库：版本号（换图 cache bust）没有意义了，同名目录会带上别的库的版本 */
    if (wantLib !== loadedLib) { coverVer = new Map(); loadedLib = wantLib; }
    const oldRevs = blobRevs;
    blobRevs = [];
    urlOf = new Map();
    index = [];
    /* 索引读不出来（目录暂时不可访问等）就保留上一轮的 URL，别把还能显示的封面回收了 */
    if (!raw || typeof raw !== 'object') { blobRevs = oldRevs; return 0; }

    const entries = Object.keys(raw)
      .filter(function (k) { return raw[k] && raw[k].file; })
      .map(function (k) { return { key: k, file: raw[k].file, norm: norm(k) }; });

    if (FM.fs.server) {
      /* 远端封面要走签名 URL（<img> 带不了 Authorization 头） */
      for (const e of entries) {
        try { urlOf.set(e.key, await FM.fs.signedUrl('/api/cover/' + encodeURIComponent(e.file))); } catch (err) {}
      }
    } else if (FM.fs.native) {
      entries.forEach(function (e) { urlOf.set(e.key, urlFor(e.file)); });
    } else {
      const got = await blobUrls(entries);
      urlOf = got.map;
      blobRevs = got.revs;
    }
    entries.forEach(function (e) {
      const url = urlOf.get(e.key);
      if (url) index.push({ key: e.key, norm: e.norm, url: url });
    });
    cache = new Map();
    scheduleRevoke(oldRevs);
    /* 这个库现在是当前库了：ext 里那份按库存的副本作废，免得日后它又变成「别的库」时用旧的 */
    ext.delete(wantLib);
    extFailAt.delete(wantLib);
    return index.length;
  }

  /* 在一份封面索引里找：先精确对目录名，再按相似度找最像的那张。
     索引可以是当前库，也可以是别的库（见下面的 ext），所以三者都当参数传 */
  function pick(uris, list, hitCache, album) {
    if (!album || !list.length) return null;
    const key = album.dirName || album.key;
    if (!key) return null;
    if (hitCache.has(key)) return hitCache.get(key);

    let url = null;
    if (uris.has(key)) {
      url = uris.get(key);
    } else {
      const target = norm(key);
      let bestUrl = null, bestScore = 0;
      for (let i = 0; i < list.length; i++) {
        const s = similar(target, list[i].norm);
        if (s > bestScore) { bestScore = s; bestUrl = list[i].url; }
      }
      if (bestScore >= THRESHOLD) url = bestUrl;
    }
    hitCache.set(key, url);
    return url;
  }

  /* 给一个专辑找封面 */
  function of(album) { return pick(urlOf, index, cache, album); }

  /* ── 跨库封面 ──
     搜索结果会把别的资源库的专辑一起列出来，那些对象来自 index:<libId> 缓存，没有 cover 字段。
     这里按库另存一份索引（第一次搜到该库时读一次），界面用 forAlbum() 现查。
     读失败（库不可用 / 没权限）记 60 秒，免得每敲一个字都重试一遍。 */
  const EXT_RETRY = 60000;
  const ext = new Map();        // libId -> { urlOf, index, cache }
  const extBusy = new Map();    // libId -> 正在读的 Promise
  const extFailAt = new Map();  // libId -> 上次失败的时间

  async function loadLib(id) {
    const got = await readIndex(id);
    /* 读盘期间切库了也没关系：这份索引按 libId 存，不会盖掉别人的 */
    if (!got || typeof got !== 'object') return false;
    const entries = Object.keys(got)
      .filter(function (k) { return got[k] && got[k].file; })
      .map(function (k) { return { key: k, file: got[k].file, norm: norm(k) }; });
    if (!entries.length) return false;

    const uris = new Map();
    if (FM.fs.native) {
      entries.forEach(function (e) { uris.set(e.key, urlFor(e.file, id)); });
    } else if (FM.fs.server) {
      /* 服务端按 query 里的 libId 定位库，和当前库同一套签名地址 */
      for (const e of entries) {
        try { uris.set(e.key, await FM.fs.signedUrl('/api/cover/' + encodeURIComponent(e.file), id)); } catch (err) {}
      }
    } else {
      return false;
    }
    const list = entries
      .filter(function (e) { return uris.get(e.key); })
      .map(function (e) { return { key: e.key, norm: e.norm, url: uris.get(e.key) }; });
    if (!list.length) return false;
    ext.set(id, { urlOf: uris, index: list, cache: new Map() });
    return true;
  }

  /* 按需加载某个库的封面索引；true = 这次刚读到（调用方据此补一次静默重绘） */
  function ensureLib(libId) {
    const id = String(libId || '');
    if (!id || id === (FM.fs.activeId || '')) return Promise.resolve(false);
    if (ext.has(id)) return Promise.resolve(false);
    const failed = extFailAt.get(id);
    if (failed && Date.now() - failed < EXT_RETRY) return Promise.resolve(false);
    let p = extBusy.get(id);
    if (p) return p.then(function () { return false; });
    p = loadLib(id).then(function (ok) {
      extBusy.delete(id);
      if (ok) extFailAt.delete(id); else extFailAt.set(id, Date.now());
      return ok;
    }, function () {
      extBusy.delete(id);
      extFailAt.set(id, Date.now());
      return false;
    });
    extBusy.set(id, p);
    return p;
  }

  /* 别的库的专辑 → 封面地址。当前库直接返回 null，调用方本来就用 a.cover */
  function forAlbum(album, libId) {
    const id = String(libId || '');
    if (!id || id === (FM.fs.activeId || '')) return null;
    const st = ext.get(id);
    if (!st) return null;
    return pick(st.urlOf, st.index, st.cache, album);
  }

  function apply() {
    if (!FM.lib || !FM.lib.albums) return 0;
    let n = 0;
    FM.lib.albums().forEach(function (a) {
      const key = a.dirName || a.key;
      let url = of(a);
      /* 换图后文件名可能没变（旧版后端是覆盖同名文件），加个版本参数逼浏览器重新取图 */
      const v = coverVer.get(key);
      if (url && v) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'r=' + v;
      a.cover = url || null;
      if (url) n++;
    });
    return n;
  }

  /* ── 手动编辑封面：搜索候选 / 保存 / 删除，都在用户点「保存」后才落盘 ── */

  /* 站内搜索很宽松：后端若是旧版（原样返回前几条），客户端再按关键词兜一层 */
  function keyOf(s) {
    const m = String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu);
    return m ? m.join('') : '';
  }
  function grams(s) {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    if (s.length === 1) set.add(s);
    return set;
  }
  function titleScore(kw, title) {
    const a = keyOf(kw), b = keyOf(title);
    if (!a || !b) return 0;
    if (b.indexOf(a) >= 0) return 0.95;
    /* 关键词里某个词（>=2 字、非纯数字）整段出现在标题里，也算匹配 */
    const tokens = String(kw || '').split(/[\s：:，,、·\-_/]+/)
      .map(keyOf).filter(function (t) { return t.length >= 2 && /[^\d]/.test(t); });
    for (let i = 0; i < tokens.length; i++) if (b.indexOf(tokens[i]) >= 0) return 0.85;
    const A = grams(a), B = grams(b);
    if (!A.size || !B.size) return 0;
    let hit = 0;
    A.forEach(function (x) { if (B.has(x)) hit++; });
    return (2 * hit) / (A.size + B.size);
  }
  function filterCandidates(list, kw, limit) {
    const n = limit || 8;
    if (!list || !list.length) return [];
    /* 新版后端已经带 score 并筛过，直接用；百度来源按图搜词，不做标题过滤；旧版没 score 才客户端筛 */
    if (list.every(function (c) { return c.source === 'baidu'; })) return list.slice(0, n);
    if (list.some(function (c) { return typeof c.score === 'number'; })) return list.slice(0, n);
    const scored = list.map(function (c) { return { c: c, s: titleScore(kw, c.title) }; })
      .filter(function (x) { return x.s >= 0.5; });
    scored.sort(function (x, y) { return y.s - x.s; });
    return scored.slice(0, n).map(function (x) { return x.c; });
  }

  /* opts = { page, seed, limit }：page 从 0 开始翻页，seed 非 0 时后端会打散同分档（换一换）
     失败原因记到 lastError 里：界面 toast 要能说出到底是 403、服务端没重启，还是网络不通 */
  let lastError = '';
  async function search(title, opts) {
    const o = opts || {};
    const limit = Math.max(1, Math.min(24, Number(o.limit) || 8));
    const page = Math.max(0, Math.min(20, Number(o.page) || 0));
    const seed = Math.abs(Number(o.seed) || 0);
    lastError = '';
    try {
      if (FM.fs.native && window.fmNative && window.fmNative.searchCover) {
        return filterCandidates((await window.fmNative.searchCover(title, { page: page, seed: seed, limit: limit })) || [], title, limit);
      }
      if (FM.fs.server) {
        const r = await FM.fs.apiFetch('/api/covers/search?q=' + encodeURIComponent(title || '')
          + '&page=' + page + '&limit=' + limit + '&seed=' + seed);
        if (!r) { lastError = '服务端无响应'; return []; }
        if (!r.ok) {
          lastError = '服务端返回 ' + r.status
            + (r.status === 403 ? '（需要管理员登录）' : r.status === 404 ? '（服务端可能是旧版本，重启 serve.js 再试）' : '');
          return [];
        }
        return filterCandidates((await r.json()) || [], title, limit);
      }
      lastError = FM.fs.native ? '请重启应用（搜索接口未加载）' : '当前模式不支持搜图';
    } catch (e) {
      lastError = String((e && e.message) || e || '请求失败');
      console.warn('[covers] 搜索失败', e);
    }
    return [];
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ── 写盘（不重读索引）──
     批量补封面时不能每张都 load()：网页端每次 load() 都要为全部封面重新取签名 URL，
     几十张就会退化成 O(n²)。这里只管把一张图落盘，由调用方决定什么时候刷新索引。 */
  async function writeCover(album, payload, libId) {
    const dirName = album && (album.dirName || album.key);
    if (!dirName || !payload) return { ok: false, reason: '缺少专辑目录或图片' };
    /* 绑定发起时的库：批量写入是逐张 await 的，中途切库后剩下的请求
       不能按新库定位 —— 否则会把这一库的封面写到另一个库的同名目录里 */
    const lib = libId || FM.fs.activeId || '';
    /* 先记版本：保存成功的 fm:covers 事件会立刻 apply()，得让它用带版本的新 URL；
       保存失败也无害（文件没变，重新取到的还是旧图）。
       已经切走了就别写：版本表是当前库的，记进去会把新库的同名专辑顶成旧图 */
    if (!lib || lib === (FM.fs.activeId || '')) coverVer.set(dirName, Date.now());
    if (FM.fs.native) {
      if (!window.fmNative || !window.fmNative.saveCover) return { ok: false, reason: '请重启应用（封面写入未加载）' };
      try {
        const entry = await window.fmNative.saveCover(dirName, payload, lib);
        if (!entry) return { ok: false, reason: '本地写入失败' };
        if (entry.error) return { ok: false, reason: entry.error };
      } catch (e) { console.warn('[covers] 保存失败', e); return { ok: false, reason: '本地写入异常' }; }
      return { ok: true };
    }
    if (!FM.fs.server) return { ok: false, reason: '当前模式不支持' };
    /* 网页端服务端有写接口限流（同 IP 每秒 10 次）：批量写入撞上 429 时退避一次再试 */
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const headers = { 'content-type': 'application/json' };
        if (lib) headers['x-fm-lib'] = lib;
        const r = await FM.fs.apiFetch('/api/cover', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ dirName: dirName, payload: payload })
        });
        if (r && r.ok) return { ok: true };
        if (r && r.status === 429 && attempt === 0) { await sleep(400); continue; }
        /* 服务端会把具体原因放在 body.reason（例如 EACCES 的权限说明）：有就直接说给用户听 */
        let detail = '';
        if (r && r.json) { try { const j = await r.json(); detail = (j && j.reason) || ''; } catch (e) {} }
        if (detail) return { ok: false, reason: detail };
        return { ok: false, reason: '服务端返回 ' + (r ? r.status : '无响应') + '（服务端可能是旧版本，重启 serve.js / 更新 APK）' };
      } catch (e) { console.warn('[covers] 保存失败', e); return { ok: false, reason: '服务端请求失败' }; }
    }
    return { ok: false, reason: '服务端限流，请稍后重试' };
  }

  /* 失败时返回 { ok:false, reason }：界面要把原因说出来，否则只会看到「保存失败」 */
  async function save(album, payload) {
    const lib = FM.fs.activeId || '';
    const res = await writeCover(album, payload, lib);
    if (!res.ok) return res;
    await load();
    apply();
    return { ok: true };
  }

  /* 只写盘、不刷新索引：批量抓取时逐张自动写入，最后统一 reload() */
  async function saveOne(album, payload, libId) {
    return writeCover(album, payload, libId || FM.fs.activeId || '');
  }

  /* 批量写入：items = [{ album, payload }]，顺序执行（避免把服务端限流打满），
     结束只 load + apply 一次；单张失败不影响其余条目。 */
  let batchDepth = 0;
  function beginBatch() { batchDepth++; }
  function endBatch() { if (batchDepth > 0) batchDepth--; }

  async function saveMany(items, onProgress) {
    const list = Array.isArray(items) ? items : [];
    /* 整批绑定同一个库：这批是用户在某个库里挑的，写盘期间切库也不能改投别处 */
    const lib = FM.fs.activeId || '';
    let ok = 0;
    const failed = [];
    beginBatch();
    try {
      for (let i = 0; i < list.length; i++) {
        const it = list[i] || {};
        const res = await writeCover(it.album, it.payload, lib);
        if (res.ok) ok++; else failed.push({ album: it.album, reason: res.reason });
        if (FM.fs.server) await sleep(120);       /* 错开限流窗口 */
        if (onProgress) { try { onProgress(ok, failed.length, i + 1, list.length); } catch (e) {} }
      }
    } finally {
      endBatch();
    }
    if (ok) { await load(); apply(); }
    return { ok: ok, failed: failed };
  }

  function reload() {
    return load().then(function (n) { apply(); return n; });
  }

  async function remove(album) {
    const dirName = album && (album.dirName || album.key);
    if (!dirName) return { ok: false, reason: '缺少专辑目录' };
    /* 同 writeCover：删除也要落到这个小封面所在的库 */
    const lib = FM.fs.activeId || '';
    if (FM.fs.native) {
      if (!window.fmNative || !window.fmNative.deleteCover) return { ok: false, reason: '请重启应用（封面写入未加载）' };
      try {
        if (!await window.fmNative.deleteCover(dirName, lib)) return { ok: false, reason: '本地删除失败' };
      } catch (e) { console.warn('[covers] 删除失败', e); return { ok: false, reason: '本地删除异常' }; }
    } else if (FM.fs.server) {
      try {
        const headers = {};
        if (lib) headers['x-fm-lib'] = lib;
        const r = await FM.fs.apiFetch('/api/cover?dir=' + encodeURIComponent(dirName), { method: 'DELETE', headers: headers });
        if (!r || !r.ok) return { ok: false, reason: '服务端返回 ' + (r ? r.status : '无响应') };
      } catch (e) { console.warn('[covers] 删除失败', e); return { ok: false, reason: '服务端请求失败' }; }
    } else {
      return { ok: false, reason: '当前模式不支持' };
    }
    coverVer.delete(dirName);            // 删掉封面后不要再带旧的版本参数
    await load();
    apply();
    return { ok: true };
  }

  FM.covers = {
    load, apply, of, search, save, remove, reload, saveOne, saveMany, beginBatch, endBatch,
    /* 跨库搜索：别的库的专辑封面按需加载（见 ext） */
    ensureLib, forAlbum,
    get ready() { return loaded; },
    get count() { return index.length; },
    get searchError() { return lastError; },
    /* 批量写入期间为 true：桌面端每张封面都会推 fm:covers 事件，回调里据此跳过整页刷新 */
    get batching() { return batchDepth > 0; }
  };
})(window.FM);
