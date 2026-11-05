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
      '长征', '二战', '一战', '战争', '抗美援朝', '知青', '上山下乡', '世界史', '军事', '战役',
      '史记', '资治通鉴', '三国', '唐史', '宋史', '明史', '清史', '近代史', '古代史',
      '南渡北归', '抗战', '抗日战争', '传记', '毛泽东', '蒋介石', '通史',
      '英国史', '美国史', '法国史', '德国史', '日本史', '欧洲史'
    ] },
    { id: 'c-literature', kw: [
      '平凡的世界', '人世间', '主角', '一句顶一万句', '狼图腾', '路遥', '梁晓声', '刘震云', '茅盾',
      '三体', '刘慈欣', '哈利·波特', '哈利波特', '许子东', '张爱玲', '鲁迅', '红楼梦',
      '蒙曼', '马瑞芳', '双播', '原著',
      '世界名著', '名著', '余罪', '刑侦', '遥远的救世主', '茅盾文学奖', '文学奖',
      '水浒', '西游记', '三国演义', '聊斋', '儒林外史', '封神'
    ] },
    { id: 'c-psych', kw: [
      '亲密关系', '墨菲定律', '被讨厌的勇气', '心理学', '阿德勒',
      '情绪', '焦虑', '沟通', '自我成长', '幸福',
      '亲子', '育儿', '家庭教育', '自律', '情商', '原生家庭', '婚姻', '养成课'
    ] },
    { id: 'c-classic', kw: [
      '金刚经', '心经', '地藏经', '论语', '道德经', '佛',
      '古文观止', '唐宋八大家', '中华经典', '郭继承', '康震', '国学',
      '孟子', '庄子', '老子', '中庸', '唐诗', '宋词', '王阳明', '易经', '孙子兵法',
      '诗词', '世说新语', '传习录', '菜根谭', '三字经', '弟子规', '千字文', '四书五经'
    ] },
    { id: 'c-film', kw: ['风筝', '影视', '原声剧', '广播剧', '电视剧'] },
    { id: 'c-science', kw: [
      '科普', '物理', '数学', '数理化', '化学', '生物', '天文', '医学', '科学家', '科学',
      '博物馆', '古典音乐', '音乐', '艺术', '经济', '货币', '金融', '美元',
      '科技', '发明', '宇宙', '昆虫', '自然', '地理', '商业', '管理', '投资', '法律', '哲学'
    ] }
  ];

  /* 索引缓存的格式版本：2 = 紧凑数组（v2），缺省的当 1 读，老缓存直接兼容 */
  const INDEX_VER = 2;

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
  /* 当前内存模型是按哪种口径分组的：
       flat 默认（每个文件夹 = 一张专辑）
       cat  二级目录（一级 = 分类，二级 = 专辑）
       auto 自动检测（一级 = 分类，专辑层按目录内容判断）
     索引缓存里要记这个字段：口径变了，缓存就不能直接拿来 restore。
     dirGroupMode 是老布尔口径（是否按分类分），auto 也算 true */
  let dirMode = 'flat';
  let dirGroupMode = false;
  function setDirMode(m) {
    dirMode = (m === 'cat' || m === 'auto') ? m : 'flat';
    dirGroupMode = dirMode !== 'flat';
  }

  /* ── 分类：按资源库分开 ──
     分类最初是给喜马拉雅有声书用的，别的库不该继承同一份清单。
     存储键 cats:<libId>（与 index:<libId> 同构）：null = 从未初始化，[] = 用户删光了。 */
  const XIMALAYA = /喜马拉雅|ximalaya|xmly/i;
  function isXimalayaLib(lib) {
    return !!lib && XIMALAYA.test(String(lib.name || '') + ' ' + String(lib.path || ''));
  }
  function findLib(id) {
    return (FM.fs.libs() || []).find(function (l) { return l.id === id; }) || null;
  }
  function seedList() {
    return SEED_CATS.map(function (c) { return Object.assign({}, c); });
  }
  /* 新库第一次打开给什么：只有喜马拉雅预置内置分类，其它库从空开始。
     认不出这个库（libs 还没到/已被删）时返回 null，交给上层先别初始化 */
  function initialCats() {
    const lib = findLib(libId);
    if (!lib) return null;
    return isXimalayaLib(lib) ? seedList() : [];
  }
  /* 目标库里是不是原封未动的内置分类（迁移时用来区分「刚种下的」和「用户真实数据」） */
  function isPristineSeed(list) {
    if (!Array.isArray(list) || list.length !== SEED_CATS.length) return false;
    const ids = list.map(function (c) { return c.id; }).sort().join(',');
    return ids === SEED_CATS.map(function (c) { return c.id; }).sort().join(',');
  }

  /* 当前库的分类。libId 还没确定时返回空且不写盘，免得留下一个裸键 cats: */
  function ensureCats() {
    if (!libId) return [];
    const raw = db.catsFor(libId);
    if (raw !== null) return raw;
    /* 库列表还没加载时分不清是不是喜马拉雅（桌面端启动是先 restore 再 fs.load），
       这时候写盘会把空分类落进去，宁可先不初始化 */
    if (!(FM.fs.libs() || []).length) return [];
    const init = initialCats();
    if (init === null) return [];
    db.setCatsFor(libId, init);
    db.touch('cats:' + libId);
    return init;
  }

  /* ── 目录分类（「按目录分两级」模式） ──
     一层子目录就是一个分类：id 用目录名哈希（d 前缀），和手工分类（c 开头）区分开。
     删掉的目录分类记进本地名单，下次扫描不再自动建回来。 */
  function dirCatId(name) { return 'd' + U.hash(String(name || '')).toString(36); }
  function droppedCatKey() { return 'dirCatDropped:' + (libId || ''); }
  function droppedCats() {
    if (!libId) return [];
    const v = FM.store.read(droppedCatKey(), []);
    return Array.isArray(v) ? v : [];
  }
  function rememberDroppedCat(name) {
    if (!libId || !name) return;
    const list = droppedCats();
    if (list.indexOf(name) >= 0) return;
    list.push(name);
    const next = list.slice(-200);
    FM.store.write(droppedCatKey(), next);
    FM.store.touch(droppedCatKey());
    /* 名单也要落库：只写本地的话，别的端（桌面/另一台手机）扫描时会把这个
       目录分类按目录名重新建回来，删了又长 */
    pushMeta({ dirCatDropped: next });
  }

  /* 补齐本轮扫到的目录分类：已有的不动、用户手工建过同名分类就直接挂过去，
     只有真缺的才追加。改动一次性推给数据库，避免每次扫描都写一遍。 */
  function ensureDirCats(names, list) {
    if (!libId || !names || !names.length) return list;
    const drop = droppedCats();
    const next = list.slice();
    let changed = false;
    names.forEach(function (name) {
      if (!name || drop.indexOf(name) >= 0) return;
      const id = dirCatId(name);
      if (next.some(function (c) { return c.id === id; })) return;
      if (next.some(function (c) { return c.name === name; })) return;
      next.push({ id, name, color: U.coverColors(U.hash(name))[0], order: next.length });
      changed = true;
    });
    if (!changed) return list;
    db.setCatsFor(libId, next);
    db.touch('cats:' + libId);
    pushMeta({ cats: next.slice().sort(function (a, b) { return a.order - b.order; }) });
    return next;
  }

  /* ── 扫描结果 → 专辑分组 ──
     flat 默认：一层子目录 = 专辑，根目录散落文件单独成一张。
     cat 二级目录：1 段（根目录散落文件）→ 单独一张；2 段（分类目录里直接放的音频）
       → 该分类下的散集专辑；3 段及以上（分类/专辑/子目录/a.mp3）→ 并入最近的二级专辑。
     auto 自动检测：不假设整个库层数一致，每个一级目录自己判断。
       从一级目录往下走，找到「第一个直接躺着音频的目录」，它就是专辑：
         专辑/1.mp3                  → 一级自己含音频，它是一张专辑（2 层的库，没有分类）
         分类/专辑/1.mp3              → 专辑是二级
         分类/中间分组/专辑/1.mp3      → 专辑是三级，中间分组不影响
         分类/专辑/CD1/1.mp3          → CD1 是分卷目录，往回收一层，专辑仍是二级
       专辑不是一级目录时，分类就是一级目录。
     三档都在同一份扫描结果上算，切口径不用重新走盘。
     第二参数同时接受老布尔（false=flat，true=cat）。
     返回 [{ key, dirName, cat, files }]，dirName 为空时由调用方按 key 兜底。 */
     /* 分卷 / 容器目录名：这些层不单独成专辑，音频要往上收一层。
        MP3 / 音频 这种是「装音频的文件夹」，md / reader / 资料 是配套资料目录，和 CD1 一样属于容器 */
     const VOLUME_RE = /^(cd|disc|disk|dvd|part|pt|vol|volume)\s*[-_.]?\s*\d{1,3}$|^\d{1,3}$|^(上|中|下)(卷|册|部|篇|集)?$|^第\s*[0-9一二三四五六七八九十百]{1,3}\s*[部卷册集辑篇章]|^(mp3|m4a|m4b|flac|wav|aac|ogg|audio|voice|music|media|音频|录音|音轨|声音|md|html|pdf|reader|assets|doc|docs|文档|资料|图片|image|images|covers?)$/i;
     /* 章节目录名：`01-开篇词 (1讲)`、`第03章`、`08【战略篇】第8章：说服高手进阶技巧`
        这种是一本书 / 一门课里的章，不该单独成专辑。三条判据：
          ① 编号 + 分隔符或括号（01-、01_、01、01【入门篇】、01(上)）
          ② 名字里任意位置带「第N章/节/讲/回/课」
          ③ `(12讲)` 这种讲数标记
        编号后必须紧跟分隔符/括号/章讲字样，「1984」「24个比利」「7号房的礼物」这类
        真专辑名不受影响；「希赛PMP第七版」也不算章节（版不属于章/节/讲/回/课） */
     const CHAPTER_RE = /^\d{1,3}\s*(?:[-_.、:：)）\]】]|[【\[（(《]|[讲章节课回])|[(（]\s*\d+\s*讲\s*[)）]|第\s*[0-9一二三四五六七八九十百]{1,3}\s*[讲章节回课]/i;

     function groupFiles(files, mode) {
     const m = (mode === true || mode === 'cat') ? 'cat' : (mode === 'auto' ? 'auto' : 'flat');
     const groups = new Map();
     const list = files || [];

     if (m === 'auto') {
       /* 哪些目录里直接躺着音频。''（根目录）也算一个 */
       const hasAudio = new Set();
       list.forEach(function (f) {
         const segs = String(f && f.rel || '').split('/');
         segs.pop();
         hasAudio.add(segs.join('/'));
       });
       list.forEach(function (f) {
         const segs = String(f && f.rel || '').split('/');
         segs.pop();
         let key, dirName = '', cat = null;
         if (!segs.length) {
           key = '__root__';
         } else {
           /* 从一级往下找第一个「直接含音频」的目录，它就是这张专辑。
              只在前三层里找：有声书库里比「分类/分组/专辑」更深的目录基本是
              章节，切出来只会得到一堆两三集的碎片。真没有直接含音频的层
              （音频都塞在 CD1 / MP3 子目录里）时，就停在第三层 */
           const top = Math.min(segs.length, 3);
           let at = top - 1;
           for (let i = 1; i <= top; i++) {
             if (hasAudio.has(segs.slice(0, i).join('/'))) { at = i - 1; break; }
           }
           /* 落点本身是 CD1 / 上卷 / MP3 / 01-开篇词 这类容器或章节：往上收一层，
              它们不单独成专辑。一级目录自己是容器时就停在 0，避免把分类也吃掉 */
           while (at > 0 && (VOLUME_RE.test(segs[at]) || CHAPTER_RE.test(segs[at]))) at--;
           key = segs.slice(0, at + 1).join('/');
           dirName = segs[at];
           /* 专辑不是一级目录时，一级目录就是分类 */
           if (at > 0) cat = segs[0];
         }
         const hit = groups.get(key);
         if (hit) hit.files.push(f);
         else groups.set(key, { key, dirName, cat, files: [f] });
       });
       return Array.from(groups.values());
     }

    const dirGroup = m === 'cat';
    list.forEach(function (f) {
      const segs = String(f && f.rel || '').split('/');
      let key, dirName = '', cat = null;
      if (!dirGroup) {
        key = segs.length > 1 ? segs[0] : '__root__';
      } else if (segs.length <= 1) {
        key = '__root__';
      } else if (segs.length === 2) {
        key = segs[0];
        cat = segs[0];
        dirName = segs[0];
      } else {
        key = segs[0] + '/' + segs[1];
        cat = segs[0];
        dirName = segs[1];
      }
      const hit = groups.get(key);
      if (hit) hit.files.push(f);
      else groups.set(key, { key, dirName, cat, files: [f] });
    });
    return Array.from(groups.values());
  }

  /* 排序：置顶优先；两级模式下按「分类/专辑」相对路径排，同一分类自然挨在一起 */
  function albumPath(a) { return a && (a.path || a.dirName || a.key) || ''; }
  function albumSort(a, b) {
    return (b.pinned - a.pinned) || U.naturalCompare(albumPath(a), albumPath(b));
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

  /* 分组 → 专辑 id：扫描对账和构建专辑两处都得用同一套口径，
     否则对账算出来的「本轮还活着的专辑」跟实际写进 album_meta 的键对不上 */
  function albumIdOf(group, rootName) {
    const dirName = group.dirName || (group.key === '__root__' ? (rootName || '未分类单集') : group.key);
    return U.uid('a', group.key === '__root__' ? dirName : group.key);
  }

  /* ── 构建 ── */
  function build(scan) {
    ensureMetaKeys();
    rootName = scan.rootName || '';
    rootKey = String(scan.root || scan.rootName || '');
    libId = scan.libId || FM.fs.activeId || libId;
    /* 用扫描方给的时间戳（服务端 / 主进程写的那次 walk 的完成时间），别用本地时间：
       客户端会拿它和 /api/scan/at 比来判断"服务端有没有更新的结果"，
       两边时钟不齐时本地时间会让这个比较永远不成立（或永远成立）。
       本地目录（handle / files）没有这个字段，退回本地时间，不影响任何逻辑。 */
    scannedAt = Number(scan.scannedAt) || Date.now();

    /* 三档口径：优先读 dirMode，老服务端/老主进程只给布尔 dirGroup 时折算 */
    const scanMode = scan.dirMode === undefined || scan.dirMode === null
      ? (scan.dirGroup ? 'cat' : 'flat')
      : scan.dirMode;
    setDirMode(scanMode);
    const groups = groupFiles(scan.files, dirMode);
    /* 本轮扫描真正存在的专辑元数据键。album_meta 是跨轮累积的，目录删掉后
       旧行还在（孤儿行），对账时不能再让它们替已删目录的分类「续命」 */
    const liveMetaKeys = new Set(groups.map(function (g) {
      return metaKey(albumIdOf(g, scan.rootName));
    }));

    const metas = db.albumMeta();
    const durs = db.durations();
    /* 本轮要回写的专辑元数据：扫描时自动产生的归类（新建 / 补齐 / 作废）都得推给数据库。
       只写本地缓存的话，服务端只有分类清单、没有专辑归属，重开或换设备后分类下面就是空的 */
    const touchedMeta = {};
    /* 口径变了（默认 / 二级目录 / 自动检测 之间切换）：旧口径算出来的自动归类全部作废，
       否则「只补空」的逻辑会让专辑继续挂在旧分类下，新的目录分类永远空着。
       用户手工改过的（auto === false）不动 */
    /* hasModeFlag：扫描结果里到底有没有口径字段。老服务端 / 老主进程不返回时，
       不能把「没告诉我」当成「明确改回一层」，否则会把两层时代的归类全清掉 */
    const hasModeFlag = typeof scan.dirMode === 'string' || typeof scan.dirGroup === 'boolean';
    const prevMode = db.indexMode(libId);
    if (libId && hasModeFlag && prevMode !== dirMode) {
      const prefix = rootKey + '|';
      Object.keys(metas).forEach(function (k) {
        if (k.indexOf(prefix) !== 0) return;
        const m = metas[k];
        if (!m || m.auto === false) return;
        if (!(m.cats || []).length) return;
        m.cats = [];
        touchedMeta[k] = m;
      });
    }
    /* 分类清单：先把目录分类补齐（只补缺失的，用户删过的不会复活），再算关键词规则 */
    const catDirs = [];
    if (dirGroupMode) groups.forEach(function (g) {
      if (g.cat && catDirs.indexOf(g.cat) < 0) catDirs.push(g.cat);
    });
    let cats = ensureCats();
    cats = ensureDirCats(catDirs, cats);
    /* 按本轮扫描结果对账清理残留目录分类：平铺模式清全部 d；二级/自动只留下仍对应
       当前目录的 d。只增不删会留下点进去空空的分类；清理要拿到含 d 的原始列表才能算出
       catsDeleted。普通网页用户没有写权限，跳过清理（仅靠 cats() 展示层隐藏），避免 403。
       扫描结果为空（掉盘 / 扫描失败 / 空库）时不做对账：那是「这一轮没读到」，
       不是「那些目录都删了」，否则会把分类连引用一起抹掉。
       残缺扫描同理：目录分类要连续两轮缺失才删（候选记在 store 里），
       避免一次掉盘就把分类和人工归类一起抹掉 */
    const stalePendingKey = 'dirCatStale:' + (libId || rootKey);
    if (groups.length && !(FM.fs.serverReached && !FM.fs.isAdmin)) {
      const keepDir = new Set();
      if (dirGroupMode) {
        const drop = droppedCats();
        catDirs.forEach(function (name) { if (drop.indexOf(name) < 0) keepDir.add(dirCatId(name)); });
      }
      /* 仍被本轮存在的专辑引用的分类先不删：扫描偶尔漏读某个目录（NAS/移动硬盘掉线）时，
         不能把它的分类当残留清掉。只认 liveMetaKeys —— 已消失专辑的孤儿引用不再有保护力，
         否则目录删了分类清不掉，引用又被 pullMeta 拉回来，永远留着 */
      const refIds = new Set();
      if (dirGroupMode) {
        Object.keys(metas).forEach(function (k) {
          if (!liveMetaKeys.has(k)) return;
          const m = metas[k];
          if (m && Array.isArray(m.cats)) m.cats.forEach(function (id) { refIds.add(id); });
        });
      }
      const candidates = cats
        .filter(function (c) {
          if (String(c.id).charAt(0) !== 'd') return false;
          if (keepDir.has(c.id)) return false;
          if (dirGroupMode && refIds.has(c.id)) return false;
          return true;
        })
        .map(function (c) { return c.id; });
      /* 目录分类要连续两轮缺失才删：一次残缺扫描（NAS / 移动硬盘掉线、目录权限变了）
         不足以证明目录被删，否则会把该目录的分类连同人工归类一起抹掉。
         平铺模式下的 d 分类本来就该全清，不适用两轮确认 */
      const savedRaw = FM.store.read(stalePendingKey, []);
      const savedPending = (Array.isArray(savedRaw) ? savedRaw : [])
        .filter(function (id) { return typeof id === 'string'; });
      const prevPending = dirGroupMode ? savedPending : [];
      const staleIds = dirGroupMode
        ? candidates.filter(function (id) { return prevPending.indexOf(id) >= 0; })
        : candidates;
      /* 只记「仍然缺失但还没满两轮」的：已确认删除的、目录又回来的都要从候选里去掉 */
      const pending = dirGroupMode
        ? candidates.filter(function (id) { return staleIds.indexOf(id) < 0; })
        : [];
      if (pending.join('|') !== savedPending.join('|')) {
        try { FM.store.write(stalePendingKey, pending); } catch (e) {}
      }
      if (staleIds.length) {
        const staleSet = new Set(staleIds);
        cats = cats.filter(function (c) { return !staleSet.has(c.id); });
        db.setCatsFor(libId, cats);
        db.touch('cats:' + libId);
        /* 专辑对这些已删分类的引用一并清掉（含已消失专辑的孤儿行），
           免得 pullMeta 把无效引用灌回来，继续给分类续命 */
        Object.keys(metas).forEach(function (k) {
          if (k.indexOf(rootKey + '|') !== 0) return;
          const m = metas[k];
          if (!m || !Array.isArray(m.cats)) return;
          const kept = m.cats.filter(function (id) { return !staleSet.has(id); });
          if (kept.length !== m.cats.length) { m.cats = kept; touchedMeta[k] = m; }
        });
        /* 分类本身要落库删行：本地删了但 upsert 不会删行，下次 pullMeta 会把残留又灌回来 */
        pushMeta({ cats: cats, catsDeleted: staleIds });
      }
    }
    const catIds = new Set(cats.map(function (c) { return c.id; }));
    const dropped = droppedCats();
    const autoFor = function (text) { return autoCats(text).filter(function (id) { return catIds.has(id); }); };
    const favs = FM.fs.favIds || new Set();
    const trackFavs = FM.fs.favTrackIds || new Set();
    const nextAlbums = [];
    const nextTracks = [];
    const albumIds = new Set();
    let ownCount = 0;

    groups.forEach(function (group) {
      const dirName = group.dirName || (group.key === '__root__' ? (scan.rootName || '未分类单集') : group.key);
      /* 专辑 id：平铺库沿用「目录名哈希」（与旧版完全一致，存量整理数据不受影响），
         两级库用「分类/专辑」相对路径哈希，不同分类下的同名专辑不会撞在一起。 */
      const albumId = albumIdOf(group, scan.rootName);
      /* 二级目录 / 自动检测：这一组挂在哪个目录分类下；用户删掉过的分类不再自动挂回去 */
      const dirCat = (dirGroupMode && group.cat && dropped.indexOf(group.cat) < 0) ? dirCatId(group.cat) : '';
      const autoForAlbum = function () {
        if (!dirGroupMode) return autoFor(dirName);
        return dirCat ? [dirCat] : [];
      };

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
          fav: trackFavs.has(tid),
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
        meta = { cats: autoForAlbum(), auto: true, addedAt: Date.now(), root: rootKey };
        metas[mkey] = meta;
        touchedMeta[mkey] = meta;
      }
      /* 同名但属于别的库：不继承，切回去时元数据仍然完好。
         本地 albumMeta 条目可能不带 root（服务端拉回来的快照就是如此），按 restore() 同样用宽松判断，
         否则重扫时 own 误判为 false，把分类 / 置顶 / 隐藏 / 重命名全清掉 */
      const own = !meta.root || meta.root === rootKey;

      /* 只补空：已经有分类的专辑一律不动（人工整理过的不能被规则改掉）。
         空分类的大多是新专辑，或旧版本关键词没命中，扫描时补一次。
         规则升级也不再往已分类的专辑里追加。 */
      if (own && meta.auto !== false && !(meta.cats || []).length) {
        const auto = autoForAlbum();
        if (auto.length) { meta.cats = auto; touchedMeta[mkey] = meta; }
        meta.auto = true;
      }
      /* 目录分类是结构性的（一层文件夹就是分类），只要用户没手工改过分类（auto !== false），
         缺了就补上：老库换成两层后即使 meta 里还挂着关键词分类，也能马上出现在目录分类下 */
      if (dirGroupMode && dirCat && own && meta.auto !== false && (meta.cats || []).indexOf(dirCat) < 0) {
        meta.cats = (meta.cats || []).concat([dirCat]);
        touchedMeta[mkey] = meta;
      }

      albumIds.add(albumId);
      if (own) ownCount++;

      nextAlbums.push({
        id: albumId,
        key: group.key,
        path: group.key === '__root__' ? '' : group.key,
        dirCat: dirCat,
        dirName: dirName,
        title: (own && meta.title) || parsed.title,
        origTitle: parsed.title,
        tags: parsed.tags,
        seed: U.hash(dirName),
        count: tracksOfAlbum.length,
        size: totalSize,
        duration: totalDur,
        cats: own ? (meta.cats || []).filter(id => cats.some(c => c.id === id)) : [],
        fav: favs.has(albumId),
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
          a.fav = favs.has(a.id);
          a.pinned = !!m.pinned;
          a.hidden = !!m.hidden;
          a.title = m.title || a.origTitle;
          a.addedAt = m.addedAt || a.addedAt;
        });
      }
    }

    db.setAlbumMeta(metas);
    /* 推给数据库（fs.pushMeta 会攒批，且按 400 条拆包）。纯网页本地库没有后端，这里直接 no-op */
    if (Object.keys(touchedMeta).length) pushMeta({ albumMeta: touchedMeta });

    albums = nextAlbums.sort(albumSort);
    tracks = nextTracks;
    reindex();
    if (FM.covers) FM.covers.apply();
    saveIndex();
    return { albums, tracks };
  }

  function reindex() {
    invalidateSearch();
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

  /* ── 索引缓存 ──
     立刻试写一次：真写不下（配额不足）就只留内存，不排队重试 —— 排队也一样写不进，
     还会每 1.5 秒撞一次，连带把同批的进度挤掉。 */
  function saveIndex() {
    if (!libId) return;
    /* v2 紧凑格式（体积约为 v1 的六成）：
         albums [id, key, dirCat, dirName, title, origTitle, seed, count, size, duration, addedAt, tags]
         dirs   与 albums 同下标的目录前缀，'' 表示曲目 rel 不剥前缀（__root__ 或异常数据）
         tracks [id, 专辑下标, rel 去掉 dirs 前缀, size, mtime 秒, order, duration 秒]
       name / ext / 专辑 id 全部由上面几项还原（见 rowTrack / indexAlbums），不再重复存。 */
    const pos = new Map();
    const dirs = [];
    const albumRows = albums.map(function (a, i) {
      pos.set(a.id, i);
      dirs.push(a.key && a.key !== '__root__' ? a.key + '/' : '');
      return [
        a.id, a.key, a.dirCat || '', a.dirName || '', a.title || '', a.origTitle || '',
        a.seed, a.count, a.size, a.duration, a.addedAt, a.tags || []
      ];
    });
    /* 有一行 rel 不以自己专辑的前缀开头，就整组不剥 —— 宁可多存，不能还原错 */
    tracks.forEach(function (t) {
      const i = pos.has(t.albumId) ? pos.get(t.albumId) : -1;
      const d = i >= 0 ? dirs[i] : '';
      if (d && String(t.rel || '').indexOf(d) !== 0) dirs[i] = '';
    });
    const trackRows = tracks.map(function (t) {
      const i = pos.has(t.albumId) ? pos.get(t.albumId) : -1;
      const d = i >= 0 ? dirs[i] : '';
      const rel = String(t.rel || '');
      return [
        t.id, i, d ? rel.slice(d.length) : rel,
        t.size || 0, Math.round((t.mtime || 0) / 1000), t.order || 0, Math.round(t.duration || 0)
      ];
    });
    const idx = {
      v: INDEX_VER,
      rootName: rootName,
      root: rootKey,
      scannedAt: scannedAt,
      /* dirMode 是当前口径，dirGroup 留着给老版本读（auto 也算「按分类」） */
      dirMode: dirMode,
      dirGroup: dirGroupMode,
      dirs: dirs,
      albums: albumRows,
      tracks: trackRows
    };
    const saved = db.saveIndexNow(libId, idx);
    if (saved && saved.ok === false) {
      console.warn('[lib] 索引写不进本地缓存（' + Math.round(saved.chars / 1000) + 'k 字符，本机配额不足）：' +
        '本次只保留在内存，下次进库会重新扫描');
    }
  }

  /* 进库前先设定当前库上下文（libId / rootKey / 模式）。
     enterLib 是「先 pullMeta 再 restore」，而 applyMeta 的 albumMeta 用 rootKey 当前缀——
     不先切过来的话，切库时会把新库的整理写到上一个库的键下，导致专辑列表看起来不对。 */
  function prime(id) {
    libId = id || '';
    const cached = db.index(id);
    if (cached) {
      rootName = cached.rootName || '';
      rootKey = String(cached.root || cached.rootName || '');
      scannedAt = cached.scannedAt || 0;
      setDirMode(cached.dirMode === undefined ? (cached.dirGroup ? 'cat' : 'flat') : cached.dirMode);
    } else {
      const lib = FM.fs.active();
      rootName = lib ? (lib.name || '') : '';
      rootKey = lib && lib.path ? String(lib.path) : '';
      scannedAt = 0;
      setDirMode('flat');
    }
    ensureMetaKeys();
  }

  function restore(id) {
    ensureMetaKeys();
    const cached = db.index(id);
    if (!cached || !cached.albums || !cached.albums.length) return false;
    libId = id || '';
    rootName = cached.rootName || '';
    rootKey = String(cached.root || cached.rootName || '');
    scannedAt = cached.scannedAt || 0;
    /* 老索引只有布尔 dirGroup：true 就是当年唯一的「二级目录」 */
    setDirMode(cached.dirMode === undefined ? (cached.dirGroup ? 'cat' : 'flat') : cached.dirMode);
    const metas = db.albumMeta();
    const rawCats = db.catsFor(libId);
    const cats = ensureCats();
    /* catIds=null 表示「这个库的分类还没初始化（库列表都没加载）」：这时别过滤，
       否则启动首屏会把用户已归好的分类全抹掉，等 scan 回来又闪一下 */
    const catIds = (rawCats === null && !cats.length) ? null : new Set(cats.map(function (c) { return c.id; }));
    albums = indexAlbums(cached).map(function (a) {
      const m = metas[rootKey + '|' + a.id] || {};
      const own = !m.root || m.root === rootKey;
      /* 旧索引没有 path / dirCat：按 key（再退回目录名）兜底，封面和排序才不会拿到 undefined */
      return Object.assign({ path: a.key === '__root__' ? '' : (a.key || '') }, a, {
        cats: own ? (catIds ? (m.cats || []).filter(function (id) { return catIds.has(id); }) : (m.cats || []).slice()) : [],
        fav: !!(FM.fs.favIds && FM.fs.favIds.has(a.id)), pinned: own && !!m.pinned, hidden: own && !!m.hidden,
        title: (own && m.title) || a.title
      });
    }).sort(albumSort);
    tracks = (cached.tracks || []).map(function (row) {
      const t = rowTrack(row, cached);
      t.fav = !!(FM.fs.favTrackIds && FM.fs.favTrackIds.has(t.id));
      return t;
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

  /* ── 搜索 ──
     FM.search 负责打分（中文子串 / 全拼 / 首字母 / 字母子序列），这里只做遍历与排序。
     曲目数量多的库（>3000）跳过拼音分支：上万条标题逐条转拼音会拖慢每一次按键。
     showHidden 由调用方（结果页 / 建议浮层）统一传入，当前库与跨库口径必须一致。 */
  const TRACK_PY_LIMIT = 3000;
  const SEARCH_TRACK_CAP = 300;
  /* 输入防抖里建议浮层和结果页会各算一次 searchAll；同一查询只算一份全量结果。
     声明放在模块前部，避免 reindex() 引用到尚未初始化的 const（TDZ）。 */
  const searchMemo = { key: '', res: null };
  function invalidateSearch() { searchMemo.key = ''; searchMemo.res = null; }

  function search(q, opt) {
    const o = opt || {};
    const key = FM.search.normalize(q);
    if (!key) return { albums: [], tracks: [] };
    const hidden = new Set();
    if (!o.showHidden) {
      albums.forEach(function (a) { if (a.hidden) hidden.add(a.id); });
    }

    const hitAlbums = [];
    albums.forEach(function (a) {
      if (hidden.has(a.id)) return;
      const s = FM.search.scoreAlbum(a, key);
      if (s > 0) hitAlbums.push({ a: a, s: s });
    });
    hitAlbums.sort(function (x, y) {
      return (y.s - x.s) || U.naturalCompare(albumPath(x.a), albumPath(y.a));
    });

    const pyTracks = tracks.length <= TRACK_PY_LIMIT;
    const hitTracks = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (hidden.has(t.albumId)) continue;      /* 隐藏专辑的单集也不该被搜出来 */
      const s = pyTracks ? FM.search.scoreText(t.title, key) : (t.title.toLowerCase().indexOf(key) >= 0 ? 70 : 0);
      if (s > 0) hitTracks.push({ t: t, s: s });
    }
    hitTracks.sort(function (x, y) {
      return (y.s - x.s) || U.naturalCompare(x.t.name, y.t.name);
    });

    return {
      albums: hitAlbums.map(function (x) { return x.a; }),
      tracks: hitTracks.slice(0, SEARCH_TRACK_CAP).map(function (x) { return x.t; })
    };
  }

  /* 专辑视图：v2 存的是数组，这里还原成对象给跨库搜索 / 库列表用。
     还原结果挂在缓存对象上（不可枚举，JSON.stringify 带不出去），一次解析只做一遍 */
  function indexAlbums(cached) {
    if (!cached) return [];
    if (cached.v !== INDEX_VER) return cached.albums || [];
    if (cached.__albums) return cached.__albums;
    const list = (cached.albums || []).map(function (r) {
      return {
        id: r[0], key: r[1],
        path: r[1] === '__root__' ? '' : (r[1] || ''),
        dirCat: r[2] || '', dirName: r[3] || '',
        title: r[4] || '', origTitle: r[5] || '',
        seed: r[6], count: r[7], size: r[8], duration: r[9],
        addedAt: r[10], tags: r[11] || []
      };
    });
    try { Object.defineProperty(cached, '__albums', { value: list, enumerable: false, configurable: true }); } catch (e) {}
    return list;
  }

  /* 索引两种形状，读的时候统一成一个曲目对象：
       v2 [id, albumIdx, relSuffix, size, mtimeSec, order, duration]
       v1 [id, albumId, rel, name, ext, size, mtime, order, duration]
     v2 省掉 name / ext / 目录前缀（都能从 rel 还原），行数上万时才是配额的关键。
     老缓存可能缺字段，这里全部兜底，别让一行脏数据把整个搜索打挂 */
  function rowTrack(row, cached) {
    if (cached && cached.v === INDEX_VER) {
      const ai = Number(row[1]);
      const album = (cached.albums || [])[ai];
      const dir = (cached.dirs || [])[ai] || '';
      const rel = dir + String(row[2] || '');
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      const dot = name.lastIndexOf('.');
      const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
      return {
        id: row[0], albumId: album ? album[0] : '', rel: rel, name: name, ext: ext,
        kind: FM.media.kindOf(ext), size: row[3], mtime: (row[4] || 0) * 1000,
        order: row[5] || 0, duration: row[6] || 0, fav: false,
        title: U.stripExt(name)
      };
    }
    const name = String(row[3] || '');
    const ext = String(row[4] || '');
    return {
      id: row[0], albumId: row[1], rel: String(row[2] || ''), name: name, ext: ext,
      kind: FM.media.kindOf(ext), size: row[5], mtime: row[6],
      order: row[7] || 0, duration: row[8] || 0, fav: false,
      title: U.stripExt(name)
    };
  }

  /* ── 跨库搜索 ──
     当前库用内存模型（含封面/收藏）；其它库读 index:<libId> 缓存（FM.store 已缓存 JSON，
     只有本次会话第一次搜会解析一次）。没打开过的库没有索引缓存，收进 pendingLibs 由界面提示。
     返回扁平数组 + 每条的 libId，界面按 libId 分组；当前库永远排在最前面。
     缓存里始终只放「全部库」的结果，scope:'cur' 只是过滤派生，避免每次按键扫两遍。 */
  const LIB_ALBUM_CAP = 60;
  const LIB_TRACK_CAP = 60;

  /* 库列表变化 / 别的库重新扫描后自动失效 */
  function libsSignature() {
    const libs = (FM.fs && FM.fs.libs) ? (FM.fs.libs() || []) : [];
    const parts = [];
    libs.forEach(function (l) {
      if (!l || !l.id || l.id === libId) return;
      const idx = db.index(l.id);
      parts.push(l.id + ':' + (l.missing && !idx ? 'm' : (idx && idx.scannedAt) || 0));
    });
    return parts.join(',');
  }

  function computeAll(key, showHidden) {
    const out = {
      albums: [], tracks: [], pendingLibs: [],
      self: { id: libId, name: rootName || '当前资源库' },
      total: 0
    };
    const cur = search(key, { showHidden: showHidden });
    cur.albums.forEach(function (a) {
      out.albums.push({ album: a, libId: libId, libName: out.self.name, self: true });
    });
    cur.tracks.forEach(function (t) {
      out.tracks.push({ track: t, libId: libId, libName: out.self.name, self: true });
    });

    const metas = db.albumMeta();
    (FM.fs.libs() || []).forEach(function (lib) {
      if (!lib || !lib.id || lib.id === libId) return;
      const idx = db.index(lib.id);
      /* 目录不可用且没缓存 / 从没打开过：分别提示。空库不算「未建立索引」 */
      if (!idx || !Array.isArray(idx.albums)) {
        out.pendingLibs.push({ id: lib.id, name: lib.name || '资源库', missing: !!lib.missing && !idx });
        return;
      }
      if (!idx.albums.length) return;
      const alist = indexAlbums(idx);          /* v1 对象数组 / v2 数组都还原成同一套字段 */
      const root = String(idx.root || idx.rootName || '');
      const libName = lib.name || idx.rootName || '资源库';
      const hidden = new Set();
      if (!showHidden) {
        alist.forEach(function (a) {
          const m = metas[root + '|' + a.id] || {};
          if (m.hidden) hidden.add(a.id);
        });
      }

      const hits = [];
      alist.forEach(function (a) {
        if (hidden.has(a.id)) return;
        const m = metas[root + '|' + a.id] || {};
        const album = m.title ? Object.assign({}, a, { title: m.title }) : a;
        const s = FM.search.scoreAlbum(album, key);
        if (s > 0) hits.push({ a: album, s: s });
      });
      hits.sort(function (x, y) {
        return (y.s - x.s) || U.naturalCompare(albumPath(x.a), albumPath(y.a));
      });
      hits.slice(0, LIB_ALBUM_CAP).forEach(function (h) {
        out.albums.push({ album: h.a, libId: lib.id, libName: libName, self: false });
      });

      /* 与当前库同一套匹配：去扩展名的标题 + 打分排序；规模护栏一致 */
      const titles = new Map();
      alist.forEach(function (a) { if (!hidden.has(a.id)) titles.set(a.id, a.title); });
      const rows = Array.isArray(idx.tracks) ? idx.tracks : [];
      const py = rows.length <= TRACK_PY_LIMIT;
      const hitsT = [];
      for (let i = 0; i < rows.length; i++) {
        const t = rowTrack(rows[i], idx);
        if (hidden.has(t.albumId)) continue;
        const s = py ? FM.search.scoreText(t.title, key) : (t.title.toLowerCase().indexOf(key) >= 0 ? 70 : 0);
        if (s > 0) hitsT.push({ t: t, s: s, albumTitle: titles.get(t.albumId) || '' });
      }
      hitsT.sort(function (x, y) {
        return (y.s - x.s) || U.naturalCompare(x.t.name, y.t.name);
      });
      hitsT.slice(0, LIB_TRACK_CAP).forEach(function (h) {
        out.tracks.push({ track: h.t, libId: lib.id, libName: libName, self: false, albumTitle: h.albumTitle });
      });
    });

    out.total = out.albums.length + out.tracks.length;
    return out;
  }

  function searchAll(q, opt) {
    const o = opt || {};
    const key = FM.search.normalize(q);
    const showHidden = !!o.showHidden;
    if (!key) {
      return { albums: [], tracks: [], pendingLibs: [],
        self: { id: libId, name: rootName || '当前资源库' }, total: 0 };
    }
    const ck = libId + '|' + key + '|' + (showHidden ? '1' : '0') + '|' + libsSignature();
    let res = (searchMemo.res && searchMemo.key === ck) ? searchMemo.res : null;
    if (!res) {
      res = computeAll(key, showHidden);
      searchMemo.key = ck;
      searchMemo.res = res;
    }
    if (o.scope !== 'cur') return res;
    const albums2 = res.albums.filter(function (r) { return r.self; });
    const tracks2 = res.tracks.filter(function (r) { return r.self; });
    return {
      albums: albums2, tracks: tracks2, pendingLibs: [], self: res.self,
      total: albums2.length + tracks2.length
    };
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
    /* 上报由 player.saveProgress 按 10 秒 / 强制点触发，这里只落本地缓存 */
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
    a.fav = !!(FM.fs.favIds && FM.fs.favIds.has(albumId));
    a.pinned = !!m.pinned;
    a.hidden = !!m.hidden;
    a.title = m.title || a.origTitle;
    const okIds = new Set(ensureCats().map(function (c) { return c.id; }));
    a.cats = (m.cats || []).filter(function (id) { return okIds.has(id); });
  }

  /* 收藏从数据库刷新后同步到内存模型（切库/拉取完成后调用） */
  function applyFavs(ids) {
    const set = ids instanceof Set ? ids : new Set(ids || []);
    albums.forEach(function (a) { a.fav = set.has(a.id); });
  }

  /* 曲目收藏单独一份，贴在每集上（播放条/收藏页用） */
  function applyTrackFavs(ids) {
    const set = ids instanceof Set ? ids : new Set(ids || []);
    tracks.forEach(function (t) { t.fav = set.has(t.id); });
  }

  /* ── 把改动推给数据库 ──
     本地缓存已经改好了（界面读的是缓存），这里只负责告诉 fs 该写什么。
     桌面本地库走 IPC、网页和手机走 HTTP，纯网页本地目录没有后端就直接忽略。 */
  function pushMeta(patch) {
    if (FM.fs && FM.fs.pushMeta) FM.fs.pushMeta(patch);
  }
  function albumPatch(key, meta) {
    const o = {};
    o[key] = meta || null;      /* null = 删掉这一行（取消归类 / 取消重命名） */
    return o;
  }

  /* 元数据从库里拉回来之后，把内存模型里的整理状态（分类 / 标题 / 置顶 / 隐藏）同步一遍。
     不重新扫描，只重算已有专辑，代价很小 */
  function refreshMeta() {
    ensureMetaKeys();
    albums.forEach(function (a) { recomputeAlbum(a.id); });
    albums.sort(albumSort);
    invalidateSearch();      /* 服务端拉回的改名 / 隐藏要立刻反映到搜索结果 */
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
    pushMeta({ albumMeta: albumPatch(key, m) });
    recomputeAlbum(albumId);
    albums.sort(albumSort);
    invalidateSearch();
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

  /* ── 分类 CRUD（都只影响当前库） ── */
  function cats() {
    let list = ensureCats();
    /* 平铺模式不展示「目录分类」（d 前缀）：那是按目录分两级时自动建的，
       切回平铺后没有专辑会挂上去，留着点进去就是空的 */
    if (!dirGroupMode) list = list.filter(function (c) { return String(c.id).charAt(0) !== 'd'; });
    return list.slice().sort((a, b) => a.order - b.order);
  }

  function addCat(name, color) {
    const list = cats();
    const id = 'c' + Date.now().toString(36);
    list.push({ id, name: name || '新分类', color: color || '#22d3ee', order: list.length });
    db.setCatsFor(libId, list);
    db.touch('cats:' + libId);
    pushMeta({ cats: list.sort((a, b) => a.order - b.order) });
    return id;
  }

  function updateCat(id, patch) {
    const list = cats().map(c => c.id === id ? Object.assign({}, c, patch) : c);
    db.setCatsFor(libId, list);
    db.touch('cats:' + libId);
    pushMeta({ cats: list });
  }

  /* 删分类只清当前库的归属：别的库同名 id（内置种子跨库同 id）不能被误伤 */
  function removeCat(id) {
    const list = cats();
    const gone = list.find(c => c.id === id);
    const rest = list.filter(c => c.id !== id);
    /* 目录分类（d 开头）删掉后记住名字：下次扫描不再自动建回来，
       否则用户永远删不干净这一栏 */
    if (gone && String(id).charAt(0) === 'd') rememberDroppedCat(gone.name);
    db.setCatsFor(libId, rest);
    db.touch('cats:' + libId);
    albums.forEach(function (a) { a.cats = a.cats.filter(x => x !== id); });
    /* rest 走 upsert 不会删行，另带 catsDeleted 让后端按 id 真正删掉这一条 */
    pushMeta({ cats: rest, catsDeleted: [id] });
    /* rootKey 还没定就宁可不动元数据，空前缀会匹配到所有库 */
    const prefix = rootKey ? rootKey + '|' : '';
    if (!prefix) return;
    const metas = db.albumMeta();
    const touched = {};
    Object.keys(metas).forEach(function (k) {
      if (k.indexOf(prefix) !== 0) return;
      const m = metas[k];
      if (m && m.cats && m.cats.indexOf(id) >= 0) { m.cats = m.cats.filter(x => x !== id); touched[k] = m; }
    });
    if (!Object.keys(touched).length) return;
    db.setAlbumMeta(metas);
    db.touch('albumMeta');
    pushMeta({ albumMeta: touched });
  }

  /* 老版本只有一份全局分类：一次性挪到喜马拉雅库（按库名自动认）。
     幂等靠 state.catMigrated；找不到目标库时不删旧键，下次启动再试。 */
  function migrateCats(libs) {
    const st = db.state();
    const res = { ran: false, reason: '', libId: '', libName: '', count: 0 };
    if (st.catMigrated) { res.reason = 'done'; return res; }
    const legacy = db.legacyCats();
    if (!Array.isArray(legacy)) {
      st.catMigrated = 1; db.setState(st); db.touch('state');
      res.reason = 'none'; return res;
    }
    const hit = (libs || FM.fs.libs() || []).filter(isXimalayaLib);
    if (!hit.length) { res.reason = 'nolib'; return res; }
    /* 命中多个时优先挑真在用的（有索引缓存）那个 */
    const target = hit.find(function (l) { return !!db.index(l.id); }) || hit[0];

    let next = legacy.slice();
    if ((st.seedVer || 1) < SEED_VER) {
      seedList().forEach(function (s) {
        if (!next.some(function (c) { return c.id === s.id; })) next.push(Object.assign({}, s, { order: next.length }));
      });
      st.seedVer = SEED_VER;
    }
    const cur = db.catsFor(target.id);
    /* 空 / 原封种子 = 这次启动刚种下的，用旧数据覆盖；否则是真实数据，保留 */
    if (cur === null || isPristineSeed(cur)) {
      db.setCatsFor(target.id, next);
      db.touch('cats:' + target.id);
    }
    if (FM.store.read('cats:legacy', null) === null) {
      FM.store.write('cats:legacy', legacy);
      FM.store.touch('cats:legacy');
    }
    FM.store.flush();               /* 备份先落盘，再删旧键 */
    db.dropLegacyCats();
    st.catMigrated = 1;
    db.setState(st);
    db.touch('state');
    FM.store.flush();

    res.ran = true; res.libId = target.id; res.libName = target.name; res.count = next.length;
    return res;
  }

  /* 一次性修复：上一版在「库列表还没加载」时给喜马拉雅库写了空分类，迁移又因此跳过，
     分类定义看起来就没了。备份还在 cats:legacy、专辑的归属也没动过，
     所以只在「专辑还指着这些已经不存在的分类」时把备份写回去（用户主动删掉的不会被搬回来）。 */
  function repairCats(libs) {
    const st = db.state();
    const mark = function () { st.catRepaired = 1; db.setState(st); db.touch('state'); };
    if (st.catRepaired) return null;
    const backup = FM.store.read('cats:legacy', null);
    if (!Array.isArray(backup) || !backup.length) { mark(); return null; }
    const hit = (libs || FM.fs.libs() || []).filter(isXimalayaLib);
    const target = hit.find(function (l) { return !!db.index(l.id); }) || hit[0];
    if (!target) return null;                   /* 还没有库：下次启动再试 */
    const cur = db.catsFor(target.id);
    if (!Array.isArray(cur) || cur.length) { mark(); return null; }
    const idx = db.index(target.id);
    const root = (idx && (idx.root || idx.rootName)) || '';
    if (!root) { mark(); return null; }
    const ids = new Set(backup.map(function (c) { return c.id; }));
    const prefix = root + '|';
    const metas = db.albumMeta();
    const used = Object.keys(metas).some(function (k) {
      return k.indexOf(prefix) === 0 && (metas[k].cats || []).some(function (id) { return ids.has(id); });
    });
    if (!used) { mark(); return null; }
    db.setCatsFor(target.id, backup.map(function (c, i) { return Object.assign({}, c, { order: i }); }));
    db.touch('cats:' + target.id);
    mark();
    return { libId: target.id, libName: target.name, count: backup.length };
  }

  /* 一个库都没有时把内存里的模型清干净 */
  function clear() {
    albums = []; tracks = []; rootName = ''; rootKey = ''; libId = ''; scannedAt = 0;
    setDirMode('flat');
    reindex();
  }

  FM.lib = {
    build, prime, restore, saveIndex, clear,
    ensureCats, groupFiles, dirCatId,
    dirMode: () => dirMode,
    isDirGroup: () => dirGroupMode,
    isAutoGroup: () => dirMode === 'auto',
    albums: () => albums,
    /* 索引缓存里的专辑视图（v1 / v2 都吃），给跨库搜索和库列表用 */
    indexAlbums: cached => indexAlbums(cached),
    tracks: () => tracks,
    allAlbums,
    album: id => albumMap.get(id) || null,
    track: id => trackMap.get(id) || null,
    albumTracks: id => byAlbum.get(id) || [],
    search, searchAll, invalidateSearch,
    stats,
    progressOf, setProgress, albumStat,
    setMeta, recomputeAlbum, refreshMeta, applyFavs, applyTrackFavs, catCount,
    cats, addCat, updateCat, removeCat, migrateCats, repairCats,
    catsOf: id => db.catsFor(id) || [],
    get rootName() { return rootName; },
    get rootKey() { return rootKey; },
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
      const one = {};
      one[trackId] = dur;
      pushMeta({ durations: one });
    }
  };
})(window.FM);
