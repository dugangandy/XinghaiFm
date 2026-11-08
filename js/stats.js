/* ── stats.js · 收听时长统计引擎 ───────────────────────
 * 订阅播放事件，按真实墙钟秒数累计收听时长（暂停不计），按小时桶 + 分类桶拆分；
 * 每拍还会拿媒体位置的推进量校准墙钟，缓冲卡住 / 加载失败 / 系统挂起的时间不计，
 * 避免时长虚高（原生视频播放器读不到位置，退回墙钟 60 秒封顶）。
 * 经 FM.fs 落库（桌面 IPC / 服务端 HTTP / 纯网页 localStorage 降级）。
 * 提供三档聚合查询：今日 24 小时、近 7 天、近 30 天（均为含今天的滚动窗口）。
 *
 * 一致性约定：
 *   base    = 已确认落库的今日基线（只有 listenAdd 返回 ok 才累加）
 *   pending = 尚未确认落库的增量余额（按 day|hour|cat 分桶）
 *   today   = base + 当日 pending，永远是派生值，不单独维护
 * 所有写入与基线刷新走同一条串行队列，避免并发覆盖；未落库余额同步写 WAL，
 * 关页/切后台后下次启动回放，避免最后一段丢失。 */
(function (FM) {
  'use strict';
  const U = FM.util;

  /* ── 日期工具（本地日期 YYYY-MM-DD）── */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localDay(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDay(s) { const a = String(s).split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
  function addDays(s, n) { const d = parseDay(s); d.setDate(d.getDate() + n); return localDay(d); }

  function zeros() { return [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]; }
  function cloneBase(b) {
    const h = zeros();
    (b.byHour || []).forEach(function (v, i) { if (i < 24) h[i] = v; });
    return { secs: b.secs || 0, byHour: h, byCat: Object.assign({}, b.byCat || {}) };
  }
  function nowHour() { return new Date().getHours(); }

  /* ── 实时累加状态 ── */
  let dayStr = localDay();
  let base = { secs: 0, byHour: zeros(), byCat: {} };
  let today = cloneBase(base);
  const pending = {};                                      /* 'day|h|cat' -> { day, h, c, s } */
  let playing = false;
  let lastTs = 0;
  let lastPos = -1;
  let lastCats = [];
  let started = false;

  /* ── 专辑维度（专辑 Top5 榜）──
     和上面按天 / 小时 / 分类的桶完全独立：榜单口径是「历史累计」，没有日期维度，
     也不受页面时间档影响。分开一套 pending + WAL，避免污染现有余额格式。 */
  const ALBUM_WAL_KEY = 'listenAlbumPending';
  const albumPending = {};      /* 'libRoot|albumId' -> { libRoot, albumId, title, s } */
  let albumCtx = null;          /* { albumId, libRoot, title }，按当前曲目惰性刷新 */

  const bus = U.emitter();
  function emit(evt) { bus.emit(evt); }

  /* ── 串行队列：写入 / 基线刷新 / 页面打开都排队，杜绝并发覆盖 ── */
  let chain = Promise.resolve();
  function enqueue(fn) {
    const next = chain.then(fn, fn);
    chain = next.catch(function () {});
    return next;
  }

  /* ── WAL：未落库余额的同步快照（按 store 命名空间隔离，天然按用户分开）── */
  const WAL_KEY = 'listenPending';
  function walTag() { return String((FM.store && FM.store.namespace) || ''); }
  function saveWAL() {
    try {
      const buckets = Object.keys(pending).map(function (k) {
        const p = pending[k];
        return { day: p.day, h: p.h, c: p.c, s: p.s };
      });
      if (buckets.length) FM.store.write(WAL_KEY, { v: 1, tag: walTag(), buckets: buckets });
      else FM.store.drop(WAL_KEY);
      /* 专辑榜的余额同一个 key 空间里另存一份，flush 一次落盘 */
      const ab = Object.keys(albumPending).map(function (k) {
        const p = albumPending[k];
        return { r: p.libRoot, a: p.albumId, t: p.title, s: p.s };
      });
      if (ab.length) FM.store.write(ALBUM_WAL_KEY, { v: 1, tag: walTag(), buckets: ab });
      else FM.store.drop(ALBUM_WAL_KEY);
      /* write 标脏 + flush 同步落盘；关页时浏览器不会等 Promise，这一步必须同步。
         同时把 local 通道刚 touch 过的 state 一并落盘，避免硬杀进程后
         「库里已有、WAL 还在」导致下次回放重复计 */
      FM.store.flush();
    } catch (e) {}
  }
  function loadWAL() {
    loadTimeWAL();
    loadAlbumWAL();
  }
  function loadTimeWAL() {
    try {
      const w = FM.store.read(WAL_KEY, null);
      if (!w || w.tag !== walTag() || !Array.isArray(w.buckets)) { FM.store.drop(WAL_KEY); return; }
      w.buckets.forEach(function (b) {
        const s = Number(b.s);
        if (!b.day || !(s > 0)) return;
        const key = b.day + '|' + b.h + '|' + b.c;
        if (!pending[key]) pending[key] = { day: b.day, h: b.h, c: b.c, s: 0 };
        pending[key].s += s;
      });
      /* 不在这里清：等 sendAll 确认落库后 saveWAL 覆写为剩余余额，
         全部落库后才 drop，中途再崩也不会丢 */
    } catch (e) {}
  }
  /* 专辑余额单独回放：和时间余额互不牵连，一边的格式坏了不影响另一边 */
  function loadAlbumWAL() {
    try {
      const w = FM.store.read(ALBUM_WAL_KEY, null);
      if (!w || w.tag !== walTag() || !Array.isArray(w.buckets)) { FM.store.drop(ALBUM_WAL_KEY); return; }
      w.buckets.forEach(function (b) {
        const s = Number(b.s);
        const albumId = String((b && b.a) || '');
        const libRoot = String((b && b.r) || '');
        if (!albumId || !libRoot || !(s > 0)) return;
        const key = libRoot + '|' + albumId;
        if (!albumPending[key]) albumPending[key] = { libRoot: libRoot, albumId: albumId, title: String(b.t || ''), s: 0 };
        albumPending[key].s += s;
      });
    } catch (e) {}
  }

  let lastWarn = 0;
  function warnFlush() {
    const now = Date.now();
    if (now - lastWarn < 60000) return;
    lastWarn = now;
    console.warn('[stats] 收听数据暂时保存失败，已保留并将自动重试');
  }

  /* today 恒等于 base + 当日 pending，任何时刻重算都不会与落库结果打架 */
  function sumPending(day) {
    const out = { secs: 0, byHour: zeros(), byCat: {} };
    Object.keys(pending).forEach(function (k) {
      const p = pending[k];
      if (p.day !== day || !(p.s > 0)) return;
      out.secs += p.s;
      if (p.h >= 0 && p.h < 24) out.byHour[p.h] += p.s;
      out.byCat[p.c] = (out.byCat[p.c] || 0) + p.s;
    });
    return out;
  }
  function rebuildToday() {
    const extra = sumPending(dayStr);
    const byHour = base.byHour.map(function (v, i) { return v + extra.byHour[i]; });
    const byCat = Object.assign({}, base.byCat);
    Object.keys(extra.byCat).forEach(function (c) { byCat[c] = (byCat[c] || 0) + extra.byCat[c]; });
    today = { secs: base.secs + extra.secs, byHour: byHour, byCat: byCat };
  }

  function catsOfCurrent() {
    const t = FM.player && FM.player.current;
    if (!t) return [];
    const alb = FM.lib && FM.lib.album(t.albumId);
    return (alb && alb.cats) || [];
  }

  /* 跨午夜：立即切到新的一天，旧日 pending 保留待落库，不会记错日期 */
  function rollover(d) {
    dayStr = d;
    base = { secs: 0, byHour: zeros(), byCat: {} };
    rebuildToday();
    saveWAL();
    enqueue(refreshBase);
  }

  /* 当前曲目所属专辑 + 所属库。专辑中途切集/切换时 state 事件不一定发，
     所以每拍按 player.current 校验一次，变了才重新取专辑对象（开销只有一次字符串比较）。 */
  function albumCtxNow() {
    const t = FM.player && FM.player.current;
    if (!t || !t.albumId) return null;
    const albumId = String(t.albumId);
    const libRoot = String((FM.lib && FM.lib.rootKey) || '');
    if (albumCtx && albumCtx.albumId === albumId && albumCtx.libRoot === libRoot) return albumCtx;
    const alb = FM.lib && FM.lib.album(albumId);
    albumCtx = { albumId: albumId, libRoot: libRoot, title: alb ? String(alb.title || '') : '' };
    return albumCtx;
  }

  /* 一秒只记一次：放在分类循环外面，多分类专辑不会被乘上分类数 */
  function accrueAlbum(sec) {
    if (!(sec > 0)) return;
    const ctx = albumCtxNow();
    if (!ctx || !ctx.libRoot) return;         /* 还没进库，归属不了 */
    const key = ctx.libRoot + '|' + ctx.albumId;
    const row = albumPending[key] || { libRoot: ctx.libRoot, albumId: ctx.albumId, title: ctx.title, s: 0 };
    if (ctx.title) row.title = ctx.title;     /* 用户改名后以新快照为准 */
    row.s += sec;
    albumPending[key] = row;
  }

  function accrue(sec, h, cats) {
    if (sec <= 0) return;
    const d = localDay();
    if (d !== dayStr) rollover(d);
    accrueAlbum(sec);
    const list = (cats && cats.length) ? cats : ['__none__'];
    list.forEach(function (c) {
      const key = d + '|' + h + '|' + c;
      if (!pending[key]) pending[key] = { day: d, h: h, c: c, s: 0 };
      pending[key].s += sec;
    });
    rebuildToday();
    emit('tick');
  }

  /* ── 播放进度采样：用真实媒体位置的推进校准墙钟 ──
     只认 play/pause 事件会把「已点播放但还在缓冲 / 卡住不动 / 加载失败」的时间也算进去，
     这是时长虚高的主要来源。真正听了多少看位置推进了多少：
       add = min(墙钟, 位置推进 ÷ 倍速)
     位置不动就是 0，所以卡住的那一段不会进账。
     推进量先攒着，够 0.75 秒才结算一次：currentTime 采样粒度粗时只是延后结算，
     不会每拍都少算。后台被系统节流后墙钟一次跳很大，推进量仍能还原真实收听的时长。
     原生视频播放器读不到网页侧位置，退回墙钟（60 秒封顶，和以前一致）。 */
  let carryPos = 0;      /* 已推进、还没结算的内容秒数（按倍速折成收听秒） */
  let carryDt = 0;       /* 同一段还没结算的墙钟秒数，用来给结算量封顶 */
  let carryTs0 = 0;      /* 这一段开始累积的墙钟时刻，结算时按整点拆桶用 */

  function probe() {
    const p = FM.player;
    if (!p) return null;
    if (p.nativeVideo) return null;
    const el = p.media;
    if (!el || !el.src) return { pos: -1, rate: 1, running: false };
    const rate = Number(el.playbackRate) > 0 ? Number(el.playbackRate) : 1;
    return {
      pos: isFinite(el.currentTime) ? el.currentTime : -1,
      rate: rate,
      running: !el.paused && !el.ended
    };
  }

  /* 一段可能横跨整点（后台被挂起后一次补交）：按墙钟跨度把秒数分摊到各小时桶，
     否则「今日明细」会把几小时的量全压在补交那一刻，误报「单小时超 60 分」。
     短段 / 同一小时 / 跨天都不拆：跨天由 accrue 里的 rollover 兜住。 */
  function spread(add, t0, t1, cats) {
    const span = (t1 - t0) / 1000;
    const d0 = new Date(t0), d1 = new Date(t1);
    if (!(span > 60) || d0.getHours() === d1.getHours() || d0.toDateString() !== d1.toDateString() || span > 43200) {
      accrue(add, d1.getHours(), cats);
      return;
    }
    let cur = t0, left = add;
    const total = t1 - t0;
    while (left > 0.2 && cur < t1) {
      const d = new Date(cur);
      const end = Math.min(t1, new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime());
      const part = Math.min(left, add * (end - cur) / total);
      if (part > 0.2) { accrue(part, d.getHours(), cats); left -= part; }
      cur = end;
    }
  }

  function settle() {
    const add = Math.min(carryDt, carryPos);
    const t0 = carryTs0, t1 = Date.now();
    carryPos = 0;
    carryDt = 0;
    carryTs0 = 0;
    if (add <= 0.2) return;
    const cats = lastCats.length ? lastCats : catsOfCurrent();
    lastCats = cats;
    spread(add, t0 || t1, t1, cats);
  }

  function beat() {
    if (!playing) return;
    const now = Date.now();
    const dt = (now - lastTs) / 1000;
    lastTs = now;
    if (dt <= 0) return;
    const pr = probe();
    /* 事件漏了 pause（系统挂起 / 原生切走）：以媒体真实状态为准，别继续累加 */
    if (pr && !pr.running) { settle(); stop(); return; }
    if (!(carryTs0 > 0)) carryTs0 = now - dt * 1000;   /* 记下这段的起点 */
    carryDt += dt;
    if (pr && pr.pos >= 0) {
      if (lastPos < 0) carryPos += dt;                     /* 第一拍没有参照位置 */
      else if (pr.pos > lastPos) carryPos += (pr.pos - lastPos) / pr.rate;
      else if (pr.pos < lastPos) carryPos += dt;           /* 回拖 / 单曲循环回绕：这一段人还在听 */
      /* 位置没动 = 卡住，不计 */
      lastPos = pr.pos;
    } else {
      carryPos += Math.min(dt, 60);        /* 读不到位置：退回墙钟 */
    }
    if (carryPos < 0.75) return;           /* 攒够再结算 */
    settle();
  }

  function stop() {
    if (!playing) return;
    settle();          /* 卡住时这里结算出来是 0，缓冲/加载失败的时间不会进账 */
    playing = false;
    lastTs = 0;
    lastPos = -1;
    flush();
  }

  function onState(st) {
    if (st) {
      /* 重复的 play 事件不能重置计时起点，否则这段墙钟会被抹掉 */
      if (playing) return;
      playing = true;
      lastTs = Date.now();
      lastPos = -1;
      carryPos = 0;
      carryDt = 0;
      carryTs0 = 0;
      lastCats = catsOfCurrent();
      return;
    }
    if (!playing) return;
    beat();          /* 先把暂停前的最后一段按进度校准后记上 */
    stop();
  }

  /* 通道就绪判定：脚本加载执行 init() 时，fs.load() 的异步探测还没结束，
     服务端/远程会话此刻的 metaChannel() 仍是 local。若这时把 WAL 回放的秒数
     flush 出去，会写进 localStorage 而永远回不到服务端库。
     依据全部是同步可读的状态，不引入新的异步等待；未就绪时保留余额，下一轮重试。 */
  function channelReady() {
    try {
      const fs = FM.fs;
      if (!fs) return false;
      if (fs.remote) return !!fs.server;                    /* Electron 远程后端只认 http 通道 */
      if (fs.canSyncMeta && fs.canSyncMeta()) return true; /* ipc / http：通道已确定 */
      /* 到这里 metaChannel() === 'local'：serverReached 说明探测已结束
         （服务端会话但没配资源库时，本来就该写本地缓存），纯本地网页没有
         fm_uid 命名空间；只有「有命名空间但探测还没回来」才需要等。 */
      if (fs.serverReached) return true;
      return !FM.store.namespace;
    } catch (e) { return true; }
  }

  /* 快照扣减：await 期间 beat 继续累加的秒数留在 pending 余额里，
     只有服务端/IPC 明确 ok 的那一份才从余额扣除并计入 base */
  async function sendAll() {
    if (!channelReady()) return;                  /* 保留 pending，下一轮再试 */
    const keys = Object.keys(pending);
    if (!keys.length) return;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const p = pending[key];
      if (!p) continue;
      const sent = p.s;
      if (!(sent > 0)) { delete pending[key]; continue; }
      let res = null;
      try { res = await FM.fs.listenAdd(p.day, sent, p.h, p.c); }
      catch (e) { res = null; }
      if (!res || res.ok === false) { warnFlush(); continue; }   /* 保留余额，下次重试 */
      p.s -= sent;
      if (p.s <= 1e-6) delete pending[key];
      if (p.day === dayStr) {
        base.secs += sent;
        if (p.h >= 0 && p.h < 24) base.byHour[p.h] += sent;
        base.byCat[p.c] = (base.byCat[p.c] || 0) + sent;
      }
      /* 落库确认与 WAL 更新在同一段同步代码里：中间没有 await，
         浏览器不可能在两者之间杀掉页面，因此不会「已落库但 WAL 未扣」导致重复回放 */
      saveWAL();
    }
    rebuildToday();
  }

  /* 专辑榜落库：一次 flush 一个批量请求（服务端 items 上限 20 条，多出的下一轮再发）。
     单条增量封顶 ALBUM_CHUNK：服务端/落库层对 >3600 的条目是「丢弃但仍回 ok」，
     离线听了一小时以上再补交的话整条就没了，所以这里自己先切开，剩下的留着下一轮。 */
  const ALBUM_CHUNK = 1800;
  async function sendAlbumAll() {
    if (!channelReady()) return;                  /* 保留余额，下一轮再试 */
    const keys = Object.keys(albumPending);
    if (!keys.length) return;
    const batch = [];
    keys.slice(0, 20).forEach(function (k) {
      const p = albumPending[k];
      if (!p || !(p.s > 0)) return;
      batch.push({ albumId: p.albumId, libRoot: p.libRoot, title: p.title, deltaSecs: Math.min(p.s, ALBUM_CHUNK) });
    });
    if (!batch.length) return;
    let res = null;
    try { res = await FM.fs.listenAlbumAdd(batch); }
    catch (e) { res = null; }
    if (!res || res.ok === false) { warnFlush(); return; }   /* 保留余额，下次重试 */
    /* 落库层会静默过滤非法条目且仍然 ok，条数对不上说明这批里有被丢弃的。
       不再重试（重试也是同样的脏数据），但要留一条日志，别让差额无声消失 */
    if (typeof res.count === 'number' && res.count < batch.length) {
      console.warn('[stats] 专辑收听数据有 ' + (batch.length - res.count) + ' 条未被接受，已跳过');
    }
    /* 只扣快照那一份：await 期间 beat 继续累加的秒数留在余额里 */
    batch.forEach(function (it) {
      const k = it.libRoot + '|' + it.albumId;
      const p = albumPending[k];
      if (!p) return;
      p.s -= it.deltaSecs;
      if (p.s <= 1e-6) delete albumPending[k];
    });
    /* 落库确认与 WAL 更新在同一段同步代码里，中间没有 await */
    saveWAL();
  }

  function flush() {
    return enqueue(function () { return sendAll().then(sendAlbumAll); });
  }

  async function refreshBase() {
    if (!FM.fs) return;
    const qDay = dayStr;
    try {
      const r = await FM.fs.listenQuery(qDay, qDay);
      /* 查询失败/被限流时保留内存基线，别用空结果把已显示的数字抹成 0 */
      if (!r || r.ok === false) return;
      if (qDay !== dayStr) return;                    /* 排队期间跨天了，作废 */
      const rows = r.rows || [];
      /* 只认 qDay 那一行：万一某通道忽略了范围参数，也不能拿别的天当今日基线 */
      const row = rows.find(function (x) { return x && x.day === qDay; });
      base = row ? cloneBase({ secs: row.secs, byHour: row.byHour, byCat: row.byCat })
                 : { secs: 0, byHour: zeros(), byCat: {} };
      rebuildToday();
      emit('tick');
    } catch (e) {}
  }
  function refresh() { return enqueue(refreshBase); }

  function boundary() {
    saveWAL();     /* 同步：浏览器不等 async flush，这是最后一道保险 */
    flush();
  }

  function init() {
    if (started) return;
    started = true;
    loadWAL();
    if (FM.player && FM.player.on) FM.player.on('state', onState);
    setInterval(beat, 1000);
    setInterval(flush, 30000);   /* 每 30 秒节流落库 */
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', boundary);
      window.addEventListener('pagehide', boundary);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') { beat(); boundary(); }
      });
    }
    /* 回放的余额先留在 pending：等通道就绪后由 30 秒定时 / 暂停 / 切后台的
       flush 落库，不要在 init 这个「通道还没确定」的时刻就抢着写。
       refresh() 同样排队，读不到库时只保留内存基线，不会清空余额。 */
    refresh();
  }

  /* ── 公开查询 ── */
  function todayView() {
    rebuildToday();
    return { secs: today.secs || 0, byHour: today.byHour.slice(), byCat: Object.assign({}, today.byCat) };
  }

  async function range(fromDay, toDay) {
    if (!FM.fs) return [];
    try {
      const r = await FM.fs.listenQuery(fromDay, toDay);
      if (!r || r.ok === false) return [];
      return r.rows || [];
    } catch (e) { return []; }
  }

  /* 专辑 Top5 榜：libId 为空 = 全库合并，否则只看这个库。不受时间档影响。 */
  async function albumTop(libId, limit) {
    if (!FM.fs || !FM.fs.listenAlbumTop) return { ok: false, rows: [] };
    try { return await FM.fs.listenAlbumTop(libId || null, limit || 5); }
    catch (e) { return { ok: false, rows: [] }; }
  }

  /* 三档口径：day 看当天 0–23 时，d7 / d30 是含今天的滚动窗口。
     今日档直接取内存里的 byHour（base + 未落库余额），不再多查一次库。 */
  async function summary(mode) {
    if (mode === 'week') mode = 'd7';
    else if (mode === 'month') mode = 'd30';

    const todayS = localDay();
    const live = todayView();

    if (mode === 'day') {
      const bars = [];
      for (let h = 0; h < 24; h++) bars.push({ hour: h, secs: live.byHour[h] || 0 });
      /* byCat 给明细页做「这些时长花在哪些分类」；同一集属于多个分类时各计一次，
         所以分类之和可能大于总时长，这是口径而不是重复计时 */
      return {
        mode: mode, from: todayS, to: todayS, total: live.secs,
        bars: bars, todayIndex: nowHour(), todaySec: live.secs, byCat: live.byCat
      };
    }

    const span = mode === 'd30' ? 30 : 7;
    const from = addDays(todayS, -(span - 1));
    const rows = await range(from, todayS);
    const map = {}; rows.forEach(function (r) { map[r.day] = r; });
    const byCat = {};
    rows.forEach(function (r) {
      /* 今天那行用内存里的实时值（含未落库余额），别用库里可能偏旧的快照 */
      const src = r.day === todayS ? live.byCat : (r.byCat || {});
      Object.keys(src).forEach(function (k) { byCat[k] = (byCat[k] || 0) + src[k]; });
    });
    const bars = [];
    for (let i = 0; i < span; i++) {
      const d = addDays(from, i);
      const r = map[d];
      bars.push({ day: d, secs: r ? r.secs : 0, byHour: r ? r.byHour : null });
    }
    const ti = span - 1;                        /* 今天固定在最后一根 */
    bars[ti].secs = live.secs;                  /* 今日柱用 base + 未落库余额 */
    bars[ti].byHour = live.byHour;              /* 明细里的峰值时段同样用实时值 */
    let total = 0; bars.forEach(function (b) { total += b.secs; });
    return { mode: mode, from: from, to: todayS, total: total, bars: bars, todayIndex: ti, todaySec: live.secs, byCat: byCat };
  }

  function fmt(sec) {
    sec = Math.round(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h > 0) return h + '小时' + (m ? m + '分' : '');
    if (m > 0) return m + '分';
    return Math.floor(sec % 60) + '秒';
  }

  FM.stats = {
    init, on: function (evt, fn) { return bus.on(evt, fn); }, off: function (u) { if (typeof u === 'function') u(); },
    flush, today: todayView, refresh: refresh,
    summary, range, fmt, albumTop
  };

  if (typeof window !== 'undefined') init();
})(window.FM);
