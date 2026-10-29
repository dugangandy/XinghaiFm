/* ── android.js · 安卓壳桥接 ─────────────────────────────
 * 只在 APK 里启用（window.fmAndroid 由壳注入），桌面版与浏览器模式完全不进这里。
 * 壳里不搬音频：锁屏/通知栏/耳机键的指令回到网页，由 player.js 照常播放。
 */
(function (FM) {
  'use strict';

  const NATIVE = typeof window !== 'undefined' && window.fmAndroid;
  if (!NATIVE) return;

  let lastPush = 0;
  let queued = 0;

  function albumOf(track) {
    try { return track && track.albumId ? FM.lib.album(track.albumId) : null; } catch (e) { return null; }
  }

  function push() {
    const p = FM.player;
    const t = p.current;
    const a = albumOf(t);
    const q = p.queue || [];
    try {
      NATIVE.setTrack(t ? t.title : '', a ? a.title : '');
      NATIVE.setNav(p.index > 0, p.index >= 0 && q.length > 0 && p.index < q.length - 1);
      NATIVE.setPlaying(!!p.playing);
    } catch (e) {
      /* 桥断了不影响播放 */
    }
  }

  /* 状态变一次推一次；连播、切集这种连发场景节流到 0.9 秒 */
  function syncMedia(force) {
    const now = Date.now();
    if (!force && now - lastPush < 900) {
      if (!queued) queued = setTimeout(function () { queued = 0; syncMedia(true); }, 900);
      return;
    }
    lastPush = now;
    push();
  }

  /* 通知栏 / 锁屏 / 耳机键 → 网页播放器 */
  function mediaAction(cmd) {
    const p = FM.player;
    if (cmd === 'play') p.play();
    else if (cmd === 'pause') p.pause();
    else if (cmd === 'next') p.next();
    else if (cmd === 'prev') p.prev();
    syncMedia(true);
  }

  /* 全屏：壳负责隐藏系统栏 + 横屏，网页只把画面铺满（WebView 的 requestFullscreen 不可靠） */
  function fullscreen(on) {
    const next = !!on;
    document.body.classList.toggle('app-fs', next);
    try { NATIVE.setFullscreen(next); } catch (e) {}
  }

  function $(id) { return document.getElementById(id); }

  /* 返回键：从最上层的浮层往下收，返回 true 表示这次返回被网页消化了 */
  function back() {
    if (document.body.classList.contains('app-fs')) { fullscreen(false); return true; }
    const modalRoot = $('modalRoot');
    if (modalRoot && modalRoot.childElementCount) {
      const mask = modalRoot.querySelector('.modal-mask') || modalRoot.querySelector('.lib-drawer-mask');
      if (mask) { mask.click(); return true; }
      modalRoot.innerHTML = '';
      return true;
    }
    const queue = $('queuePanel');
    if (queue && queue.classList.contains('open')) {
      const x = $('btnQueueClose');
      if (x) x.click(); else queue.classList.remove('open');
      return true;
    }
    const sheet = $('sheet');
    if (sheet && sheet.classList.contains('open')) {
      const x = $('btnCollapse');
      if (x) x.click(); else sheet.classList.remove('open');
      return true;
    }
    const sidebar = $('sidebar');
    if (sidebar && sidebar.classList.contains('open')) {
      const mask = $('drawerMask');
      if (mask) mask.click(); else sidebar.classList.remove('open');
      return true;
    }
    const input = $('searchInput');
    if (input && input.value) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (location.hash && location.hash !== '#/' && history.length > 1) {
      history.back();
      return true;
    }
    return false;
  }

  FM.android = {
    native: true,
    syncMedia,
    mediaAction,
    back,
    fullscreen,
    get fullscreenOn() { return document.body.classList.contains('app-fs'); },
    openSettings: function () { try { NATIVE.openSettings(); } catch (e) {} },
    base: function () { try { return NATIVE.baseUrl(); } catch (e) { return ''; } },
    version: function () { try { return NATIVE.version(); } catch (e) { return ''; } }
  };

  /* 播放进度 → 锁屏/通知栏进度条（节流到 1s；seek 大跳变或切集后首帧立即推） */
  let lastProgPush = 0;
  let lastPos = -1;
  let forceNextTime = false;
  function pushProgress(cur, dur) {
    const pos = Math.round((cur || 0) * 1000);
    const d = Math.round((dur || 0) * 1000);
    const now = Date.now();
    const jumped = lastPos >= 0 && Math.abs(pos - lastPos) > 2000;
    if (!forceNextTime && !jumped && now - lastProgPush < 1000) return;
    forceNextTime = false;
    lastProgPush = now;
    lastPos = pos;
    try { NATIVE.setProgress(pos, d); } catch (e) {}
  }
  FM.player.on('time', pushProgress);
  /* 切集后第一帧带新时长，必须立即推，否则锁屏会短暂沿用上一集的时长 */
  FM.player.on('track', function () { forceNextTime = true; lastPos = -1; });

  /* 播放状态是唯一需要主动上报的东西：其余（切集、界面）都在网页里 */
  FM.player.on('state', function () { syncMedia(true); });
  FM.player.on('track', function () { syncMedia(true); });
  FM.player.on('stop', function () { syncMedia(true); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) syncMedia(true);
  });

  /* 首帧之后补一次，让通知栏在没播放时也有正确的标题 */
  setTimeout(function () { syncMedia(true); }, 1200);
})(window.FM);
