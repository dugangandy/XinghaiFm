/* ── covers.js · 专辑封面 ───────────────────────────────
 *
 * 封面由 tools/fetch-covers.js 从喜马拉雅抓取，存在音频目录下的 .fm-covers/。
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
  let loaded = false;

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

  function urlFor(file) {
    if (FM.fs.native) return 'fm://app/__cover/' + encodeURIComponent(file);
    return null;
  }

  async function readIndex() {
    if (FM.fs.server) {
      try {
        const r = await FM.fs.apiFetch('/api/covers', { cache: 'no-store' });
        return r.ok ? await r.json() : null;
      } catch (e) { return null; }
    }
    if (FM.fs.native) {
      try { return await window.fmNative.covers(); } catch (e) { return null; }
    }
    try {
      const f = await FM.fs.getFile(DIR + '/covers.json');
      return JSON.parse(await f.text());
    } catch (e) { return null; }
  }

  /* 网页版没有自定义协议，只能把图片读成 blob URL */
  async function blobUrls(entries) {
    const out = new Map();
    const list = entries.slice();
    let cursor = 0;
    async function worker() {
      while (cursor < list.length) {
        const e = list[cursor++];
        try {
          const r = await FM.fs.src(DIR + '/' + e.file);
          out.set(e.key, r.url);
        } catch (err) {}
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(6, list.length); i++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  async function load() {
    raw = await readIndex();
    loaded = true;
    urlOf = new Map();
    index = [];
    if (!raw || typeof raw !== 'object') return 0;

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
      urlOf = await blobUrls(entries);
    }
    entries.forEach(function (e) {
      const url = urlOf.get(e.key);
      if (url) index.push({ key: e.key, norm: e.norm, url: url });
    });
    cache = new Map();
    return index.length;
  }

  /* 给一个专辑找封面：先精确对目录名，再按相似度找最像的那张 */
  function of(album) {
    if (!album || !index.length) return null;
    const key = album.dirName || album.key;
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);

    let url = null;
    if (urlOf.has(key)) {
      url = urlOf.get(key);
    } else {
      const target = norm(key);
      let bestUrl = null, bestScore = 0;
      for (let i = 0; i < index.length; i++) {
        const s = similar(target, index[i].norm);
        if (s > bestScore) { bestScore = s; bestUrl = index[i].url; }
      }
      if (bestScore >= THRESHOLD) url = bestUrl;
    }
    cache.set(key, url);
    return url;
  }

  function apply() {
    if (!FM.lib || !FM.lib.albums) return 0;
    let n = 0;
    FM.lib.albums().forEach(function (a) {
      const url = of(a);
      a.cover = url || null;
      if (url) n++;
    });
    return n;
  }

  FM.covers = {
    load, apply, of,
    get ready() { return loaded; },
    get count() { return index.length; }
  };
})(window.FM);
