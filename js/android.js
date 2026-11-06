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
  let lastPushKey = '';   /* 上次推给壳里的内容指纹，回前台时用来跳过没变化的重推 */

  function albumOf(track) {
    try { return track && track.albumId ? FM.lib.album(track.albumId) : null; } catch (e) { return null; }
  }

  /* 和下面 push() 推的内容一一对应：标题 / 专辑 / 封面 / 能否上下一集 / 是否在播 */
  function stateKey() {
    const p = FM.player;
    const t = p.current;
    const a = albumOf(t);
    const q = p.queue || [];
    return [
      t ? t.title : '',
      a ? a.title : '',
      a && a.cover ? a.cover : '',
      p.index > 0 ? 1 : 0,
      p.index >= 0 && q.length > 0 && p.index < q.length - 1 ? 1 : 0,
      p.nativeVideo ? 0 : (p.playing ? 1 : 0)
    ].join('\u0000');
  }

  /* 封面地址多半是站内相对路径（/api/cover/…）：壳里是原生直连下载，<img> 那套同源逻辑不生效，
     先补成绝对地址，壳那边再去拿（会话 cookie 也在壳里，见 PlaybackService.loadArtwork） */
  function coverUrl(a) {
    const u = a && a.cover ? String(a.cover) : '';
    if (!u) return '';
    try { return new URL(u, location.href).href; } catch (e) { return u; }
  }

  /* 通知栏/锁屏要显示的位置：媒体真挂上了用实时值，否则用上次听到的进度。
     以前 push() 不推进度，冷启动后锁屏那条要等第一帧 timeupdate 才有位置 */
  function progressFor(t) {
    const p = FM.player;
    if (p.loaded) {
      const el = p.media;
      return { p: (el && el.currentTime) || 0, d: (el && el.duration) || 0 };
    }
    let rec = null;
    try { rec = t ? FM.lib.progressOf(t.id) : null; } catch (e) {}
    if (rec && rec.p > 0) return { p: rec.p, d: rec.d || (t && t.duration) || 0 };
    return { p: 0, d: (t && t.duration) || 0 };
  }

  function push() {
    const p = FM.player;
    const t = p.current;
    const a = albumOf(t);
    const q = p.queue || [];
    const key = stateKey();
    try {
      NATIVE.setTrack(t ? t.title : '', a ? a.title : '', coverUrl(a));
      NATIVE.setNav(p.index > 0, p.index >= 0 && q.length > 0 && p.index < q.length - 1);
      NATIVE.setPlaying(p.nativeVideo ? false : !!p.playing);
      const pg = progressFor(t);
      pushProgress(pg.p, pg.d);
      lastPushKey = key;   /* 桥断了就走不到这里：下次回前台还会补推一次 */
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

  /* 播放详情页锁竖屏：只有音频那一页要禁横屏。
     视频走原生播放器、列表页/下载页都照旧跟随系统；
     旧 APK 没有这个桥方法（网页热更新、壳不更新），调用直接忽略 */
  function lockPortrait(on) {
    if (typeof NATIVE.lockPortrait !== 'function') return;
    try { NATIVE.lockPortrait(!!on); } catch (e) {}
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

  /* 当前资源库能看到的下载条目。壳里的索引是「所有库」合在一起的，
     直接摊给界面会让侧栏的下载数、下载管理页把别的库也算进来。
     只留下载时记下的 libId 跟当前库一致的；libId 为空的条目是早期没有这个字段时下的，
     仍算本库，免得老下载凭空消失；库还没就位（libId 为空）时不过滤，避免把界面清空。 */
  function libDownloads() {
    const cur = FM.lib && FM.lib.libId;
    if (!cur) return dlMap;
    const out = Object.create(null);
    const keys = Object.keys(dlMap);
    for (let i = 0; i < keys.length; i++) {
      const it = dlMap[keys[i]];
      if (!it.libId || it.libId === cur) out[keys[i]] = it;
    }
    return out;
  }

  /* 只有真正下完的才算「已下载」；排队中/下载中在 dlMap 里也有条目 */
  function downloaded(rel) {
    const e = rel && dlMap[rel];
    if (!e) return false;
    /* 别的库有同名 rel 时这条不算本库的下载 */
    if (e.libId && FM.lib && FM.lib.libId && e.libId !== FM.lib.libId) return false;
    return e.state === 'done' || !e.state;
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

  /* 返回键：从最上层的浮层往下收，返回 true 表示这次返回被网页消化了。
     各层浮层的关闭方式不一样（遮罩认 mousedown、菜单和封面预览认 click、播放页和侧栏认状态），
     统一交给 FM.ui.closeTopLayer，壳这边只负责全屏、搜索框和历史栈。 */
  function back() {
    if (document.body.classList.contains('app-fs')) { fullscreen(false); return true; }
    if (FM.ui && typeof FM.ui.closeTopLayer === 'function' && FM.ui.closeTopLayer()) return true;
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

  /* 原生推来的下载进度/状态 → 更新弹窗与菜单项。网页还没就绪时推的那几条先存着，
     弹窗打开时会再用 updateState() 主动拉一次，不会漏状态。 */
  let lastUpdate = null;
  function onUpdateProgress(json) {
    let data = null;
    try { data = json ? JSON.parse(json) : null; } catch (e) {}
    if (!data || !data.state) return;
    lastUpdate = data;
    try { if (FM.ui && FM.ui.updateProgress) FM.ui.updateProgress(data); } catch (e) {}
  }

  FM.android = {
    native: true,
    canDownload: true,
    download,
    downloads: function () { return libDownloads(); },
    downloaded,
    /* 已下载曲目的本机播放地址；旧 APK 没这个桥方法就返回空，播放回退到服务器 */
    localUrl: function (rel) { try { return NATIVE.localUrl(rel) || ''; } catch (e) { return ''; } },
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
    onUpdateProgress,
    back,
    fullscreen,
    lockPortrait,
    playVideo,
    onNativeVideo,
    get fullscreenOn() { return document.body.classList.contains('app-fs'); },
    openSettings: function () { try { NATIVE.openSettings(); } catch (e) {} },
    /* 退出登录：清壳里的会话 cookie/token 后回原生登录页。
       旧 APK 没这个桥方法（网页热更新、壳不更新），返回 false 让网页退回服务端登出 */
    logout: function () {
      if (typeof NATIVE.logout !== 'function') return false;
      try { NATIVE.logout(); return true; } catch (e) { return false; }
    },
    openDownloads: function () { try { NATIVE.openDownloads(); } catch (e) {} },
    base: function () { try { return NATIVE.baseUrl(); } catch (e) { return ''; } },
    version: function () { try { return NATIVE.version(); } catch (e) { return ''; } },

    /* ── 在线更新 ──
       下载/校验/安装都在壳里，网页只负责展示：进度靠原生回调 onUpdateProgress 推回来。
       旧 APK 没有这些桥方法（网页是热更新的，壳不是），canUpdate 用来降级提示。 */
    get canUpdate() { return typeof NATIVE.downloadApk === 'function'; },
    downloadApk: function (url, version, etag) {
      if (typeof NATIVE.downloadApk !== 'function') return false;
      try { NATIVE.downloadApk(url || '', version || '', etag || ''); } catch (e) { return false; }
      return true;
    },
    installApk: function () {
      if (typeof NATIVE.installApk !== 'function') return false;
      try { NATIVE.installApk(); } catch (e) { return false; }
      return true;
    },
    cancelUpdate: function () {
      try { if (typeof NATIVE.cancelDownload === 'function') NATIVE.cancelDownload(); } catch (e) {}
    },
    updateState: function () {
      try { return typeof NATIVE.updateState === 'function' ? (NATIVE.updateState() || '') : ''; } catch (e) { return ''; }
    },
    /* 不计费网络（Wi-Fi/以太网）：菜单查到新版时据此决定要不要静默预下载 */
    isWifi: function () {
      try { return typeof NATIVE.isWifi === 'function' ? !!NATIVE.isWifi() : false; } catch (e) { return false; }
    }
  };

  /* 原生视频播放页还在不在。旧 APK 没这个桥方法：一律当「还在」，
     调用方不用到处判断桥方法存不存在，行为也就退回改造前 */
  FM.android.videoAlive = function () {
    try {
      return typeof NATIVE.videoAlive === 'function' ? !!NATIVE.videoAlive() : true;
    } catch (e) {
      return true;
    }
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
  /* ── 手势收敛（壳内补刀）──
     网页层已经用 touch-action / user-select 把缩放和选字压住了，这里补原生路径拦不住的两处：
     1) 长按图片、链接时弹出的系统 contextmenu；
     2) iOS 那套 gesturestart（个别 WebView 也会派发，写上零成本）。
     输入控件与 .selectable 纯文字（库路径、服务器地址）一律放行，别把「长按复制」一起禁掉。 */
  const SELECTABLE = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),.selectable';
  function selectableAt(el) {
    return !!(el && el.nodeType === 1 && el.closest && el.closest(SELECTABLE));
  }
  document.addEventListener('contextmenu', function (e) {
    if (!selectableAt(e.target)) e.preventDefault();
  }, { passive: false });
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (type) {
    document.addEventListener(type, function (e) { e.preventDefault(); }, { passive: false });
  });

  /* 选字白名单 → 壳：壳里默认不建文本选择 ActionMode（MainActivity.NoSelectWeb），
     只在上面的两种情况放行。手指落下和焦点变化时各算一次；状态没变就不跨 JNI
     （老 APK 没这个方法，typeof 挡一下，此时壳里那条 startActionMode 覆写也不存在，互不影响；
     壳侧默认也是「允许」，所以没上报过的页面——比如不加载本脚本的登录页——保持原生行为）。 */
  let allowSelect = null;
  function reportSelect(on) {
    if (allowSelect === on) return;
    allowSelect = on;
    try { if (typeof NATIVE.setSelectAllowed === 'function') NATIVE.setSelectAllowed(on); } catch (e) {}
  }
  /* 手指落点优先：输入框失焦后如果还留着焦点，不能因此把整页选字放开 */
  document.addEventListener('touchstart', function (e) {
    reportSelect(selectableAt(e.target));
  }, { capture: true, passive: true });
  document.addEventListener('focusin', function (e) { reportSelect(selectableAt(e.target)); }, true);
  document.addEventListener('focusout', function () {
    /* 焦点已经移走，等一拍再看最终落点（从一个输入框直接点进另一个） */
    setTimeout(function () { reportSelect(selectableAt(document.activeElement)); }, 0);
  }, true);

  /* 回前台补一次状态。每次 syncMedia(true) 都是三次跨 JNI 调用，Java 侧每个还会重发
     一次通知栏，所以「秒切回来（瞄一眼通知）」这种内容没变就推的情况要省掉。
     但也不能无限省：Bridge.setPlaying 在播放时会顺带 PlaybackService.start()，这条推送
     同时是「服务被系统收掉后拉活」的心跳，离开够久就照旧推一次。
     注意只在「这一侧」去重：Java 的 PlaybackService.onCreate 靠 FM.android.syncMedia(true)
     强制重推来修首次推送丢失，那条路不能拦，所以 push() 本身不做去重。 */
  const HEARTBEAT_MS = 30000;
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (Date.now() - hiddenAt < HEARTBEAT_MS && stateKey() === lastPushKey) return;
    syncMedia(true);
  });

  /* 回前台自检：原生播放页已经不在了（被系统回收 / 被 MainActivity 清栈），
     网页却还停在「视频交给原生」，底栏播放键和封面就会全都没反应。
     这种把状态交回网页播放器；点播放会按队列和进度重新拉起原生播放页。
     （壳那边 onDestroy 会补一条 closed，这条只是兜住「JS 回调也丢了」的情况） */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (!FM.player.nativeVideo) return;
    if (FM.android.videoAlive()) return;
    FM.player.onNative('closed', {});
  });

  /* 首帧之后补一次，让通知栏在没播放时也有正确的标题；
     补完再告诉壳「网页就绪」，壳会把「App 没起来时通知栏按下的播放/暂停」补执行
     （旧 APK 没这个方法，typeof 挡一下） */
  setTimeout(function () {
    syncMedia(true);
    try { if (typeof NATIVE.ready === 'function') NATIVE.ready(); } catch (e) {}
  }, 1200);
  /* 已下载清单在首帧前拉一次，曲目列表第一眼就带标记 */
  refreshDownloads();

  /* 启动时静默查一次更新：有新版本弹一次轻提示（同一版本只提示一次），
     Wi-Fi 下顺带把包预下载好。放 5 秒后再发，别跟首屏和播放队列抢带宽。 */
  setTimeout(function () {
    try { if (FM.ui && FM.ui.checkUpdate) FM.ui.checkUpdate({ notify: true }); } catch (e) {}
  }, 5000);
})(window.FM);
