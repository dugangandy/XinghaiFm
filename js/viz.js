/* ── viz.js · 频谱可视化 ─────────────────────────────── */
(function (FM) {
  'use strict';
  const U = FM.util;

  let ctx = null, srcNode = null, analyser = null, freq = null;
  let canvas = null, g = null, raf = 0, active = false, failed = false;
  let w = 0, h = 0, dpr = 1;
  let phase = 0;

  function attach() {
    if (ctx || failed) return !!ctx;
    /* 安卓壳里不接管音频输出：WebAudio 一旦被系统挂起（切后台、来电），
       走过它的声音就只剩静音图，而频谱本身只是装饰 */
    if (window.fmAndroid) { failed = true; return false; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { failed = true; return false; }
      ctx = new AC();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.82;
      /* 音频和视频各一个源，谁在放谁出声 */
      ['media', 'mediaAudio'].forEach(function (id) {
        const el = document.getElementById(id);
        if (!el) return;
        ctx.createMediaElementSource(el).connect(analyser);
      });
      srcNode = analyser;
      analyser.connect(ctx.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
      return true;
    } catch (e) {
      console.warn('[viz] 初始化失败，降级为纯播放', e);
      failed = true;
      ctx = null;
      return false;
    }
  }

  function resize() {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(1, Math.floor(r.width));
    h = Math.max(1, Math.floor(r.height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const BARS = 72;

  function draw() {
    raf = 0;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    if (!g || Math.abs(box.width - w) > 1 || Math.abs(box.height - h) > 1) resize();
    if (!g) return;
    g.clearRect(0, 0, w, h);

    const playing = FM.player.playing;
    const live = playing && analyser && ctx && ctx.state === 'running';
    if (live) analyser.getByteFrequencyData(freq);
    phase += 0.02;

    const gap = Math.max(2, w / 220);
    const bw = Math.max(2, (w - gap * (BARS - 1)) / BARS);
    const baseY = h * 0.84;
    const maxH = h * 0.72;
    const maxBin = Math.floor(freq ? freq.length * 0.34 : 170);

    /* 采样 + 归一化，让窄频段的人声也有层次 */
    const vals = new Array(BARS);
    let mx = 0;
    for (let i = 0; i < BARS; i++) {
      const t = i / BARS;
      let raw;
      if (live) {
        const idx = Math.floor(Math.pow(t, 2.1) * maxBin);
        raw = ((freq[idx] || 0) + (freq[idx + 1] || 0)) / 510;
      } else {
        raw = 0.05 + Math.abs(Math.sin(i * 0.26 + phase)) * 0.05;
      }
      vals[i] = raw;
      if (raw > mx) mx = raw;
    }

    const grad = g.createLinearGradient(0, baseY - maxH, 0, baseY);
    grad.addColorStop(0, 'rgba(244,114,182,.95)');
    grad.addColorStop(0.45, 'rgba(168,85,247,.9)');
    grad.addColorStop(1, 'rgba(34,211,238,.85)');

    g.save();
    g.fillStyle = grad;

    for (let i = 0; i < BARS; i++) {
      const t = i / BARS;
      let v;
      if (live) {
        v = mx > 0.02 ? Math.pow(vals[i] / mx, 0.7) * (0.5 + 0.8 * t) : 0.05 + t * 0.03;
      } else {
        v = vals[i];
      }
      v = Math.min(1, Math.max(0.03, v));
      const bh = Math.max(2, Math.pow(v, 1.15) * maxH);
      const x = i * (bw + gap);
      const y = baseY - bh;
      const r = Math.min(bw / 2, 3);
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, bw, bh, r); else g.rect(x, y, bw, bh);
      g.fill();

      /* 水面倒影 */
      if (bh > 8) {
        g.globalAlpha = 0.1;
        g.beginPath();
        if (g.roundRect) g.roundRect(x, baseY + 3, bw, bh * 0.34, r); else g.rect(x, baseY + 3, bw, bh * 0.34);
        g.fill();
        g.globalAlpha = 1;
      }
    }
    g.restore();

    /* 水面基线 */
    const line = g.createLinearGradient(0, 0, w, 0);
    line.addColorStop(0, 'rgba(34,211,238,.05)');
    line.addColorStop(0.5, playing ? 'rgba(34,211,238,.42)' : 'rgba(34,211,238,.14)');
    line.addColorStop(1, 'rgba(34,211,238,.05)');
    g.fillStyle = line;
    g.fillRect(0, baseY, w, 1);

    if (active) raf = requestAnimationFrame(draw);
  }

  function start() {
    active = true;
    if (!canvas) canvas = document.getElementById('viz');
    if (!canvas) return;
    resize();
    if (!raf) raf = requestAnimationFrame(draw);
  }

  function stop() {
    active = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (g) g.clearRect(0, 0, w, h);
  }

  FM.viz = {
    start, stop, attach, resize,
    get ok() { return !failed; },
    resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); }
  };

  window.addEventListener('resize', U.debounce(function () { if (active) resize(); }, 200));
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(function () { if (active) resize(); });
    document.addEventListener('DOMContentLoaded', function () {
      const c = document.getElementById('viz');
      if (c) ro.observe(c);
    });
  }
})(window.FM);
