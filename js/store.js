/* ── store.js ────────────────────────────────────────── */
(function (FM) {
  'use strict';
  const P = 'fm:v1:';
  let cache = Object.create(null);
  const dirty = new Set();
  let broken = false;

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
        console.warn('[store] 写入失败', k, e);
        broken = true;
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

  FM.store = {
    read, write, touch, drop, flush, setNamespace,
    onPersist: fn => { onPersist = fn; },
    isBroken: () => broken,
    PREFIX: P,
    get namespace() { return ns; }
  };

  /* ── 业务数据访问层 ── */
  const db = FM.db = {
    touch: k => touch(k),

    cats: () => read('cats', []),
    setCats: v => write('cats', v),

    albumMeta: () => read('albumMeta', {}),
    setAlbumMeta: v => write('albumMeta', v),

    progress: () => read('progress', {}),
    setProgress: v => write('progress', v),

    durations: () => read('durations', {}),
    setDurations: v => write('durations', v),

    state: () => read('state', { volume: 1, rate: 1, loop: 'all', sortDesc: false, showHidden: false }),
    setState: v => write('state', v),

    /* 索引按资源库分开存，切库时直接读缓存 */
    index: id => read(id ? 'index:' + id : 'index', null),
    setIndex: (id, v) => write('index:' + id, v),
    dropIndex: id => { if (id) drop('index:' + id); }
  };
})(window.FM);
