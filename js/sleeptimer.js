/* ── sleeptimer.js · 睡眠定时的纯计算 ──────────────────
   调用方只关心「剩余多少毫秒」，这里不碰 DOM 和播放器，方便单独验证。 */
(function (FM) {
  'use strict';

  /* Material 的 fastOutSlowIn：cubic-bezier(0.4, 0, 0.2, 1)，和安卓端一致 */
  function cubicBezier(p1x, p1y, p2x, p2y, t) {
    const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
    const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
    const sampleX = u => ((ax * u + bx) * u + cx) * u;
    const sampleY = u => ((ay * u + by) * u + cy) * u;
    let lo = 0, hi = 1, u = t;
    for (let i = 0; i < 8; i++) {
      const x = sampleX(u);
      if (Math.abs(x - t) < 1e-5) break;
      if (x < t) lo = u; else hi = u;
      u = (lo + hi) / 2;
    }
    return sampleY(u);
  }

  function fastOutSlowIn(t) {
    t = Math.min(1, Math.max(0, t));
    return cubicBezier(0.4, 0, 0.2, 1, t);
  }

  /* 剩余 leftMs 时该乘的音量系数：进入淡出前恒为 1，淡出段按曲线降到 0 */
  function fadeRatio(leftMs, fadeMs) {
    if (!(fadeMs > 0)) return leftMs > 0 ? 1 : 0;
    if (leftMs >= fadeMs) return 1;
    const p = Math.max(0, leftMs) / fadeMs;
    return 1 - fastOutSlowIn(1 - p);
  }

  /* "22:30" → 1350 分钟 */
  function parseHM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return 0;
    return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
  }

  /* 时间段判断，支持跨零点；入参都是当天分钟数 */
  function inRange(nowMin, fromMin, toMin) {
    if (fromMin === toMin) return false;
    return fromMin < toMin
      ? nowMin > fromMin && nowMin < toMin
      : nowMin > fromMin || nowMin < toMin;
  }

  FM.sleep = {
    fastOutSlowIn, fadeRatio, parseHM, inRange
  };
})(window.FM);
