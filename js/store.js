/* ── store.js ────────────────────────────────────────── */
(function (FM) {
  'use strict';
  const P = 'fm:v1:';
  let cache = Object.create(null);
  const dirty = new Set();
  let brokenNotified = false;
  let onBroken = null;

  /* 写不进去（配额满 / 隐私模式）时通知一次：进度和分类不能悄悄丢在控制台里，
     用户完全无感。一次会话只叫一次，清完缓存后由 resetBroken 复位。 */
  function markBroken(where, e, kind) {
    console.warn('[store] 写入失败（' + (kind || 'user') + '）', where, e);
    if (brokenNotified) return;
    brokenNotified = true;
    try { if (onBroken) onBroken(e, kind || 'user'); } catch (e2) {}
  }

  function isQuotaErr(e) {
    if (!e) return false;
    return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      e.code === 22 || e.code === 1014;
  }

  /* 索引是可重建数据：写不下就丢弃重扫；进度 / 分类 / 收藏丢了补不回来，
     值得多试几轮（用户可能正在清缓存腾地方） */
  function isIndexShaped(k) { return k === 'index' || k.indexOf('index:') === 0; }

  /* 命名空间：浏览器直连服务器时按用户隔离本地缓存（fm:v1:<uid>:*）。
     从服务端种下的 fm_uid cookie 同步读取，避免异步竞态。桌面/本地模式为空。 */
  const ns = (function () {
    try {
      const m = String(document.cookie || '').match(/(?:^|; )fm_uid=([^;]*)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  })();
  function FQ(k) { return P + (ns ? ns + ':' : '') + k; }

  function read(key, def) {
    if (key in cache) return cache[key];
    let val = def;
    try {
      const raw = localStorage.getItem(FQ(key));
      if (raw) val = JSON.parse(raw);
    } catch (e) {
      console.warn('[store] 读取失败', key, e);
    }
    cache[key] = val;
    return val;
  }

  function touch(key) { if (key) dirty.add(key); }

  /* 丢掉一份缓存（移除资源库时清索引，别把陈年数据留在本机） */
  function drop(key) {
    delete cache[key];
    dirty.delete(key);
    try { localStorage.removeItem(FQ(key)); } catch (e) {}
  }

  function write(key, val) { cache[key] = val; dirty.add(key); }

  let onPersist = null;

  /* 失败计数：配额满时不能每 1.5s 无休止重试同一份进度（几 MB 的 JSON.stringify 很贵），
     也不能像以前那样一次失败就把整批脏键清空 —— 索引写不下不该连累同批的分类和进度 */
  const retries = Object.create(null);
  const MAX_RETRY = 3;

  function flush() {
    if (!dirty.size) return;
    const keys = Array.from(dirty);
    keys.forEach(function (k) {
      try {
        localStorage.setItem(FQ(k), JSON.stringify(cache[k]));
        delete retries[k];
        dirty.delete(k);
      } catch (e) {
        const indexLike = isIndexShaped(k);
        const n = (retries[k] = (retries[k] || 0) + 1);
        /* 索引：放弃落盘（下次扫描会重建）；用户数据：留着重试，攒够次数才放手 */
        if (indexLike || !isQuotaErr(e) || n >= MAX_RETRY) {
          dirty.delete(k);
          delete retries[k];
        }
        markBroken(k, e, indexLike ? 'index' : 'user');
      }
    });
    if (onPersist) { try { onPersist(keys); } catch (e) {} }
  }

  setInterval(flush, 1500);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });

  /* ── 清理本机索引缓存 ──
     只丢「丢了也能重建」的扫描结果（index / index:<libId>）：分类 / 进度 / 收藏 /
     时长 / 设置 / lastLib 一件都不动，那些是用户数据，丢了补不回来。
     indexMode:<libId> 留着 —— 几百字节的小键，决定下次扫描的分组口径，
     清了要多一次误分组的风险，不值当。
     归属判定：自己的短名 / 登录前的无前缀孤儿（同样可清，登录后永远读不到）/
     别人的命名空间（u_xxx:，一律不碰）。短名 '' 表示这个键不归我们管。 */
  function indexCacheKey(full) {
    if (!full || full.indexOf(P) !== 0) return '';
    const rest = full.slice(P.length);
    let k;
    if (ns && rest.indexOf(ns + ':') === 0) k = rest.slice(ns.length + 1);
    else if (rest.indexOf('index') === 0) k = rest;   /* 无前缀孤儿：登录前留下的 */
    else return '';
    return (k === 'index' || k.indexOf('index:') === 0) ? k : '';
  }

  /* 返回 [{ full, name }]：full 用于真正删除 —— 孤儿键没有当前命名空间前缀，
     再走 drop(name) 会把同名库的现行缓存删掉，留下孤儿的罪魁就是这么来的；
     name 只在属于当前命名空间时才有值，用来同步清内存 cache */
  function indexCacheKeys(withSize) {
    const keys = [];
    let chars = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const full = localStorage.key(i);
        const k = indexCacheKey(full);
        if (!k) continue;
        const own = !ns || full.indexOf(P + ns + ':') === 0;
        keys.push({ full: full, name: own ? k : '' });
        if (!withSize) continue;
        try { chars += full.length + String(localStorage.getItem(full) || '').length; } catch (e) {}
      }
    } catch (e) { console.warn('[store] 统计缓存失败', e); }
    /* 配额按 UTF-16 计（每字符 2 字节），乘 2 才是实际占用 */
    return { keys: keys, bytes: chars * 2 };
  }

  /* 缓存管理弹窗用：每份索引的明细（体积 / 扫描时间 / 规模）。
     体积和规模都得读整份值，所以只在用户点开弹窗时调用，菜单展开路径别碰 */
  function indexCacheItems() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const full = localStorage.key(i);
        const k = indexCacheKey(full);
        if (!k) continue;
        const own = !ns || full.indexOf(P + ns + ':') === 0;
        let raw = '';
        try { raw = String(localStorage.getItem(full) || ''); } catch (e) {}
        let meta = null;
        if (raw) { try { meta = JSON.parse(raw); } catch (e) {} }
        out.push({
          full: full,
          name: own ? k : '',
          libId: k.indexOf('index:') === 0 ? k.slice(6) : '',
          bytes: (full.length + raw.length) * 2,
          /* ok=false：值在但解析不出来（写入被截断 / 老格式），界面提示建议清除 */
          ok: !!meta,
          scannedAt: Number(meta && meta.scannedAt) || 0,
          albums: (meta && meta.albums && meta.albums.length) || 0,
          tracks: (meta && meta.tracks && meta.tracks.length) || 0,
          /* 这份索引是按哪种目录口径扫的：flat / cat / auto，老缓存里只有布尔 dirGroup */
          dirMode: !meta ? '' : (meta.dirMode === 'cat' || meta.dirMode === 'auto' || meta.dirMode === 'flat'
            ? meta.dirMode : (meta.dirGroup ? 'cat' : 'flat'))
        });
      }
    } catch (e) { console.warn('[store] 读取缓存明细失败', e); }
    return out;
  }

  /* 按 full 键清一份（full 来自 indexCacheItems）：孤儿键没有当前命名空间前缀，
     再走 drop(name) 会误删同名库的现行缓存，所以删除走 full，内存缓存只清自己那份 */
  function clearIndexCacheItem(full) {
    const k = indexCacheKey(full);
    if (!k) return 0;
    let chars = 0;
    try {
      chars = full.length + String(localStorage.getItem(full) || '').length;
      localStorage.removeItem(full);
    } catch (e) { console.warn('[store] 清理索引缓存失败', full, e); }
    if (!ns || full.indexOf(P + ns + ':') === 0) { delete cache[k]; dirty.delete(k); }
    return chars * 2;
  }

  function clearIndexCache() {
    const s = indexCacheKeys(true);
    s.keys.forEach(function (it) { clearIndexCacheItem(it.full); });
    return { count: s.keys.length, bytes: s.bytes };
  }

  /* 登录前留下的无前缀索引：登录后按 fm:v1:<uid>:* 读，永远读不到它们，只白占配额
     （实测能占到总占用的六成以上）。索引是可重建数据，直接丢掉。
     indexMode:* 只有几十字节、决定下次扫描的分组口径，搬家而不是删除，免得重扫时误分组。
     分类 / 进度 / 收藏 / albumMeta 一律不动 —— 那些删了补不回来。 */
  function purgeOrphanIndexCache() {
    if (!ns) return { count: 0, bytes: 0 };
    const list = [];
    let chars = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const full = localStorage.key(i);
        if (!full || full.indexOf(P) !== 0) continue;
        if (full.slice(P.length).indexOf('index:') !== 0) continue;
        list.push(full);
        chars += full.length + String(localStorage.getItem(full) || '').length;
      }
    } catch (e) { console.warn('[store] 查找旧索引失败', e); return { count: 0, bytes: 0 }; }
    list.forEach(function (full) {
      const libId = full.slice((P + 'index:').length);
      const modeOld = P + 'indexMode:' + libId;
      const modeNew = FQ('indexMode:' + libId);
      try {
        const mv = localStorage.getItem(modeOld);
        if (mv && !localStorage.getItem(modeNew)) localStorage.setItem(modeNew, mv);
        localStorage.removeItem(modeOld);
        localStorage.removeItem(full);
      } catch (e) { console.warn('[store] 清理旧索引失败', full, e); }
    });
    if (list.length) {
      console.info('[store] 已清理登录前遗留的索引 ' + list.length + ' 份（约 ' +
        (chars * 2 / 1048576).toFixed(1) + ' MB），下次进库会重新扫描');
    }
    return { count: list.length, bytes: chars * 2 };
  }
  purgeOrphanIndexCache();

  /* 清完探一次：还写不进去说明不是这份索引撑爆的（磁盘满 / 隐私模式），别给用户假希望 */
  function probe() {
    try {
      const k = FQ('__probe');
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }

  /* 清理成功后再写失败要能重新提醒一次，否则用户以为已经好了 */
  function resetBroken() { brokenNotified = false; }

  /* ── 索引落盘：直接试写，不猜配额 ──
     之前用「固定 5 MB - 已用字符数」预估，两个变量都不可靠：WebView 的实际配额和
     Chromium 桌面不一定一样，读不到时又被当成「没有余量」，结果 200k 的小索引也被判死。
     setItem 自己抛的 QuotaExceededError 才是唯一可靠的判据，所以就地写一次。 */
  function tryWriteIndex(id, v) {
    if (!id) return { ok: true, chars: 0 };
    const key = 'index:' + id;
    let json = null;
    try { json = JSON.stringify(v); } catch (e) { json = null; }
    const chars = json ? json.length : 0;
    if (json != null) {
      try {
        localStorage.setItem(FQ(key), json);
        cache[key] = v;
        dirty.delete(key);
        writeIndexMode(id, v);
        return { ok: true, chars: chars };
      } catch (e) {
        if (!isQuotaErr(e)) console.warn('[store] 索引写入异常', id, e);
      }
    }
    /* 写不进：只留本次会话的内存，也不排队 —— 排队一样写不进，还要每 1.5 秒重试一次 */
    cache[key] = v;
    dirty.delete(key);
    writeIndexMode(id, v);
    return { ok: false, chars: chars };
  }

  FM.store = {
    read, write, touch, drop, flush,
    onPersist: fn => { onPersist = fn; },
    onBroken: fn => { onBroken = fn; },
    clearIndexCache, clearIndexCacheItem, indexCacheItems, probe, resetBroken,
    PREFIX: P,
    get namespace() { return ns; }
  };

  /* 目录结构口径单独存一份小键：扫描每轮都要它，为了一个字符串去 JSON.parse 几 MB 的索引不值当 */
  function writeIndexMode(id, v) {
    if (!id || !v) return;
    if (typeof v.dirMode === 'string') write('indexMode:' + id, v.dirMode);
    else if (typeof v.dirGroup === 'boolean') write('indexMode:' + id, v.dirGroup ? 'cat' : 'flat');
  }

  /* ── 业务数据访问层 ── */
  const db = FM.db = {
    touch: k => touch(k),

    /* 分类按资源库分开存：cats:<libId>。没初始化过返回 null（空数组是用户删光了），
       两个语义不能混，否则删光的库会一直长回种子分类 */
    catsFor: id => (id ? read('cats:' + id, null) : null),
    setCatsFor: (id, v) => { if (id) write('cats:' + id, v); },
    dropCats: id => { if (id) drop('cats:' + id); },
    /* 老版本的全局分类键：只给一次性迁移读，业务代码别用 */
    legacyCats: () => read('cats', null),
    dropLegacyCats: () => drop('cats'),

    albumMeta: () => read('albumMeta', {}),
    setAlbumMeta: v => write('albumMeta', v),

    progress: () => read('progress', {}),
    setProgress: v => write('progress', v),

    durations: () => read('durations', {}),
    setDurations: v => write('durations', v),

    state: () => read('state', { volume: 1, rate: 1, loop: 'all', sortDesc: false, showHidden: false, catMigrated: 0, catMigrateWarn: 0 }),
    setState: v => write('state', v),

    /* 索引按资源库分开存，切库时直接读缓存 */
    index: id => read(id ? 'index:' + id : 'index', null),
    /* 唯一的写法：扫描完立刻落盘一次。写不下就只留内存（切库 / 搜索仍能用），
       返回 { ok, chars } 让调用方报数 —— 走队列再重试是没意义的，配额不会自己让出来 */
    saveIndexNow: (id, v) => tryWriteIndex(id, v),
    /* 上次扫描用的目录结构口径：flat / cat / auto。
       老缓存里存的是布尔（1/0）或压根没有小键，统一折算；下次保存索引时会补成字符串 */
    indexMode: id => {
      if (!id) return 'flat';
      const v = read('indexMode:' + id, null);
      if (v === 'cat' || v === 'auto' || v === 'flat') return v;
      if (v === 1 || v === true) return 'cat';
      if (v === 0 || v === false) return 'flat';
      const idx = read('index:' + id, null);
      if (!idx) return 'flat';
      if (idx.dirMode === 'cat' || idx.dirMode === 'auto' || idx.dirMode === 'flat') return idx.dirMode;
      return idx.dirGroup ? 'cat' : 'flat';
    },
    dropIndex: id => {
      if (!id) return;
      drop('index:' + id);
      drop('indexMode:' + id);
    }
  };
})(window.FM);
