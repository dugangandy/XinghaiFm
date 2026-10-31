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
      NATIVE.setPlaying(p.nativeVideo ? false : !!p.playing);
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

  /* 视频交给原生播放器：整条队列 + 起始位置 */
  function playVideo(opts) {
    try { NATIVE.playVideo(JSON.stringify(opts || {})); } catch (e) {}
  }

  /* 原生播放器回传事件 → 播放内核 */
  function onNativeVideo(type, json) {
    let data = null;
    try { data = json ? JSON.parse(json) : null; } catch (e) {}
    try { if (FM.player && FM.player.onNative) FM.player.onNative(type, data); } catch (e) {}
  }

  /* 全屏：壳负责隐藏系统栏 + 横屏，网页只把画面铺满（WebView 的 requestFullscreen 不可靠） */
  function fullscreen(on) {
    const next = !!on;
    document.body.classList.toggle('app-fs', next);
    try { NATIVE.setFullscreen(next); } catch (e) {}
  }

  /* 曲目列表 → 壳里的下载队列。返回交给原生的条数；0 表示没提交（桌面/浏览器没这能力），
     真正入队几条由原生判定（已下载/已在队列的会跳过），结果由原生的 toast 告诉用户 */
  function download(list) {
    const items = (list || []).filter(function (t) { return t && t.rel; }).map(function (t) {
      const cut = t.rel.indexOf('/');
      return {
        libId: FM.lib.libId || '',
        libName: FM.fs.rootName || '',
        album: cut > 0 ? t.rel.slice(0, cut) : (FM.fs.rootName || '未分类单集'),
        rel: t.rel,
        title: t.title || t.name || '',
        ext: (t.ext || '').toLowerCase(),
        size: t.size || 0
      };
    });
    if (!items.length) return 0;
    try { NATIVE.downloadTracks(JSON.stringify(items)); } catch (e) { return 0; }
    return items.length;
  }

  /* ── 已下载清单 ─────────────────────────────────────────
   * 真实状态在壳里（Dl.snapshot），网页只持有一份 rel → 条目的字典：
   * 「下载管理」页列专辑、曲目行打已下载标记都靠它。
   */
  let dlMap = Object.create(null);

  function refreshDownloads() {
    let raw = '';
    try { raw = NATIVE.downloads() || ''; } catch (e) { return; }
    let list = [];
    try { list = JSON.parse(raw) || []; } catch (e) { return; }
    const next = Object.create(null);
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it && it.rel) next[it.rel] = it;
    }
    dlMap = next;
  }

  /* 只有真正下完的才算「已下载」；排队中/下载中在 dlMap 里也有条目 */
  function downloaded(rel) {
    const e = rel && dlMap[rel];
    return !!e && (e.state === 'done' || !e.state);
  }

  /* 手机剩余空间（字节）；拿不到就返回 0，界面按「未知」处理 */
  function freeSpace() {
    try { return Number(NATIVE.freeSpace()) || 0; } catch (e) { return 0; }
  }

  /* 删掉一个已下载曲目：文件和索引在壳里，删完壳会推 onChange */
  function removeDownload(rel) {
    if (!rel || typeof NATIVE.removeDownload !== 'function') return false;
    try { NATIVE.removeDownload(rel); } catch (e) { return false; }
    delete dlMap[rel];
    return true;
  }

  /* 批量删：只有一次桥调用，壳里删完统一推一次 */
  function removeDownloads(rels) {
    const list = (rels || []).filter(Boolean);
    if (!list.length || typeof NATIVE.removeDownloads !== 'function') return false;
    try { NATIVE.removeDownloads(JSON.stringify(list)); } catch (e) { return false; }
    for (let i = 0; i < list.length; i++) delete dlMap[list[i]];
    return list.length;
  }

  /* 壳在下载状态变化时回调：拉一次新清单，再让界面自己刷 */
  function onChange() {
    refreshDownloads();
    try { if (FM.ui && FM.ui.downloadsChanged) FM.ui.downloadsChanged(); } catch (e) {}
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
    canDownload: true,
    download,
    downloads: function () { return dlMap; },
    downloaded,
    freeSpace,
    removeDownload,
    removeDownloads,
    /* 旧 APK 没这些桥方法（网页是热更新的，壳不是），界面上要说清楚 */
    get canRemove() { return typeof NATIVE.removeDownload === 'function'; },
    get canRemoveMany() { return typeof NATIVE.removeDownloads === 'function'; },
    refreshDownloads,
    onChange,
    syncMedia,
    mediaAction,
    back,
    fullscreen,
    playVideo,
    onNativeVideo,
    get fullscreenOn() { return document.body.classList.contains('app-fs'); },
    openSettings: function () { try { NATIVE.openSettings(); } catch (e) {} },
    openDownloads: function () { try { NATIVE.openDownloads(); } catch (e) {} },
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
  /* 已下载清单在首帧前拉一次，曲目列表第一眼就带标记 */
  refreshDownloads();
})(window.FM);
