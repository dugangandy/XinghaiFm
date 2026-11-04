/* ── search.js · 搜索匹配与历史 ──────────────────────────
   三件事：
   1) 汉字 → 拼音（查 js/pinyin-data.js 的静态表，首次用到才解析）
   2) 相关度打分：中文子串 / 全拼 / 首字母 / 字母子序列（模糊）
   3) 本地搜索历史（FM.store，最多 12 条）
   只在查询是纯拉丁字母时走拼音分支，中文查询仍按子串，避免无谓转换。 */
(function (FM) {
  'use strict';

  /* ── 拼音表 ── */
  let dict = null;
  let dictWarned = false;
  function table() {
    if (dict) return dict;
    dict = Object.create(null);
    const raw = String(FM.pinyinData || '');
    if (!raw) {
      /* 生成物漏打包会静默退化成「只有子串」，这里必须留下痕迹 */
      if (!dictWarned && typeof console !== 'undefined' && console.warn) {
        dictWarned = true;
        console.warn('[search] 缺少 js/pinyin-data.js，拼音/首字母/模糊搜索不可用；请运行 npm run gen:pinyin');
      }
      return dict;
    }
    const list = raw.split(';');
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const cut = e.indexOf(':');
      if (cut <= 0) continue;
      dict[e.slice(0, cut)] = e.slice(cut + 1).split(',');
    }
    return dict;
  }

  /* 文本 → 拼音串（带缓存）。一条文本只留一份，超上限整体清空：
     曲目标题可能上万条，按条数封顶比 LRU 简单，代价只是重算一次 */
  const PY_MAX = 4000;
  const pyCache = Object.create(null);
  let pyCount = 0;

  function build(text) {
    const d = table();
    const tokens = [];
    let cn = false;
    for (const ch of text) {
      if (/[a-z0-9]/.test(ch)) { tokens.push({ lit: ch }); continue; }
      const reads = d[ch];
      if (reads && reads.length) { tokens.push({ reads: reads }); cn = true; }
      /* 空白、标点、emoji 跳过：拼音串里不该出现分隔符 */
    }
    const pick = function (idx) {
      return tokens.map(function (t) {
        return t.lit !== undefined ? t.lit : (t.reads[idx] || t.reads[0]);
      }).join('');
    };
    const full = pick(0);
    const initials = tokens.map(function (t) {
      return t.lit !== undefined ? t.lit : t.reads[0].charAt(0);
    }).join('');
    /* 多音字变体：最多替换 3 个字的第二读音，覆盖重庆（chong）/ 银行（hang）这类常见读法。
       不做全排列，组合爆炸且收益很小 */
    const variants = [full];
    if (cn) {
      let used = 0;
      tokens.forEach(function (t, i) {
        if (used >= 3 || t.lit !== undefined || !t.reads || t.reads.length < 2) return;
        used++;
        const v = tokens.map(function (x, j) {
          return x.lit !== undefined ? x.lit : (j === i ? x.reads[1] : x.reads[0]);
        }).join('');
        if (variants.indexOf(v) < 0) variants.push(v);
      });
    }
    return { full: full, initials: initials, variants: variants, cn: cn };
  }

  function pinyinOf(text) {
    const key = String(text || '').toLowerCase();
    const hit = pyCache[key];
    if (hit) return hit;
    const out = build(key);
    if (pyCount >= PY_MAX) {
      for (const k in pyCache) delete pyCache[k];
      pyCount = 0;
    }
    pyCache[key] = out;
    pyCount++;
    return out;
  }

  /* ── 查询归一化 ──
     letters：去掉空白后的纯字母数字，用于拼音分支。
     中文 / 混合查询不参与拼音，只走子串（避免「三体 2」这种被拆成拼音） */
  function normalize(q) {
    return String(q || '').trim().toLowerCase();
  }
  function lettersOf(q) {
    return String(q || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  function pinyinQuery(q) {
    const raw = String(q || '').toLowerCase();
    /* 中文（或别的文字）查询只走子串；拉丁查询里的标点直接剥掉：san-ti / santi! 都要能命中 */
    if (/[\u3400-\u9fff]/.test(raw)) return '';
    const s = raw.replace(/[^a-z0-9]/g, '');
    return s.length >= 2 ? s : '';
  }

  /* 子序列：snti → santi（按顺序出现即可）。
     门槛长度 4 + 命中跨度限制，避免任意三个字母把半个库都捞出来 */
  function subsequence(hay, q) {
    if (q.length < 4 || q.length > hay.length) return false;
    let i = 0, first = -1, last = -1;
    for (let j = 0; j < hay.length && i < q.length; j++) {
      if (hay.charAt(j) === q.charAt(i)) {
        if (first < 0) first = j;
        last = j;
        i++;
      }
    }
    return i === q.length && (last - first + 1) <= q.length + 3;
  }

  /* ── 打分 ──
     0 = 不命中；分数越高越相关。同一文本取各类匹配里的最高档 */
  function scoreText(text, q) {
    const s = String(text || '').toLowerCase();
    const key = normalize(q);
    if (!s || !key) return 0;
    if (s === key) return 100;
    if (s.indexOf(key) === 0) return 85;
    if (s.indexOf(key) >= 0) return 70;

    const letters = pinyinQuery(q);
    if (!letters) return 0;
    const py = pinyinOf(s);
    if (!py.cn) return 0;
    for (let i = 0; i < py.variants.length; i++) {
      if (py.variants[i].indexOf(letters) === 0) return 58;
    }
    for (let i = 0; i < py.variants.length; i++) {
      if (py.variants[i].indexOf(letters) >= 0) return 52;
    }
    if (py.initials.indexOf(letters) === 0) return 45;
    if (letters.length >= 2 && py.initials.indexOf(letters) >= 0) return 38;
    for (let i = 0; i < py.variants.length; i++) {
      if (subsequence(py.variants[i], letters)) return 22;
    }
    return 0;
  }

  /* 专辑：标题权重最高，原名/目录名次之，标签最低（防止靠一个泛标签挤到前面） */
  function scoreAlbum(a, q) {
    if (!a) return 0;
    let best = scoreText(a.title, q);
    if (a.origTitle && a.origTitle !== a.title) best = Math.max(best, scoreText(a.origTitle, q) * 0.95);
    if (a.dirName) best = Math.max(best, scoreText(a.dirName, q) * 0.95);
    if (a.tags && a.tags.length) {
      for (let i = 0; i < a.tags.length; i++) {
        best = Math.max(best, scoreText(a.tags[i], q) * 0.9);
      }
    }
    return best;
  }

  /* ── 历史 ──
     只存本地（localStorage），最多 12 条，大小写去重；1 个字的查询没有复用价值，不记 */
  const HIST_KEY = 'searchHistory';
  const HIST_MAX = 12;
  function historyList() {
    if (!FM.store) return [];
    const v = FM.store.read(HIST_KEY, []);
    if (!Array.isArray(v)) return [];
    return v.filter(function (x) { return x && typeof x.q === 'string' && x.q; }).slice(0, HIST_MAX);
  }
  function historyPush(q) {
    if (!FM.store) return;
    const key = String(q || '').trim();
    if (key.length < 2) return;
    const list = historyList().filter(function (x) { return x.q.toLowerCase() !== key.toLowerCase(); });
    list.unshift({ q: key, t: Date.now() });
    FM.store.write(HIST_KEY, list.slice(0, HIST_MAX));
    FM.store.touch(HIST_KEY);
  }
  function historyClear() {
    if (!FM.store) return;
    FM.store.write(HIST_KEY, []);
    FM.store.touch(HIST_KEY);
  }

  FM.search = {
    pinyinOf: pinyinOf,
    normalize: normalize,
    lettersOf: lettersOf,
    scoreText: scoreText,
    scoreAlbum: scoreAlbum,
    matchText: function (text, q) { return scoreText(text, q) > 0; },
    history: { list: historyList, push: historyPush, clear: historyClear }
  };
})(window.FM);
