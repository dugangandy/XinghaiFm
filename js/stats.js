/* ── stats.js · 收听时长统计引擎 ───────────────────────
 * 订阅播放事件，按真实墙钟秒数累计收听时长（暂停不计），按小时桶 + 分类桶拆分；
 * 经 FM.fs 落库（桌面 IPC / 服务端 HTTP / 纯网页 localStorage 降级）。
 * 提供今日/本周、连续天数、完成率、年度报告的聚合查询，以及 Canvas 分享图。
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
  function dateDiff(a, b) { return Math.round((parseDay(a) - parseDay(b)) / 86400000); }
  function weekRange(refDay) {
    const d = parseDay(refDay);
    const wd = (d.getDay() + 6) % 7;   /* 周一 = 0 */
    const mon = addDays(refDay, -wd);
    return { mon: mon, sun: addDays(mon, 6) };
  }

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
  let lastGoalMin = 0;

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

  async function summary(mode) {
    const todayS = localDay();
    let from, to;
    if (mode === 'week') { const w = weekRange(todayS); from = w.mon; to = w.sun; }
    else { to = todayS; from = addDays(todayS, -6); }
    const rows = await range(from, to);
    const map = {}; rows.forEach(function (r) { map[r.day] = r; });
    const live = todayView();
    const bars = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(from, i);
      bars.push({ day: d, secs: map[d] ? map[d].secs : 0 });
    }
    const ti = bars.findIndex(function (b) { return b.day === todayS; });
    if (ti >= 0) bars[ti].secs = live.secs;   /* 今日柱用 base + 未落库余额 */
    let total = 0; bars.forEach(function (b) { total += b.secs; });
    if (mode === 'day') total = live.secs;
    return { mode: mode, from: from, to: to, total: total, bars: bars, todayIndex: ti, todaySec: live.secs };
  }

  async function streak() {
    const rows = await range('2000-01-01', '2999-12-31');
    const set = {}; rows.forEach(function (r) { if (r.secs > 0) set[r.day] = true; });
    /* 今天正在听但尚未落库（30 秒节流）也要算进连听，否则少一天 */
    const todayS = localDay();
    if (todayView().secs > 0) set[todayS] = true;
    const daysSorted = Object.keys(set).sort();
    let longest = 0, run = 0;
    for (let i = 0; i < daysSorted.length; i++) {
      if (i > 0 && addDays(daysSorted[i - 1], 1) === daysSorted[i]) run++;
      else run = 1;
      if (run > longest) longest = run;
    }
    const lastDay = daysSorted.length ? daysSorted[daysSorted.length - 1] : null;
    let current = 0, broken = false;
    if (lastDay) {
      const gap = dateDiff(todayS, lastDay);
      if (gap <= 1) {
        current = 1; let d = lastDay;
        while (set[addDays(d, -1)]) { current++; d = addDays(d, -1); }
      } else broken = true;
    }
    return { current: current, longest: longest, broken: broken, listened: !!lastDay };
  }

  async function completion() {
    let goalMin = lastGoalMin;
    try {
      const g = await FM.fs.listenGoalGet();
      if (g && g.ok !== false) { goalMin = Number(g.min) || 0; lastGoalMin = goalMin; }
    } catch (e) {}
    const todaySec = todayView().secs;
    const pct = goalMin > 0 ? Math.min(100, Math.round(todaySec / (goalMin * 60) * 100)) : 0;
    return { goalMin: goalMin, todaySec: todaySec, pct: pct };
  }

  async function annual(year) {
    year = Number(year) || new Date().getFullYear();
    const from = year + '-01-01', to = year + '-12-31';
    const rows = await range(from, to);
    const monthly = new Array(12).fill(0);
    const byHour = zeros();
    const byCat = {};
    let total = 0;
    rows.forEach(function (r) {
      total += r.secs || 0;
      monthly[parseDay(r.day).getMonth()] += r.secs || 0;
      (r.byHour || zeros()).forEach(function (v, h) { if (h < 24) byHour[h] += v; });
      Object.keys(r.byCat || {}).forEach(function (c) { byCat[c] = (byCat[c] || 0) + (r.byCat[c] || 0); });
    });
    /* 最活跃时段：挑平均每小时最高的连续窗口（宽 1–3 小时），不跨午夜 */
    const peak = topWindow(byHour);
    return { year: year, total: total, monthly: monthly, byHour: byHour, byCat: byCat, peak: peak, days: rows.length };
  }

  function topWindow(byHour) {
    let best = { start: 0, end: 0, w: 1, avg: -1 };
    for (let w = 1; w <= 3; w++) {
      for (let h = 0; h <= 24 - w; h++) {
        let sum = 0;
        for (let k = 0; k < w; k++) sum += byHour[h + k];
        const avg = sum / w;
        if (avg > best.avg) best = { start: h, end: h + w - 1, avg: avg, w: w };
      }
    }
    return best.avg <= 0 ? { start: 0, end: 0, w: 1 } : best;
  }

  /* ── 分类解析 ── */
  function catMeta() {
    const m = {};
    try { (FM.lib.cats() || []).forEach(function (c) { m[c.id] = { name: c.name || c.id, color: c.color || '#64748b' }; }); } catch (e) {}
    return m;
  }
  function resolveCat(id, map) {
    if (id === '__none__') return { name: '未分类', color: '#64748b' };
    const m = map[id];
    if (m) return m;
    const P = ['#22d3ee','#a855f7','#34d399','#fbbf24','#f472b6','#60a5fa','#ff8a65','#9b8cff'];
    let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return { name: id, color: P[h % P.length] };
  }

  /* ── 分享图（Canvas → PNG）── */
  function drawGlow(g, x, y, r, color) {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, color); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  function drawMonthly(g, monthly, x, y, w, h) {
    const max = Math.max.apply(null, monthly) || 1;
    const bw = w / 13;
    g.textAlign = 'center';
    for (let i = 0; i < 12; i++) {
      const bh = Math.max(4, (monthly[i] / max) * (h - 30));
      const bx = x + i * bw + bw * 0.18;
      const bwi = bw * 0.64;
      const rg = g.createLinearGradient(0, y + h - bh, 0, y + h);
      rg.addColorStop(0, '#22d3ee'); rg.addColorStop(1, '#a855f7');
      g.fillStyle = rg;
      g.beginPath();
      if (g.roundRect) g.roundRect(bx, y + h - bh, bwi, bh, 6); else g.rect(bx, y + h - bh, bwi, bh);
      g.fill();
      g.fillStyle = '#6b7aa0'; g.font = '500 22px "PingFang SC",sans-serif';
      if (i % 2 === 0) g.fillText((i + 1) + '月', bx + bwi / 2, y + h + 22);
    }
  }
  function drawDonut(g, byCat, cx, cy, radius, map) {
    let total = 0; Object.keys(byCat).forEach(function (k) { total += byCat[k]; });
    if (total <= 0) return { total: 0, items: [] };
    let a0 = -Math.PI / 2;
    const items = [];
    const entries = Object.keys(byCat).map(function (k) { return { k: k, v: byCat[k] }; })
      .sort(function (x, y) { return y.v - x.v; });
    entries.forEach(function (e) {
      const ang = (e.v / total) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, radius, a0, a0 + ang);
      g.closePath();
      g.fillStyle = resolveCat(e.k, map).color;
      g.fill();
      a0 += ang;
      const meta = resolveCat(e.k, map);
      items.push({ name: meta.name, color: meta.color, pct: Math.round(e.v / total * 100) });
    });
    /* 中心挖空 */
    g.beginPath(); g.arc(cx, cy, radius * 0.6, 0, Math.PI * 2); g.fillStyle = '#0b1020'; g.fill();
    return { total: total, items: items };
  }
  function fmt(sec) {
    sec = Math.round(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h > 0) return h + '小时' + (m ? m + '分' : '');
    if (m > 0) return m + '分';
    return Math.floor(sec % 60) + '秒';
  }

  function buildShareImage(year) {
    return annual(year).then(function (data) {
      return new Promise(function (resolve, reject) {
        try {
          const W = 1080, H = 1680;
          const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
          const g = cv.getContext('2d');
          const bg = g.createLinearGradient(0, 0, W, H);
          bg.addColorStop(0, '#0b1020'); bg.addColorStop(0.55, '#0a0f1f'); bg.addColorStop(1, '#060810');
          g.fillStyle = bg; g.fillRect(0, 0, W, H);
          drawGlow(g, W * 0.82, H * 0.04, 360, 'rgba(34,211,238,0.16)');
          drawGlow(g, W * 0.12, H * 0.2, 340, 'rgba(168,85,247,0.15)');

          g.textAlign = 'center';
          g.fillStyle = '#eaf2ff'; g.font = '700 34px "PingFang SC","Microsoft YaHei",sans-serif';
          g.fillText('星海 FM · ' + data.year + ' 收听年报', W / 2, 96);

          g.fillStyle = '#22d3ee'; g.font = '800 140px "PingFang SC",sans-serif';
          g.fillText((data.total / 3600).toFixed(1), W / 2, 270);
          g.fillStyle = '#9fb2d4'; g.font = '500 32px "PingFang SC",sans-serif';
          g.fillText('小时 · 全年收听总时长', W / 2, 322);

          g.textAlign = 'left';
          g.fillStyle = '#cdd9f3'; g.font = '600 30px "PingFang SC",sans-serif';
          g.fillText('月度分布', 80, 400);
          drawMonthly(g, data.monthly, 80, 430, W - 160, 240);

          const pk = data.peak || { start: 0, end: 0, w: 1 };
          g.fillStyle = '#cdd9f3'; g.font = '600 30px "PingFang SC",sans-serif';
          g.fillText('最活跃时段', 80, 760);
          g.fillStyle = '#fbbf24'; g.font = '700 46px "PingFang SC",sans-serif';
          const eh = pk.end + 1;
          g.fillText(pad(pk.start) + ':00 – ' + pad(eh) + ':00', 80, 824);

          const map = catMeta();
          const donut = drawDonut(g, data.byCat, 300, 1120, 200, map);
          g.textAlign = 'left';
          g.fillStyle = '#cdd9f3'; g.font = '600 30px "PingFang SC",sans-serif';
          g.fillText('内容类型占比', 560, 980);
          let ly = 1030;
          donut.items.slice(0, 6).forEach(function (it) {
            g.fillStyle = it.color; g.beginPath(); g.arc(575, ly - 10, 12, 0, Math.PI * 2); g.fill();
            g.fillStyle = '#cdd9f3'; g.font = '500 28px "PingFang SC",sans-serif';
            g.fillText(it.name + '  ' + it.pct + '%', 600, ly);
            ly += 46;
          });

          g.textAlign = 'center';
          g.fillStyle = '#5b6b8f'; g.font = '500 24px "PingFang SC",sans-serif';
          g.fillText('— 你的私人星海，万物可听 —', W / 2, H - 48);

          cv.toBlob(function (blob) { if (blob) resolve(blob); else reject(new Error('toBlob failed')); }, 'image/png');
        } catch (e) { reject(e); }
      });
    });
  }

  FM.stats = {
    init, on: function (evt, fn) { return bus.on(evt, fn); }, off: function (u) { if (typeof u === 'function') u(); },
    flush, today: todayView, refresh: refresh,
    summary, streak, completion, annual, range,
    goalGet: function () { return FM.fs.listenGoalGet(); },
    goalSet: function (min) { return FM.fs.listenGoalSet(min); },
    buildShareImage, fmt, resolveCat, catMeta
  };

  if (typeof window !== 'undefined') init();
})(window.FM);
