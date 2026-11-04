/* ── store.js ────────────────────────────────────────── */
(function (FM) {
  'use strict';
  const P = 'fm:v1:';
  let cache = Object.create(null);
  const dirty = new Set();
  let broken = false;
  let brokenNotified = false;
  let onBroken = null;

  /* 写不进去（配额满 / 隐私模式）时通知一次：原来 broken 标记没有消费者，
     进度和分类悄悄丢在控制台里，用户完全无感。 */
  function markBroken(where, e) {
    broken = true;
    console.warn('[store] 写入失败', where, e);
    if (brokenNotified) return;
    brokenNotified = true;
    try { if (onBroken) onBroken(e); } catch (e2) {}
  }

  /* 命名空间：浏览器直连服务器时按用户隔离本地缓存（fm:v1:<uid>:*）。
     从服务端种下的 fm_uid cookie 同步读取，避免异步竞态。桌面/本地模式为空。 */
  let ns = (function () {
    try {
      const m = String(document.cookie || '').match(/(?:^|; )fm_uid=([^;]*)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  })();
  function FQ(k) { return P + (ns ? ns + ':' : '') + k; }

  function setNamespace(v) {
    const next = String(v || '');
    if (next === ns) return;
    flush();                       /* 旧命名空间的脏数据先落盘 */
    ns = next;
    cache = Object.create(null);   /* 清缓存，按新命名空间懒加载 */
    dirty.clear();
  }

  function read(key, def) {
    if (key in cache) return cache[key];
    let val = def;
    try {
      const raw = localStorage.getItem(FQ(key));
      if (raw) val = JSON.parse(raw);
    } catch (e) {
      broken = true;
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

  function flush() {
    if (!dirty.size) return;
    const keys = Array.from(dirty);
    keys.forEach(function (k) {
      try { localStorage.setItem(FQ(k), JSON.stringify(cache[k])); }
      catch (e) {
        markBroken(k, e);
      }
    });
    dirty.clear();
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
     清了要多一次误分组的风险，不值当。 */
  function indexCacheKey(full) {
    if (!full || full.indexOf(P) !== 0) return '';
    let k = full.slice(P.length);
    if (ns) {
      if (k.indexOf(ns + ':') !== 0) return '';
      k = k.slice(ns.length + 1);
    }
    return (k === 'index' || k.indexOf('index:') === 0) ? k : '';
  }

  function clearIndexCache() {
    const keys = [];
    let chars = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const full = localStorage.key(i);
        const k = indexCacheKey(full);
        if (!k) continue;
        keys.push(k);
        try { chars += full.length + String(localStorage.getItem(full) || '').length; } catch (e) {}
      }
    } catch (e) { console.warn('[store] 清缓存遍历失败', e); }
    keys.forEach(function (k) { drop(k); });
    /* 配额按 UTF-16 计（每字符 2 字节），乘 2 才是实际腾出来的量 */
    return { count: keys.length, bytes: chars * 2 };
  }

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
  function resetBroken() { broken = false; brokenNotified = false; }

  FM.store = {
    read, write, touch, drop, flush, setNamespace,
    onPersist: fn => { onPersist = fn; },
    onBroken: fn => { onBroken = fn; },
    isBroken: () => broken,
    clearIndexCache, probe, resetBroken,
    PREFIX: P,
    get namespace() { return ns; }
  };

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
    setIndex: (id, v) => {
      if (!id) { write('index', v); return; }
      write('index:' + id, v);
      /* 目录结构口径单独存一份小键：扫描每轮都要它，为了一个字符串去 JSON.parse 几 MB 的索引不值当 */
      if (v && typeof v.dirMode === 'string') write('indexMode:' + id, v.dirMode);
      else if (v && typeof v.dirGroup === 'boolean') write('indexMode:' + id, v.dirGroup ? 'cat' : 'flat');
    },
    /* 上次扫描用的目录结构口径：flat / cat / auto。
       老缓存里存的是布尔（1/0）或压根没有小键，统一折算；下次 setIndex 会自动补成字符串 */
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
