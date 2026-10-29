/* ── store.js ────────────────────────────────────────── */
(function (FM) {
  'use strict';
  const P = 'fm:v1:';
  const cache = Object.create(null);
  const dirty = new Set();
  let broken = false;

  function read(key, def) {
    if (key in cache) return cache[key];
    let val = def;
    try {
      const raw = localStorage.getItem(P + key);
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
    try { localStorage.removeItem(P + key); } catch (e) {}
  }

  function write(key, val) { cache[key] = val; dirty.add(key); }

  let onPersist = null;

  function flush() {
    if (!dirty.size) return;
    const keys = Array.from(dirty);
    keys.forEach(function (k) {
      try { localStorage.setItem(P + k, JSON.stringify(cache[k])); }
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
    read, write, touch, drop, flush,
    onPersist: fn => { onPersist = fn; },
    isBroken: () => broken,
    PREFIX: P
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
