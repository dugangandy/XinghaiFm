/* ── library.js · 资源库模型 ─────────────────────────── */
(function (FM) {
  'use strict';
  const U = FM.util, db = FM.db;

  const SEED_VER = 2;
  const SEED_CATS = [
    { id: 'c-history', name: '历史军事', color: '#ff8a65', order: 0 },
    { id: 'c-literature', name: '文学小说', color: '#a78bfa', order: 1 },
    { id: 'c-psych', name: '心理成长', color: '#34d399', order: 2 },
    { id: 'c-classic', name: '国学经典', color: '#fbbf24', order: 3 },
    { id: 'c-film', name: '影视原声', color: '#60a5fa', order: 4 },
    { id: 'c-science', name: '科普人文', color: '#f472b6', order: 5 }
  ];

  /* 关键词归类。命中多个分类时专辑会同时属于多个，所以词要"具体"，
     别用"经典""小说"这种大词，否则一本书会被塞进好几个分类。 */
  const RULES = [
    { id: 'c-history', kw: [
      '历史', '曾国藩', '李鸿章', '张之洞', '左宗棠', '湘军', '太平天国', '晚清', '民国',
      '大明王朝', '明朝', '大唐', '唐朝', '宋朝', '元朝', '清朝', '王朝', '帝国',
      '长征', '二战', '一战', '战争', '抗美援朝', '知青', '上山下乡', '世界史', '军事', '战役'
    ] },
    { id: 'c-literature', kw: [
      '平凡的世界', '人世间', '主角', '一句顶一万句', '狼图腾', '路遥', '梁晓声', '刘震云', '茅盾',
      '三体', '刘慈欣', '哈利·波特', '哈利波特', '许子东', '张爱玲', '鲁迅', '红楼梦',
      '蒙曼', '马瑞芳', '双播', '原著'
    ] },
    { id: 'c-psych', kw: [
      '亲密关系', '墨菲定律', '被讨厌的勇气', '心理学', '阿德勒',
      '情绪', '焦虑', '沟通', '自我成长', '幸福'
    ] },
    { id: 'c-classic', kw: [
      '金刚经', '心经', '地藏经', '论语', '道德经', '佛',
      '古文观止', '唐宋八大家', '中华经典', '郭继承', '康震', '国学',
      '孟子', '庄子', '老子', '中庸', '唐诗', '宋词', '王阳明', '易经', '孙子兵法'
    ] },
    { id: 'c-film', kw: ['风筝', '影视', '原声剧', '广播剧'] },
    { id: 'c-science', kw: [
      '科普', '物理', '数学', '数理化', '化学', '生物', '天文', '医学', '科学家', '科学',
      '博物馆', '古典音乐', '音乐', '艺术', '经济', '货币', '金融', '美元'
    ] }
  ];

  let albums = [];
  let tracks = [];
  /* 当前库的标识（桌面版是绝对路径，网页版退回目录名）。
     albumMeta 只按目录名做 key，不区分库；靠 root 判断元数据归属，
     否则换到另一个库时同名专辑会继承上一个库的分类/收藏。 */
  let rootKey = '';
  let albumMap = new Map();
  let trackMap = new Map();
  let byAlbum = new Map();
  let rootName = '';
  let scannedAt = 0;
  let libId = '';

  function ensureCats() {
    let cats = db.cats();
    if (!cats.length) {
      db.setCats(SEED_CATS.slice());
      const st = db.state();
      st.seedVer = SEED_VER;
      db.setState(st);
      db.touch('state');
      return SEED_CATS.slice();
    }
    /* 内置分类升级：只在版本号落后时补一次，用户之后删掉就不会再长回来 */
    const st = db.state();
    if ((st.seedVer || 1) < SEED_VER) {
      const missing = SEED_CATS.filter(s => !cats.some(c => c.id === s.id));
      if (missing.length) {
        cats = cats.concat(missing.map((c, i) => ({ id: c.id, name: c.name, color: c.color, order: cats.length + i })));
        db.setCats(cats);
        db.touch('cats');
      }
      st.seedVer = SEED_VER;
      db.setState(st);
      db.touch('state');
    }
    return cats;
  }

  /* ── 标题解析 ── */
  function parseTitle(dir) {
    const s = String(dir).replace(/\s+/g, ' ').trim();
    const parts = s.split(/\s*[丨|｜]\s*|\s{2,}/).map(x => x.trim()).filter(Boolean);
    let head = parts.shift() || s;
    const tags = [];

    /* 书名号：《主角》原著 */
    const book = head.match(/^《([^》]+)》(.{0,12})$/);
    if (book) {
      if (book[2].trim()) tags.unshift(book[2].trim());
      head = book[1];
    } else {
      /* 括号内容转成标签：人世间(小说版·双播) */
      head = head.replace(/[（(]([^）)]{1,20})[)）]/g, function (m, inner) {
        if (tags.length < 3) tags.push(inner);
        return ' ';
      }).replace(/\s+/g, ' ').trim();
      /* 单个空格分隔时，取首个词作标题，其余够短就做标签 */
      const sp = head.indexOf(' ');
      if (sp > 1 && sp <= 14) {
        const rest = head.slice(sp + 1).trim();
        if (rest && rest.length <= 28) tags.push(rest);
        head = head.slice(0, sp);
      }
    }
    parts.forEach(function (p) { if (p.length <= 26) tags.push(p); });
    let title = head || s;
    if (title.length > 40) title = title.slice(0, 38) + '…';
    return { title, tags: Array.from(new Set(tags.filter(Boolean))).slice(0, 4) };
  }

  /* ── 专辑元数据的键 ──
     同一个专辑名可能出现在不同资源库里，键里带上库标识才不会互相覆盖。 */
  function metaKey(albumId) { return rootKey + '|' + albumId; }

  /* 老数据的键是纯 albumId：有 root 的一次性搬到新键，没 root 的等认领 */
  let metaKeysReady = false;
  function ensureMetaKeys() {
    if (metaKeysReady) return;
    metaKeysReady = true;
    const metas = db.albumMeta();
    let dirty = false;
    Object.keys(metas).forEach(function (k) {
      if (k.indexOf('|') >= 0) return;
      const m = metas[k];
      if (!m || !m.root) return;
      const nk = m.root + '|' + k;
      if (!metas[nk]) metas[nk] = m;
      delete metas[k];
      dirty = true;
    });
    if (dirty) { db.setAlbumMeta(metas); db.touch('albumMeta'); }
  }

  function adoptMeta(metas, albumId) {
    const old = metas[albumId];
    if (!old) return null;
    if (old.root && old.root !== rootKey) return null;
    old.root = rootKey;
    metas[metaKey(albumId)] = old;
    delete metas[albumId];
    return old;
  }

  function autoCats(text) {
    const hit = [];
    RULES.forEach(function (r) {
      if (r.kw.some(k => text.indexOf(k) >= 0)) hit.push(r.id);
    });
    return hit;
  }

  /* ── 构建 ── */
  function build(scan) {
    ensureMetaKeys();
    rootName = scan.rootName || '';
    rootKey = String(scan.root || scan.rootName || '');
    libId = scan.libId || libId;
    scannedAt = Date.now();

    const groups = new Map();
    scan.files.forEach(function (f) {
      const segs = f.rel.split('/');
      const key = segs.length > 1 ? segs[0] : '__root__';
      if (!groups.has(key)) groups.set(key, { key, files: [] });
      groups.get(key).files.push(f);
    });

    const metas = db.albumMeta();
    const durs = db.durations();
    const cats = ensureCats();
    const nextAlbums = [];
    const nextTracks = [];
    const albumIds = new Set();
    let ownCount = 0;

    groups.forEach(function (group) {
      const dirName = group.key === '__root__' ? (scan.rootName || '未分类单集') : group.key;
      const albumId = U.uid('a', dirName);

      /* 去重：同名保留体积最大、层级最浅的一个 */
      const seen = new Map();
      group.files.forEach(function (f) {
        const base = f.name.slice(0, f.name.lastIndexOf('.')).trim().toLowerCase();
        const prev = seen.get(base);
        if (!prev || f.size > prev.size || (f.size === prev.size && f.depth < prev.depth)) {
          seen.set(base, f);
        }
      });

      const list = Array.from(seen.values()).sort((a, b) => U.naturalCompare(a.name, b.name));
      let totalSize = 0, totalDur = 0;

      const tracksOfAlbum = list.map(function (f, i) {
        const tid = U.uid('t', f.rel);
        const t = {
          id: tid,
          albumId: albumId,
          rel: f.rel,
          name: f.name,
          title: U.stripExt(f.name),
          ext: f.ext,
          kind: FM.media.kindOf(f.ext),
          size: f.size,
          mtime: f.mtime,
          order: i,
          duration: durs[tid] || 0
        };
        totalSize += f.size || 0;
        totalDur += t.duration || 0;
        nextTracks.push(t);
        return t;
      });

      const parsed = parseTitle(dirName);
      const mkey = metaKey(albumId);
      let meta = metas[mkey] || adoptMeta(metas, albumId);
      if (!meta) {
        meta = { cats: autoCats(dirName), auto: true, addedAt: Date.now(), root: rootKey };
        metas[mkey] = meta;
      }
      /* 同名但属于别的库：不继承，切回去时元数据仍然完好 */
      const own = meta.root === rootKey;

      /* 没被手动改过的专辑：每次扫描重新跑关键词，规则升级才能生效。
         只增不减，避免旧版本手工加的分类被抹掉。 */
      if (own && meta.auto !== false) {
        const auto = autoCats(dirName);
        const merged = Array.from(new Set((meta.cats || []).concat(auto)));
        if (merged.length !== (meta.cats || []).length) meta.cats = merged;
        meta.auto = true;
      }

      albumIds.add(albumId);
      if (own) ownCount++;

      nextAlbums.push({
        id: albumId,
        key: group.key,
        dirName: dirName,
        title: (own && meta.title) || parsed.title,
        origTitle: parsed.title,
        tags: parsed.tags,
        seed: U.hash(dirName),
        count: tracksOfAlbum.length,
        size: totalSize,
        duration: totalDur,
        cats: own ? (meta.cats || []).filter(id => cats.some(c => c.id === id)) : [],
        fav: own && !!meta.fav,
        pinned: own && !!meta.pinned,
        hidden: own && !!meta.hidden,
        addedAt: (own && meta.addedAt) || Date.now()
      });
    });

    /* 目录被改名 / 搬家后，老元数据还挂在旧路径下：
       只有一个资源库、且当前库一条归属都没有时，按专辑 id 整体认领回来（分类收藏不丢） */
    if (ownCount === 0 && (FM.fs.libs() || []).length <= 1) {
      let moved = 0;
      Object.keys(metas).forEach(function (k) {
        const cut = k.lastIndexOf('|');
        if (cut < 0) return;
        const root = k.slice(0, cut);
        const id = k.slice(cut + 1);
        if (root === rootKey || !albumIds.has(id)) return;
        const m = metas[k];
        m.root = rootKey;
        if (!metas[rootKey + '|' + id]) metas[rootKey + '|' + id] = m;
        delete metas[k];
        moved++;
      });
      if (moved) {
        console.info('[lib] 已认领旧路径下的元数据：' + moved + ' 条');
        /* 认领完立刻把分类/收藏贴回这次的结果，不用等下一次扫描 */
        nextAlbums.forEach(function (a) {
          const m = metas[rootKey + '|' + a.id];
          if (!m) return;
          a.cats = (m.cats || []).filter(id => cats.some(c => c.id === id));
          a.fav = !!m.fav;
          a.pinned = !!m.pinned;
          a.hidden = !!m.hidden;
          a.title = m.title || a.origTitle;
          a.addedAt = m.addedAt || a.addedAt;
        });
      }
    }

    db.setAlbumMeta(metas);

    albums = nextAlbums.sort((a, b) => (b.pinned - a.pinned) || U.naturalCompare(a.dirName, b.dirName));
    tracks = nextTracks;
    reindex();
    if (FM.covers) FM.covers.apply();
    saveIndex();
    return { albums, tracks };
  }

  function reindex() {
    albumMap = new Map();
    trackMap = new Map();
    byAlbum = new Map();
    albums.forEach(function (a) {
      albumMap.set(a.id, a);
      byAlbum.set(a.id, []);
      a.videoCount = 0;
    });
    tracks.forEach(function (t) {
      trackMap.set(t.id, t);
      if (byAlbum.has(t.albumId)) {
        byAlbum.get(t.albumId).push(t);
        if (t.kind === 'video') albumMap.get(t.albumId).videoCount++;
      }
    });
    byAlbum.forEach(list => list.sort((a, b) => a.order - b.order));
  }

  /* ── 索引缓存 ── */
  function saveIndex() {
    if (!libId) return;
    db.setIndex(libId, {
      rootName: rootName,
      root: rootKey,
      scannedAt: scannedAt,
      albums: albums.map(a => ({
        id: a.id, key: a.key, dirName: a.dirName, title: a.title, origTitle: a.origTitle,
        tags: a.tags, seed: a.seed, count: a.count, size: a.size, duration: a.duration,
        addedAt: a.addedAt
      })),
      tracks: tracks.map(t => [t.id, t.albumId, t.rel, t.name, t.ext, t.size, t.mtime, t.order, t.duration])
    });
  }

  function restore(id) {
    ensureMetaKeys();
    const cached = db.index(id);
    if (!cached || !cached.albums || !cached.albums.length) return false;
    libId = id || '';
    rootName = cached.rootName || '';
    rootKey = String(cached.root || cached.rootName || '');
    scannedAt = cached.scannedAt || 0;
    const metas = db.albumMeta();
    const cats = ensureCats();
    albums = cached.albums.map(function (a) {
      const m = metas[rootKey + '|' + a.id] || {};
      const own = !m.root || m.root === rootKey;
      return Object.assign({}, a, {
        cats: own ? (m.cats || []).filter(id => cats.some(c => c.id === id)) : [],
        fav: own && !!m.fav, pinned: own && !!m.pinned, hidden: own && !!m.hidden,
        title: (own && m.title) || a.title
      });
    }).sort((a, b) => (b.pinned - a.pinned) || U.naturalCompare(a.dirName, b.dirName));
    tracks = (cached.tracks || []).map(function (row) {
      return {
        id: row[0], albumId: row[1], rel: row[2], name: row[3], ext: row[4],
        kind: FM.media.kindOf(row[4]),
        size: row[5], mtime: row[6], order: row[7], duration: row[8] || 0,
        title: U.stripExt(row[3])
      };
    });
    reindex();
    if (FM.covers) FM.covers.apply();
    return true;
  }

  /* ── 查询 ── */
  function allAlbums(opt) {
    const o = opt || {};
    return albums.filter(function (a) {
      if (!o.showHidden && a.hidden) return false;
      if (o.cat && a.cats.indexOf(o.cat) < 0) return false;
      if (o.fav && !a.fav) return false;
      return true;
    });
  }

  function search(q) {
    const key = String(q || '').trim().toLowerCase();
    if (!key) return { albums: [], tracks: [] };
    const hitAlbums = albums.filter(function (a) {
      return (a.title + ' ' + a.dirName + ' ' + a.tags.join(' ')).toLowerCase().indexOf(key) >= 0;
    });
    const hitTracks = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.title.toLowerCase().indexOf(key) >= 0) {
        hitTracks.push(t);
        if (hitTracks.length >= 300) break;
      }
    }
    return { albums: hitAlbums, tracks: hitTracks };
  }

  /* ── 进度 ── */
  function progressOf(trackId) {
    const all = db.progress();
    return all[trackId] || null;
  }

  function setProgress(trackId, pos, dur, done) {
    const all = db.progress();
    const rec = all[trackId] || {};
    rec.p = Math.max(0, pos || 0);
    rec.d = dur || rec.d || 0;
    rec.t = Date.now();
    if (done) rec.done = true;
    if (!done && rec.done) delete rec.done;
    all[trackId] = rec;
    db.setProgress(all);
    db.touch('progress');
  }

  function albumStat(album) {
    const list = byAlbum.get(album.id) || [];
    let dur = 0, pos = 0, doneCount = 0, started = 0, lastAt = 0;
    const all = db.progress();
    list.forEach(function (t) {
      const p = all[t.id];
      const d = t.duration || (p && p.d) || 0;
      if (d) dur += d;
      if (p) {
        if (p.t > lastAt) lastAt = p.t;
        if (p.p > 5) { started++; pos += Math.min(p.p, d || p.p); }
        if (p.done) doneCount++;
      }
    });
    const pct = dur > 0 ? Math.min(100, Math.round(pos / dur * 100)) : (list.length ? Math.round(doneCount / list.length * 100) : 0);
    return { count: list.length, dur, pos, pct, doneCount, started, lastAt };
  }

  function recomputeAlbum(albumId) {
    const metas = db.albumMeta();
    const m = metas[metaKey(albumId)] || {};
    const a = albumMap.get(albumId);
    if (!a) return;
    a.fav = !!m.fav;
    a.pinned = !!m.pinned;
    a.hidden = !!m.hidden;
    a.title = m.title || a.origTitle;
    a.cats = (m.cats || []).slice();
  }

  function setMeta(albumId, patch) {
    ensureMetaKeys();
    const metas = db.albumMeta();
    const key = metaKey(albumId);
    const m = metas[key] || (metas[key] = { addedAt: Date.now() });
    Object.assign(m, patch);
    m.root = rootKey;
    if (patch && patch.cats) m.auto = false;
    db.setAlbumMeta(metas);
    db.touch('albumMeta');
    recomputeAlbum(albumId);
    albums.sort((a, b) => (b.pinned - a.pinned) || U.naturalCompare(a.dirName, b.dirName));
    return m;
  }

  function catCount(catId) {
    return albums.filter(a => !a.hidden && a.cats.indexOf(catId) >= 0).length;
  }

  function stats() {
    let dur = 0, size = 0, done = 0, posSum = 0;
    const all = db.progress();
    albums.forEach(function (a) { size += a.size || 0; });
    tracks.forEach(function (t) {
      const p = all[t.id];
      const d = t.duration || (p && p.d) || 0;
      dur += d;
      if (p) {
        posSum += Math.min(p.p || 0, d || 0);
        if (p.done) done++;
      }
    });
    return { albums: albums.filter(a => !a.hidden).length, tracks: tracks.length, dur, size, done, posSum };
  }

  /* ── 分类 CRUD ── */
  function cats() { return ensureCats().slice().sort((a, b) => a.order - b.order); }

  function addCat(name, color) {
    const list = cats();
    const id = 'c' + Date.now().toString(36);
    list.push({ id, name: name || '新分类', color: color || '#22d3ee', order: list.length });
    db.setCats(list);
    db.touch('cats');
    return id;
  }

  function updateCat(id, patch) {
    const list = cats().map(c => c.id === id ? Object.assign({}, c, patch) : c);
    db.setCats(list);
    db.touch('cats');
  }

  function removeCat(id) {
    db.setCats(cats().filter(c => c.id !== id));
    db.touch('cats');
    const metas = db.albumMeta();
    Object.keys(metas).forEach(function (k) {
      const m = metas[k];
      if (m && m.cats) m.cats = m.cats.filter(x => x !== id);
    });
    db.setAlbumMeta(metas);
    db.touch('albumMeta');
    albums.forEach(function (a) { a.cats = a.cats.filter(x => x !== id); });
  }

  /* 一个库都没有时把内存里的模型清干净 */
  function clear() {
    albums = []; tracks = []; rootName = ''; rootKey = ''; libId = ''; scannedAt = 0;
    reindex();
  }

  FM.lib = {
    build, restore, saveIndex, clear,
    ensureCats,
    albums: () => albums,
    tracks: () => tracks,
    allAlbums,
    album: id => albumMap.get(id) || null,
    track: id => trackMap.get(id) || null,
    albumTracks: id => byAlbum.get(id) || [],
    search,
    stats,
    progressOf, setProgress, albumStat,
    setMeta, recomputeAlbum, catCount,
    cats, addCat, updateCat, removeCat,
    get rootName() { return rootName; },
    get libId() { return libId; },
    get scannedAt() { return scannedAt; },
    setDuration(trackId, dur) {
      const t = trackMap.get(trackId);
      if (t) t.duration = dur;
      const a = t && albumMap.get(t.albumId);
      if (a) {
        let sum = 0;
        (byAlbum.get(a.id) || []).forEach(x => sum += x.duration || 0);
        a.duration = sum;
      }
      const durs = db.durations();
      durs[trackId] = dur;
      db.setDurations(durs);
      db.touch('durations');
    }
  };
})(window.FM);
