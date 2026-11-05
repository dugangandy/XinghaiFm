/* ── stats.js · 收听时长统计引擎 ───────────────────────
 * 订阅播放事件，按真实墙钟秒数累计收听时长（暂停不计），按小时桶 + 分类桶拆分；
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
  let lastCats = [];
  let started = false;

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
      /* write 标脏 + flush 同步落盘；关页时浏览器不会等 Promise，这一步必须同步。
         同时把 local 通道刚 touch 过的 state 一并落盘，避免硬杀进程后
         「库里已有、WAL 还在」导致下次回放重复计 */
      FM.store.flush();
    } catch (e) {}
  }
  function loadWAL() {
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

  function accrue(sec, h, cats) {
    if (sec <= 0) return;
    const d = localDay();
    if (d !== dayStr) rollover(d);
    const list = (cats && cats.length) ? cats : ['__none__'];
    list.forEach(function (c) {
      const key = d + '|' + h + '|' + c;
      if (!pending[key]) pending[key] = { day: d, h: h, c: c, s: 0 };
      pending[key].s += sec;
    });
    rebuildToday();
    emit('tick');
  }

  function beat() {
    if (!playing) return;
    const now = Date.now();
    let dt = (now - lastTs) / 1000;
    if (dt <= 0) { lastTs = now; return; }
    if (dt > 60) dt = 60;   /* 休眠/卡顿后不要一次塞进巨大值 */
    const cats = lastCats.length ? lastCats : catsOfCurrent();
    lastCats = cats;
    accrue(dt, nowHour(), cats);
    lastTs = now;
  }

  function onState(st) {
    const now = Date.now();
    if (st) {
      playing = true;
      lastTs = now;
      lastCats = catsOfCurrent();
    } else {
      if (playing && lastTs) {
        let dt = (now - lastTs) / 1000;
        if (dt > 0 && dt <= 60) accrue(dt, nowHour(), lastCats.length ? lastCats : catsOfCurrent());
      }
      playing = false;
      lastTs = 0;
      flush();
    }
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

  function flush() { return enqueue(sendAll); }

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
      return {
        mode: mode, from: todayS, to: todayS, total: live.secs,
        bars: bars, todayIndex: nowHour(), todaySec: live.secs
      };
    }

    const span = mode === 'd30' ? 30 : 7;
    const from = addDays(todayS, -(span - 1));
    const rows = await range(from, todayS);
    const map = {}; rows.forEach(function (r) { map[r.day] = r; });
    const bars = [];
    for (let i = 0; i < span; i++) {
      const d = addDays(from, i);
      bars.push({ day: d, secs: map[d] ? map[d].secs : 0 });
    }
    const ti = span - 1;                        /* 今天固定在最后一根 */
    bars[ti].secs = live.secs;                  /* 今日柱用 base + 未落库余额 */
    let total = 0; bars.forEach(function (b) { total += b.secs; });
    return { mode: mode, from: from, to: todayS, total: total, bars: bars, todayIndex: ti, todaySec: live.secs };
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
    summary, range, fmt
  };

  if (typeof window !== 'undefined') init();
})(window.FM);
