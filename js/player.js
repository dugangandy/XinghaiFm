/* ── player.js · 播放内核 ─────────────────────────────── */
(function (FM) {
  'use strict';
  const U = FM.util;
  const RATES = [0.75, 1, 1.25, 1.5, 2, 3];

  /* 把倍速吸附到档位表里最接近的一档：旧版本存过 1.75x / 2.5x 这类已删掉的档 */
  function snapRate(r) {
    if (RATES.indexOf(r) >= 0) return r;
    return RATES.reduce(function (best, x) {
      return Math.abs(x - r) < Math.abs(best - r) ? x : best;
    }, RATES[0]);
  }
  const LOOPS = ['all', 'one', 'shuffle', 'off'];
  const LOOP_LABEL = { all: '列表循环', one: '单集循环', shuffle: '随机播放', off: '顺序播放' };
  const LOOP_ICON = { all: 'repeat', one: 'repeat1', shuffle: 'shuffle', off: 'repeat' };

  /* 音频走独立的 <audio>：安卓 WebView 里那个 <video> 藏在 display:none 的播放页里，
     暂停后再换源经常起不来（要杀掉 App 才能恢复），桌面 Chrome 没这毛病。
     视频仍然用 <video>，media 指向「当前在用的那一个」。 */
  const videoEl = document.getElementById('media');
  const audioEl = document.getElementById('mediaAudio');
  let media = videoEl;
  const ELS = [videoEl, audioEl].filter(Boolean);

  function stopEl(el) {
    try { el.pause(); } catch (e) {}
    try { el.removeAttribute('src'); el.load(); } catch (e) {}
  }
  function eachEl(fn) { ELS.forEach(function (el) { try { fn(el); } catch (e) {} }); }

  const ev = U.emitter();

  let queue = [];
  let index = -1;
  let cur = null;
  let objectUrl = null;
  let objectRevoke = null;
  let kind = 'audio';          // 当前这一集是音频还是视频
  let loadToken = 0;
  let saveAt = 0;
  let remoteSaveAt = 0;   // 上次把进度推给远程服务端的时间
  let mediaTrackId = null; // media 里实际装着的集；换集过渡期置空，避免把新集进度写成 0
  let savedSig = null;    // 上次落盘的内容指纹，同一位置不重复写
  let prepareCtrl = null; // 当前这次「等转码」的取消句柄，切集时 abort 掉
  let prepareRel = '';    // 正在等的是哪条文件：同一集重载时复用它，别杀刚转了一半的任务
  let pausedAt = 0;       // 上次暂停的时刻，用来判断恢复时要不要回退
  let pausedTrackId = null;
  /* 后台里暂停超过这么久，恢复播放前把数据源重挂一次：安卓 WebView 长时间空闲后
     音频输出可能已经被系统拆掉，play() 照样推进进度却没有声音 */
  const REARM_AFTER = 5 * 60 * 1000;
  /* 回到前台后的这段时间内恢复也算：坏掉的是音频输出，用户往往是先切回 App 再点播放键 */
  const REARM_GRACE = 2 * 60 * 1000;
  let rearming = false;   // 正在重挂数据源，别被并发的 play() 再来一次
  const NATIVE_OPEN_GAP = 2000;   // 拉起原生播放器的冷却，挡住双击/多入口重复拉起
  let nativeOpenAt = 0;
  let visibleAt = Date.now();
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) visibleAt = Date.now();
  });
  let sleepTimer = null;
  let sleepEnd = 0;
  let sleepMode = 0;        // 0 关闭 / 'time' 定时 / 'chapter' 本集播完
  let sleepTotal = 0;       // 定时总长（毫秒）
  let sleepLeft = 0;
  let fadeOn = false;       // 当前是否处于淡出（音量被临时压低）
  const SLEEP_FADE = 10000;       // 最后 10 秒淡出
  let artCache = new Map();
  let nativeVideo = false;    // 壳内视频交给原生播放器
  let nativePlaying = false;
  let nativeRemoteAt = 0;
  /* 播放页没打开时，视频只用 <audio> 放声音：画面看不见还让 Chromium 解码整幅画面，
     在没硬件加速的机器上很贵（收起播放页后 CPU 居高不下的原因）。 */
  let audioOnly = true;

  const st = FM.db.state();
  /* 账号级偏好（倍速 / 循环 / 自动回退）以数据库为准，本机只当缓存：
     离线首启动时 DB 还没拉到，先用上次缓存的 prefs */
  const prefCache = (FM.fs && FM.fs.prefsCache && FM.fs.prefsCache()) || {};
  let rate = snapRate(st.rate || prefCache.rate || 1);
  let volume = st.volume == null ? 1 : st.volume;      /* 音量是设备级，不跟账号走 */
  let loop = st.loop || prefCache.loop || 'all';
  let muted = false;
  /* 暂停多久之后恢复才回退：10 秒内基本是误触或短暂中断，退回去反而烦 */
  const AUTO_REWIND_AFTER = 10000;
  let autoRewind = st.autoRewind == null
    ? (prefCache.autoRewind == null ? 10 : (Number(prefCache.autoRewind) || 0))
    : (Number(st.autoRewind) || 0);
  let sleepAuto = st.sleepAuto || { on: false, from: '22:00', to: '07:00', minutes: 30 };

  function persistState(patch) {
    const s = FM.db.state();
    Object.assign(s, patch);
    FM.db.setState(s);
    FM.store.touch('state');
  }

  /* 账号级偏好：本地先落（乐观），再推给数据库；音量 / 睡眠定时是设备级，不进这里 */
  function pushPrefs(patch) {
    try { if (FM.fs && FM.fs.pushMeta) FM.fs.pushMeta({ prefs: patch }); } catch (e) {}
  }

  function setKind(next) {
    if (next === kind) return;
    kind = next;
    ev.emit('kind', kind);
  }

  function once(el, name) {
    return new Promise(function (res, rej) {
      let done = false, timer = 0;
      function cleanup() {
        el.removeEventListener(name, on);
        el.removeEventListener('error', onErr);
        clearTimeout(timer);
      }
      function on() { if (done) return; done = true; cleanup(); res(); }
      /* 直链过期 / 403 时立刻报错，别让用户干等超时。
         网盘直链要 302 到 CDN，首包可能慢，兜底超时放宽到 15 秒。 */
      function onErr() {
        if (done) return;
        done = true; cleanup();
        const me = el.error || {};
        const code = Number(me.code) || 0;
        /* 4 = 编码/源不支持（视频常见于 H.265/HEVC）；2 = 网络中断（直链失效/上游拒绝） */
        const msg = code === 4
          ? '媒体源或编码不被浏览器支持（视频常见于 H.265），请转成 H.264 后再试'
          : (code === 2 ? '直链加载失败，请重新扫描后再试' : '媒体加载失败，请重试或重新扫描');
        const err = new Error(msg);
        err.code = 'media';
        err.mediaCode = code;
        rej(err);
      }
      el.addEventListener(name, on);
      el.addEventListener('error', onErr);
      timer = setTimeout(function () { if (done) return; done = true; cleanup(); res(); }, 15000);
    });
  }

  /* ── 媒体会话封面 ── */
  function artworkFor(album) {
    if (!album) return Promise.resolve(null);
    if (artCache.has(album.id)) return Promise.resolve(artCache.get(album.id));
    /* 抓到的专辑封面直接用，省掉现画一张渐变图 */
    if (album.cover) return Promise.resolve(album.cover);
    return new Promise(function (res) {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 512;
        const g = c.getContext('2d');
        const cc = U.coverColors(album.seed);
        const grd = g.createLinearGradient(0, 0, 512, 512);
        grd.addColorStop(0, cc[0]);
        grd.addColorStop(1, cc[1]);
        g.fillStyle = grd;
        g.fillRect(0, 0, 512, 512);
        g.fillStyle = 'rgba(255,255,255,.16)';
        g.beginPath(); g.arc(120, 90, 210, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(255,255,255,.92)';
        g.font = '700 190px "PingFang SC","Microsoft YaHei",sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(U.initials(album.title), 256, 268);
        c.toBlob(function (b) {
          const url = b ? URL.createObjectURL(b) : null;
          if (url) artCache.set(album.id, url);
          res(url);
        }, 'image/png');
      } catch (e) { res(null); }
    });
  }

  /* ── MediaSession ── */
  async function updateSession(track) {
    if (!('mediaSession' in navigator)) return;
    const album = track ? FM.lib.album(track.albumId) : null;
    try {
      const art = await artworkFor(album);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track ? track.title : '星海 FM',
        artist: album ? album.title : '',
        album: FM.lib.rootName || '本地资源库',
        artwork: art ? [{ src: art, sizes: '512x512', type: /\.png$/i.test(art) ? 'image/png' : 'image/jpeg' }] : []
      });
    } catch (e) {}
  }

  function bindSession() {
    if (!('mediaSession' in navigator)) return;
    const set = function (action, fn) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) {}
    };
    set('play', () => play());
    set('pause', () => pause());
    set('previoustrack', () => prev());
    set('nexttrack', () => next());
    set('seekbackward', d => seek(media.currentTime - (d.seekOffset || 15)));
    set('seekforward', d => seek(media.currentTime + (d.seekOffset || 15)));
    set('seekto', d => { if (d.seekTime != null) seek(d.seekTime); });
  }

  /* ── 载入音轨 ── */
  async function load(track, opts) {
    const o = opts || {};
    const my = ++loadToken;
    if (cur && cur.id !== track.id) saveProgress(true);   // 换集前先把旧集落盘
    mediaTrackId = null;                                   // 过渡期的 pause/emptied 一律不算
    pausedAt = 0; pausedTrackId = null;                    // 换集不触发自动回退
    cur = track;
    /* 壳内视频：整条队列交给原生播放器，网页不碰 <video> */
    if (track.kind === 'video' && FM.android) {
      nativeVideo = true;
      nativePlaying = false;
      try { if (audioEl) stopEl(audioEl); } catch (e) {}
      setKind('video');
      ev.emit('track', track, { restored: false });
      updateSession(track);
      /* 选集列表用整张专辑的视频集，保证条目完整（不受当前队列子集影响） */
      const albumAll = FM.lib.albumTracks(track.albumId).filter(function (t) { return t.kind === 'video'; });
      const listSrc = albumAll.length ? albumAll : (queue.length ? queue : [track]);
      let idx = listSrc.findIndex(function (t) { return t.id === track.id; });
      if (idx < 0) idx = 0;
      const list = listSrc.map(function (t) {
        const alb = FM.lib.album(t.albumId);
        return { rel: t.rel, id: t.id, title: t.title, sub: alb ? alb.title : '' };
      });
      const p0 = FM.lib.progressOf(track.id);
      let start0 = o.seek;
      if (start0 == null && p0 && p0.p > 3 && (!p0.d || p0.p < p0.d - 8)) start0 = p0.p;
      FM.android.playVideo({
        list: list,
        index: idx,
        start: Math.max(0, Math.round((start0 || 0) * 1000)),
        autoplay: o.autoplay !== false
      });
      return;
    }
    nativeVideo = false;
    /* 先按当前状态挂一个元素上去：这样 stopEl 触发的 pause 事件会因为 el !== media
       被忽略，换集瞬间界面不会闪成「已停止」。真正用哪个等 src 就绪后再确认一次。 */
    let el = (track.kind === 'video' && !audioOnly) ? videoEl : audioEl;
    if (media !== el) { if (media) stopEl(media); media = el; }
    setKind(track.kind === 'video' ? 'video' : 'audio');
    /* 切集就把上一次还在排队的转码取消掉：只让页面「不等了」不够，主进程/服务端
       那边还得停掉 ffmpeg，否则连点几集会在后台排一串没人要的转码，服务端还会
       把 HTTP 连接占满（同域只有 6 条，占满后连播放都会卡住）。
       同一集的重载（收起播放页转 audio、恢复进度）要复用同一个请求：
       杀掉了再重来，等于把刚转的那一半白白丢掉。 */
    const sameTc = !!prepareCtrl && prepareRel === track.rel;
    if (prepareCtrl && !sameTc) {
      try { prepareCtrl.abort(); } catch (e) {}
      prepareCtrl = null;
      prepareRel = '';
    }
    /* restored 决定界面要不要为视频自动展开播放页。setAudioOnly 触发的重载是
       在收起播放页时发生的，不能再让界面把它拉回来。 */
    ev.emit('track', track, { restored: !!o.restored });
    updateSession(track);
    /* 明确不支持的格式（ape / wv / wma）：直接给结论。别放它走到 <audio> 才报
       「播放失败」，更别去转码 —— 转一份要几十秒，等完还不如告诉用户换个文件。 */
    if (FM.media.unsupported(track.ext)) {
      const err = new Error('不支持的文件格式');
      err.code = 'unsupported';
      err.ext = String(track.ext || '').toLowerCase();
      ev.emit('error', err);
      return;
    }
    try {
      /* flv 交给后端先重封装成 mp4：首次要等一会儿，之后同一文件走缓存；
         传 { prepare:true } 是因为时长探测也会调 src()，
         不能让它顺手把整张专辑都转一遍。 */
      const needTc = FM.media.needsTranscode(track.ext);
      let s;
      if (needTc) {
        if (!sameTc) { prepareCtrl = new AbortController(); prepareRel = track.rel; }
        ev.emit('preparing', track);
      } else {
        /* 不需要转码的这一集要顺手把上一次的等待提示收掉：用户可能在上一次转码
           还没结束时就切到了 mp3 集，那层提示是 pointer-events:auto 的，留着会
           一直盖在界面上连点击都拦住（它的 finally 因为切集了不会执行）。 */
        ev.emit('preparing', null);
      }
      try {
        s = await FM.fs.src(track.rel, { prepare: true, signal: prepareCtrl ? prepareCtrl.signal : undefined });
      } finally {
        /* 切集了就别再关别人的加载态：只有当前这次载入负责收尾 */
        if (needTc && my === loadToken) {
          ev.emit('preparing', null);
          prepareCtrl = null;
          prepareRel = '';
        }
      }
      if (my !== loadToken) { if (s && s.revoke) s.revoke(); return; }
      /* 视频集在播放页收起时走 <audio>：同一个文件，只是不让它解码视频轨道。
         上面 emit('track') 之后界面可能自动展开播放页、把 audioOnly 改回来，所以这里再确认。 */
      const asAudio = audioOnly && track.kind === 'video';
      let want = (track.kind === 'video' && !asAudio) ? videoEl : audioEl;
      /* 无 CORS 头、又是跨源的源：网盘直链，以及本机 127.0.0.1 的已下载文件（APK）。
         这两种源播放时声明 crossorigin 会被浏览器按 CORS 校验拦掉（Chrome 报
         MEDIA_ERR_SRC_NOT_SUPPORTED），表现就是转圈几秒后「播放失败」。 */
      const noCors = !!s && (s.alist || s.local);
      /* 音频元素一旦被 viz 接进 WebAudio 就退不出来，播这类源只会静音：
         这种情况改用 <video> 播同一个文件，保留原生输出（频谱这部分降级）。 */
      if (noCors && want === audioEl && FM.viz && FM.viz.taken && FM.viz.taken(audioEl)) want = videoEl;
      if (want !== el) { stopEl(el); media = el = want; }
      if (objectRevoke) { objectRevoke(); objectRevoke = null; }
      objectUrl = s.url;
      objectRevoke = s.revoke;
      /* 远程库的媒体是跨源的：不声明 CORS，WebAudio 的 MediaElementSource 会把采样全输出 0（进度条走、没声音）。
         noCors 的源（网盘直链、本机已下载文件）上游/小服务都没有 ACAO 头，声明 anonymous
         会直接加载失败，这里强制不声明（null 是「移除属性」；空串反而是 anonymous）；
         同时打标记，viz 接手前会跳过这个元素。 */
      if (noCors) {
        el.removeAttribute('crossorigin');
        el.dataset.fmNoCors = '1';
      } else {
        el.crossOrigin = FM.fs.remote ? 'anonymous' : '';
        delete el.dataset.fmNoCors;
      }
      el.src = objectUrl;
      el.playbackRate = rate;
      el.volume = volume;
      el.muted = muted;
      el.load();
      await once(el, 'loadedmetadata');
      if (my !== loadToken) return;
      /* 扩展名说是视频、实际只有音轨（或者反过来）时以真实轨道为准。
         asAudio 时用的一定是 <audio>，videoWidth 恒为 0，别拿它把 kind 改掉。 */
      if (!asAudio) setKind(el.videoWidth > 0 ? 'video' : 'audio');
      const dur = isFinite(el.duration) ? el.duration : (track.duration || 0);
      if (dur > 0) FM.lib.setDuration(track.id, dur);
      const p = FM.lib.progressOf(track.id);
      let start = o.seek;
      if (start == null && p && p.p > 3 && (!p.d || p.p < p.d - 8)) start = p.p;
      if (start && start > 0) {
        el.currentTime = dur ? Math.min(start, Math.max(0, dur - 1)) : start;
      }
      mediaTrackId = track.id;   // 位置已就位，从这里开始才允许落盘
      ev.emit('time', el.currentTime, dur);
      if (o.autoplay) {
        armRecover(el, my);
        await play();
      } else ev.emit('state', false);
    } catch (e) {
      if (my !== loadToken) return;
      /* 取消（切集 / 收起播放页）不是播放失败，不弹提示 */
      if (e && e.code === 'aborted') return;
      ev.emit('error', e);
    }
  }

  /* 安卓 WebView 上偶发「换源后 play() 一直不落地」：进度不动、没有声音也不报错。
     2 秒还没起来就把数据源重挂一次，只试一次，正常播放时不会走到这里。 */
  function armRecover(el, my) {
    setTimeout(function () {
      if (my !== loadToken || !cur) return;
      if (!el.paused || el.error || el.readyState >= 2) return;
      try { el.load(); el.play(); } catch (e) {}
    }, 2000);
  }

  /* 播放页收起 / 展开时切换承载媒体。
     收起后换 <audio> 播同一个文件：Chromium 没有视频渲染目标就不会去解码画面，
     只剩音轨。位置和播放状态原样接过去，界面上看起来只是换了个标签。 */
  function setAudioOnly(on) {
    on = !!on;
    if (on === audioOnly) return;
    audioOnly = on;
    if (nativeVideo || !cur || cur.kind !== 'video' || !media.src) return;
    const pos = media.currentTime || 0;
    const wasPlaying = !media.paused;
    /* restored: true —— 这是同一集的重新载入，界面别把视频播放页又弹开 */
    load(cur, { seek: pos, autoplay: wasPlaying, restored: true });
  }

  /* ── 停止并清空（切换资源库时用） ── */
  function stop() {
    if (cur) saveProgress(true);
    /* 切库/清空时把还在排队的转码也撤掉：资源库都换了，转出来的文件没人要 */
    if (prepareCtrl) { try { prepareCtrl.abort(); } catch (e) {} prepareCtrl = null; prepareRel = ''; }
    mediaTrackId = null;
    pausedAt = 0; pausedTrackId = null;
    eachEl(stopEl);
    queue = [];
    index = -1;
    cur = null;
    ev.emit('stop');
    ev.emit('queue', queue, index);
  }

  /* ── 播放控制 ── */
  /* 长时间后台暂停后恢复播放：安卓壳里 Chromium 可能已经把音频输出拆掉了，
     play() 照样落地、进度照走、通知栏也显示在播，但一点声音都没有。
     网页层拿不到「是否真的出声」（壳里 WebAudio 是禁用的），只能先重挂一次数据源，
     让解码/输出管线重建；短暂停不走这条路，不折腾。
     返回 false 表示期间用户切了集 / 按了暂停，调用方别再硬起播。
     重挂失败（源失效、拿不到元数据）不拦播放：返回 true，让原来的 play() 自己去报错。 */
  async function rearm(el, my, at) {
    try {
      const pos = el.currentTime || 0;
      const r0 = el.playbackRate;
      el.load();
      await once(el, 'loadedmetadata');
      if (my !== loadToken || el !== media || pausedAt !== at) return false;
      /* 元数据没到（超时/源失效）：别硬 seek，也别改倍速，交给 play() */
      if (el.readyState < 1) return true;
      const d = el.duration;
      const to = (isFinite(d) && d > 0) ? Math.min(pos, Math.max(0, d - 0.5)) : pos;
      if (to > 0) { try { el.currentTime = to; } catch (e) {} }
      el.playbackRate = r0;
      ev.emit('time', el.currentTime, isFinite(d) ? d : 0);
      return true;
    } catch (e) {
      return true;
    }
  }

  /* 这次恢复要不要重挂数据源：同一条内容、停够久，且「现在在后台」或「刚回到前台不久」
     —— 坏掉的是音频输出，用户经常是先切回 App 再点播放键，只认 document.hidden 会漏掉这条 */
  function needsRearm() {
    if (rearming || !pausedAt || !cur || pausedTrackId !== cur.id) return false;
    if (Date.now() - pausedAt < REARM_AFTER) return false;
    return document.hidden || (Date.now() - visibleAt < REARM_GRACE);
  }

  /* 壳内视频：原生播放页已经不在了（被系统回收 / 被 MainActivity 清栈），
     网页这边却还停在「视频交给原生」，底栏播放键、封面点击就全都没反应。
     这种按当前队列和进度把原生播放页重新拉起来；页面还在（后台放着）就什么都不做。
     opts.autoplay：点播放键要接着播；点封面只是回到界面，别硬起播。 */
  function openNative(opts) {
    const o = opts || {};
    if (!FM.android || !cur || cur.kind !== 'video') return false;
    if (FM.android.videoAlive()) return false;
    /* 原生页从 startActivity 到 onCreate 登记 current 有几百毫秒空窗，双击/多入口
       会在这里各拉一次；singleTop 会让第二次走 onNewIntent 从头重播，先挡一下 */
    if (Date.now() - nativeOpenAt < NATIVE_OPEN_GAP) return false;
    nativeOpenAt = Date.now();
    nativeVideo = false;
    nativePlaying = false;
    ev.emit('state', false);
    load(cur, { autoplay: o.autoplay !== false });
    return true;
  }

  async function play() {
    if (!cur) return;
    if (nativeVideo) { openNative({ autoplay: true }); return; }
    if (!media.src) { await load(cur, { autoplay: true }); return; }
    if (needsRearm()) {
      rearming = true;
      try {
        if (!(await rearm(media, loadToken, pausedAt))) return;
      } finally {
        rearming = false;
      }
    }
    try {
      await media.play();
    } catch (e) {
      if (e && e.name !== 'AbortError') ev.emit('error', e);
    }
  }

  function pause() { if (nativeVideo) return; if (media.src) media.pause(); }

  function toggle() {
    if (!cur) return;
    if (nativeVideo) { openNative({ autoplay: true }); return; }
    if (media.paused) play(); else pause();
  }

  function seek(t) {
    if (nativeVideo) return;
    if (!media.src || !isFinite(media.duration)) return;
    media.currentTime = U.clamp(t, 0, media.duration || 0);
    ev.emit('time', media.currentTime, media.duration);
    saveProgress(true, false);   // 拖动后立刻落盘；远程仍按 10 秒节流，别按一下推一次
    pausedAt = 0; pausedTrackId = null;   // 用户自己选的位置，恢复时别再回退
  }

  function seekRatio(r) {
    if (!media.src || !isFinite(media.duration)) return;
    seek((media.duration || 0) * U.clamp(r, 0, 1));
  }

  function jumpBy(dt) { seek((media.currentTime || 0) + dt); }

  /* ── 当前队列持久化（按用户 + 库）──
     队列以前只在内存里，刷新 / 换设备就没了。现在变化 1 秒后推给数据库，
     启动时先按本机缓存撑起来，服务端下发后再校正。 */
  let queueSaveTimer = 0;
  let queueRestored = false;   /* 当前队列来自持久化，不是用户刚点的 */
  function saveQueueSoon() {
    clearTimeout(queueSaveTimer);
    queueSaveTimer = setTimeout(function () {
      if (!queue.length) return;
      try {
        if (FM.fs && FM.fs.pushMeta) {
          FM.fs.pushMeta({ queue: { tracks: queue.map(function (t) { return t.id; }), position: index } });
        }
      } catch (e) {}
    }, 1000);
  }
  function restoreQueue(saved, opts) {
    const o = opts || {};
    if (!saved || !Array.isArray(saved.tracks) || !saved.tracks.length) return false;
    /* 正在放就别动；用户刚手动换过队列也保留（服务端下发的旧值不覆盖） */
    if (!media.paused && media.src) return false;
    if (queue.length && !o.force && !queueRestored) return false;
    const list = saved.tracks.map(function (id) { return FM.lib.track(id); }).filter(Boolean);
    if (!list.length) return false;
    const pos = Math.max(0, Math.min(list.length - 1, Number(saved.position) || 0));
    const same = queue.length === list.length && queue.every(function (t, i) { return t.id === list[i].id; });
    if (same && index === pos) return false;
    queue = list;
    index = pos;
    queueRestored = true;
    ev.emit('queue', queue, index);
    /* 底栏：还没有当前曲目时，用队列里那一集撑起来（不自动播放） */
    if (!cur) {
      cur = queue[index];
      setKind(cur.kind === 'video' ? 'video' : 'audio');
      ev.emit('track', cur, { restored: true });
      /* 没进度就什么都不发：发 0 会把别处刚画好的位置抹成 0:00 */
      const p = FM.lib.progressOf(cur.id);
      if (p && p.p > 0) ev.emit('time', p.p, cur.duration || p.d || 0);
      updateSession(cur);
    }
    return true;
  }

  /* 清空队列：正在放就先停，同时把数据库里那份也清掉（否则换设备又恢复旧队列）。
     「上次收听」一并清掉，不然下次启动 restoreLast 又会把整张专辑塞回来 */
  function clearQueue() {
    /* 无条件停：清空列表后底栏还留着上一集、点下一集又没反应，很容易以为坏了 */
    stop();
    queue = [];
    index = 0;
    queueRestored = false;
    ev.emit('queue', queue, 0);
    try {
      if (FM.fs && FM.fs.pushMeta) FM.fs.pushMeta({ queue: { tracks: [], position: 0 } });
      if (FM.fs && FM.fs.clearLastTrack) FM.fs.clearLastTrack();
    } catch (e) {}
  }

  /* 服务端 / 桌面下发的账号级偏好：只改运行时，不再回推（fs 已写本地 state） */
  function applyPrefs(prefs) {
    if (!prefs || typeof prefs !== 'object') return;
    if (prefs.rate != null) {
      rate = snapRate(prefs.rate);
      eachEl(function (el) {
        el.playbackRate = rate;
        el.preservesPitch = true;
        el.mozPreservesPitch = true;
        el.webkitPreservesPitch = true;
      });
      ev.emit('rate', rate);
    }
    if (prefs.loop != null && LOOP_LABEL[prefs.loop]) {
      loop = prefs.loop;
      ev.emit('loop', loop);
    }
    if (prefs.autoRewind != null) {
      autoRewind = Math.max(0, Math.round(Number(prefs.autoRewind) || 0));
      ev.emit('rewindset', autoRewind);
    }
  }

  function setQueue(list, i, opts) {
    queueRestored = false;      /* 用户主动排的队列：服务端下发不再覆盖 */
    queue = list.slice();
    index = i;
    const o = opts || {};
    if (o.silent) {
      cur = queue[index] || null;
      ev.emit('track', cur, { restored: true });
      updateSession(cur);
      ev.emit('time', 0, cur ? (cur.duration || 0) : 0);
      ev.emit('state', false);
    } else if (queue[index]) {
      load(queue[index], { autoplay: o.autoplay !== false });
    }
    ev.emit('queue', queue, index);
  }

  function playAlbum(albumId, trackId) {
    const list = FM.lib.albumTracks(albumId);
    if (!list.length) return;
    let i = 0;
    if (trackId) i = Math.max(0, list.findIndex(t => t.id === trackId));
    setQueue(list, i, { autoplay: true });
  }

  function addToQueue(list) {
    if (!list || !list.length) return;
    if (!queue.length) { setQueue(list, 0, { autoplay: true }); return; }
    queueRestored = false;
    const have = new Set(queue.map(t => t.id));
    list.forEach(function (t) { if (!have.has(t.id)) { queue.push(t); have.add(t.id); } });
    ev.emit('queue', queue, index);
  }

  function playTrack(track) {
    if (!track) return;
    if (cur && track.id === cur.id && media.src) { play(); return; }
    queueRestored = false;
    const inQueue = queue.some(t => t.id === track.id);
    if (inQueue) {
      index = queue.findIndex(t => t.id === track.id);
      load(queue[index], { autoplay: true });
      ev.emit('queue', queue, index);
    } else {
      const list = FM.lib.albumTracks(track.albumId);
      const i = Math.max(0, list.findIndex(t => t.id === track.id));
      setQueue(list.length ? list : [track], i, { autoplay: true });
    }
  }

  /* 「已听完」是既成事实，粘性：重播一集时进度回到开头，不能因此把它擦掉
     （否则听完后重听，列表里的「已听」标记和专辑已听集数都会掉）。
     只有右键「标记为未听」才清（lib.setProgress(..., false)）。 */
  function progressDone(id, p, d) {
    if (d > 0 && p / d > 0.965) return true;
    const prev = FM.lib.progressOf(id);
    return !!(prev && prev.done);
  }

  /* 落盘：播放中每 4 秒一次，切集 / 暂停 / 拖动 / 进后台 / 退出时立即写。
     push=false 只写本地、远程仍走 10 秒节流（拖动用）。 */
  function saveProgress(force, push) {
    if (!cur || !media.src || mediaTrackId !== cur.id) return;
    const now = Date.now();
    if (!force && now - saveAt < 4000) return;
    const d = isFinite(media.duration) ? media.duration : (cur.duration || 0);
    const p = media.currentTime || 0;
    const done = progressDone(cur.id, p, d);
    /* 同一位置不重复写：next() 先落一次，load() 换集前还会再落一次 */
    const sig = cur.id + '|' + Math.round(p * 10) + '|' + Math.round(d) + '|' + (done ? 1 : 0);
    if (sig === savedSig) return;
    savedSig = sig;
    saveAt = now;
    FM.lib.setProgress(cur.id, p, d, done);
    const pushNow = push == null ? !!force : push;
    if (FM.fs.canSyncMeta() && (pushNow || now - remoteSaveAt > 10000)) {
      remoteSaveAt = now;
      FM.fs.pushProgress({ id: cur.id, p: p, d: d, t: now, done: done });
    }
  }

  /* 自动回退：暂停超过 10 秒再继续时，退回设置的秒数，接上被打断的那句话 */
  function maybeAutoRewind() {
    if (!autoRewind || !pausedAt || !cur || pausedTrackId !== cur.id) return;
    const gap = Date.now() - pausedAt;
    pausedAt = 0; pausedTrackId = null;
    if (gap < AUTO_REWIND_AFTER) return;
    const t = media.currentTime || 0;
    const to = Math.max(0, t - autoRewind);
    if (t - to < 0.5) return;
    media.currentTime = to;
    ev.emit('time', to, media.duration || 0);
    ev.emit('rewind', t - to);
    saveProgress(true, false);
  }

  function setAutoRewind(sec) {
    autoRewind = Math.max(0, Math.round(Number(sec) || 0));
    persistState({ autoRewind });
    pushPrefs({ autoRewind });
    ev.emit('rewindset', autoRewind);
    return autoRewind;
  }

  function pickNext(auto) {
    if (!queue.length) return -1;
    if (loop === 'shuffle') {
      if (queue.length === 1) return 0;
      let n = index;
      while (n === index) n = Math.floor(Math.random() * queue.length);
      return n;
    }
    if (index + 1 < queue.length) return index + 1;
    if (auto && (loop === 'all')) return 0;
    return -1;
  }

  function next(auto) {
    queueRestored = false;
    saveProgress(true);
    if (loop === 'one' && auto) {
      media.currentTime = 0; play(); return;
    }
    const n = pickNext(auto !== false);
    if (n < 0) {
      ev.emit('end', cur);
      return;
    }
    index = n;
    ev.emit('queue', queue, index);
    load(queue[index], { autoplay: true, seek: 0 });
  }

  function prev() {
    if (!queue.length) return;
    if (media.currentTime > 5 && media.src) { seek(0); return; }
    queueRestored = false;
    saveProgress(true);
    let n = index - 1;
    if (n < 0) n = loop === 'all' ? queue.length - 1 : 0;
    index = n;
    ev.emit('queue', queue, index);
    load(queue[index], { autoplay: true, seek: 0 });
  }

  /* ── 倍速 ── */
  function setRate(r) {
    rate = Math.round(U.clamp(r, 0.5, 3) * 100) / 100;
    eachEl(function (el) {
      el.playbackRate = rate;
      el.preservesPitch = true;
      el.mozPreservesPitch = true;
      el.webkitPreservesPitch = true;
    });
    persistState({ rate });
    pushPrefs({ rate });
    ev.emit('rate', rate);
  }

  function cycleRate(dir) {
    const i = RATES.indexOf(rate);
    /* 档位表缩过之后，老状态里可能存着 1.75x 这种不存在的档：从最接近的一档起步 */
    const near = RATES.findIndex(r => r >= rate);
    const base = i >= 0 ? i : (near < 0 ? RATES.length - 1 : near);
    const n = U.clamp(base + (dir || 1), 0, RATES.length - 1);
    setRate(RATES[n]);
    return rate;
  }

  /* ── 音量 ── */
  function setVolume(v) {
    volume = U.clamp(v, 0, 1);
    muted = volume === 0;
    eachEl(function (el) { el.volume = volume; el.muted = false; });
    persistState({ volume });
    ev.emit('volume', volume, muted);
  }

  function toggleMute() {
    const next = !(media.muted || media.volume === 0);
    eachEl(function (el) {
      el.muted = next;
      if (!next && el.volume === 0) el.volume = volume || 1;
    });
    muted = next;
    ev.emit('volume', media.muted ? 0 : media.volume, muted);
  }

  /* ── 画中画 ── */
  async function togglePip() {
    if (!media.videoWidth) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await media.requestPictureInPicture();
    } catch (e) {
      ev.emit('error', new Error('画中画不可用：' + (e.message || '当前环境不支持')));
    }
  }

  /* ── 循环 ── */
  function cycleLoop() {
    loop = LOOPS[(LOOPS.indexOf(loop) + 1) % LOOPS.length];
    persistState({ loop });
    pushPrefs({ loop });
    ev.emit('loop', loop);
    return loop;
  }

  /* ── 定时关闭 ── */
  function stopSleepClock() {
    if (sleepTimer) { clearInterval(sleepTimer); sleepTimer = null; }
  }

  /* 淡出只动元素音量，不改用户的音量设置；恢复时按 volume 填回去 */
  function applyFade(ratio) {
    const r = Math.max(0, Math.min(1, ratio));
    fadeOn = r < 1;
    eachEl(function (el) { el.volume = volume * r; });
  }

  function restoreVolume() {
    if (!fadeOn) return;
    fadeOn = false;
    eachEl(function (el) { el.volume = volume; });
  }

  function sleepTick() {
    if (sleepMode !== 'time') return;
    sleepLeft = Math.max(0, sleepEnd - Date.now());
    applyFade(FM.sleep.fadeRatio(sleepLeft, SLEEP_FADE));
    if (sleepLeft <= 0) {
      stopSleepClock();
      restoreVolume();
      sleepMode = 0; sleepEnd = 0; sleepLeft = 0;
      pause();
      ev.emit('sleep', 0, 0);
      ev.emit('sleepend');
      return;
    }
    ev.emit('sleep', sleepLeft, 'time');
  }

  function setSleep(minutes) {
    stopSleepClock();
    restoreVolume();
    const m = Number(minutes) || 0;
    if (!m) {
      sleepMode = 0; sleepEnd = 0; sleepTotal = 0; sleepLeft = 0;
      ev.emit('sleep', 0, 0);
      return 0;
    }
    sleepMode = 'time';
    sleepTotal = m * 60000;
    sleepLeft = sleepTotal;
    sleepEnd = Date.now() + sleepTotal;
    sleepTimer = setInterval(sleepTick, 500);
    ev.emit('sleep', sleepLeft, sleepMode);
    return m;
  }

  /* 本集播完暂停：不设时间，靠 ended 兜住 */
  function setSleepChapter() {
    stopSleepClock();
    restoreVolume();
    sleepMode = 'chapter';
    sleepEnd = 0; sleepTotal = 0; sleepLeft = 0;
    ev.emit('sleep', 0, sleepMode);
    return 'chapter';
  }

  function pauseSleepClock() {
    if (sleepMode === 'time' && sleepTimer) {
      sleepLeft = Math.max(0, sleepEnd - Date.now());
      stopSleepClock();
    }
  }

  function resumeSleepClock() {
    if (sleepMode === 'time' && !sleepTimer && sleepLeft > 0) {
      sleepEnd = Date.now() + sleepLeft;
      sleepTimer = setInterval(sleepTick, 500);
    }
  }

  function endSleep() {
    stopSleepClock();
    restoreVolume();
    sleepMode = 0; sleepEnd = 0; sleepTotal = 0; sleepLeft = 0;
    ev.emit('sleep', 0, 0);
    ev.emit('sleepend');
  }

  /* 每晚在设定时间段内开始播放时，自动挂上定时 */
  function maybeAutoSleep() {
    const cfg = sleepAuto;
    if (!cfg || !cfg.on || sleepMode) return;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (!FM.sleep.inRange(nowMin, FM.sleep.parseHM(cfg.from), FM.sleep.parseHM(cfg.to))) return;
    setSleep(cfg.minutes || 30);
    ev.emit('sleepauto', true);
  }

  function setAutoSleep(on, from, to, minutes) {
    sleepAuto = {
      on: !!on,
      from: from || sleepAuto.from || '22:00',
      to: to || sleepAuto.to || '07:00',
      minutes: minutes || sleepAuto.minutes || 30
    };
    persistState({ sleepAuto: sleepAuto });
    ev.emit('sleepauto', sleepAuto.on);
    if (sleepAuto.on && !media.paused) maybeAutoSleep();
    return sleepAuto;
  }

  /* ── 媒体事件：audio 与 video 各绑一套，只认当前在用的那个 ── */
  let tick = 0;
  ELS.forEach(function (el) {
    el.addEventListener('timeupdate', function () {
      if (el !== media) return;
      const d = isFinite(el.duration) ? el.duration : (cur ? cur.duration : 0);
      ev.emit('time', el.currentTime, d);
      /* 本集播完暂停：最后 10 秒跟着进度淡出 */
      if (sleepMode === 'chapter' && d > 0) {
        applyFade(FM.sleep.fadeRatio((d - el.currentTime) * 1000, SLEEP_FADE));
      }
      if (!el.paused) saveProgress(false);
    });
    el.addEventListener('play', function () {
      if (el !== media) return;
      restoreVolume();
      resumeSleepClock();
      maybeAutoSleep();
      maybeAutoRewind();
      ev.emit('state', true);
    });
    el.addEventListener('pause', function () {
      if (el !== media) return;
      restoreVolume();
      pauseSleepClock();
      ev.emit('state', false);
      pausedAt = Date.now(); pausedTrackId = cur ? cur.id : null;
      saveProgress(true);
    });
    el.addEventListener('ended', function () {
      if (el !== media) return;
      saveProgress(true);
      if (cur) FM.lib.setProgress(cur.id, el.duration || cur.duration || 0, el.duration || cur.duration || 0, true);
      if (sleepMode === 'chapter') { endSleep(); return; }
      next(true);
    });
    el.addEventListener('error', function () {
      if (el !== media || !el.src) return;
      ev.emit('error', new Error('音频无法播放'));
    });
    el.addEventListener('ratechange', function () {
      if (el.playbackRate !== rate) el.playbackRate = rate;
    });
  });
  window.addEventListener('pagehide', function () { saveProgress(true); });
  window.addEventListener('beforeunload', function () { saveProgress(true); });
  /* 安卓壳切后台 / 锁屏时 pagehide 不一定触发，visibilitychange 更可靠 */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveProgress(true);
  });

  /* 上次收听的那一集：优先按资源库取（lastTracks[libId]）。
     只存一份全局 lastTrackId 时，在 A 库听完切到 B 库再切回来，记的已经是 B 库那一集，
     A 库的底栏就恢复不出来了。全局那份留着兜底（老数据、按库记录失效时用）。

     这里只认「本用户自己」的记录：本机没有时由服务端按用户下发（fs.applyMeta 落到
     state.lastTracks）。不要退回去看 progress —— 进度是库属性（多用户共享），
     拿它当上次收听会让新登录的用户一进来就看到别人听过的节目。 */
  function lastTrackOf(libId) {
    const s = FM.db.state();
    const byLib = libId && s.lastTracks ? s.lastTracks[libId] : '';
    let t = byLib ? FM.lib.track(byLib) : null;
    if (!t && s.lastTrackId) t = FM.lib.track(s.lastTrackId);
    return t || null;
  }

  function restoreLast() {
    const t = lastTrackOf(FM.lib.libId);
    if (!t) return false;
    setKind(t.kind === 'video' ? 'video' : 'audio');
    /* 已经有队列（持久化恢复出来的，可能是多张专辑拼的）且包含这一集：
       就沿用队列，别用「整张专辑」把它覆盖掉 */
    const list = (queue.length && queue.some(function (x) { return x.id === t.id; }))
      ? queue
      : FM.lib.albumTracks(t.albumId);
    const i = Math.max(0, list.findIndex(x => x.id === t.id));
    queueRestored = true;
    queue = list;
    index = i;
    cur = t;
    ev.emit('track', t, { restored: true });
    /* 底栏直接显示上次听到的位置（不自动播放，也不会自动 seek；
       用户点播放时 load() 自己会从 progress 接上）。
       拿不到进度就不发 time：发 0 会把底栏里已经画好的位置抹回 0:00，
       而进度的真正到货时间是异步的（服务端快照 / 原生回传），由 store / applyMeta
       回头喊 refreshBarTime 补画 */
    const p = FM.lib.progressOf(t.id);
    if (p && p.p > 0) ev.emit('time', p.p, t.duration || p.d || 0);
    updateSession(t);
    return true;
  }

  function rememberTrack(track) {
    if (!track) return;
    const patch = { lastTrackId: track.id, lastAlbumId: track.albumId };
    /* 按库记一份：切库会清空播放器（stop），切回来时靠它把底栏放回来 */
    const libId = FM.lib.libId;
    if (libId) {
      const map = Object.assign({}, FM.db.state().lastTracks);
      map[libId] = track.id;
      patch.lastTracks = map;
    }
    persistState(patch);
    /* 也记到服务端（按用户，不跟库共享）：换设备 / 重装后还能恢复上次收听，
       而新用户那边是空的，不会凭空出现底栏 */
    try { if (FM.fs && FM.fs.pushMeta) FM.fs.pushMeta({ lastTrack: track.id }); } catch (e) {}
  }
  ev.on('track', rememberTrack);
  /* 队列一变就攒着存（1 秒防抖）：切集 / 加队列 / 换专辑都会触发 */
  ev.on('queue', saveQueueSoon);
  ev.on('loop', () => {});
  setRate(rate);
  setVolume(volume);
  bindSession();
  /* 转码进度：主进程转 wma/flv 时推给页面（同一时间只有一个任务在转） */
  if (typeof window !== 'undefined' && window.fmNative && window.fmNative.onTc) {
    window.fmNative.onTc(function (info) { ev.emit('tcProgress', info); });
  }

  /* 原生视频播放器回传的事件（track/time/state/ended/closed） */
  function onNative(type, data) {
    data = data || {};
    if (type === 'track') {
      /* 原生在放 = 网页这边就该是「视频交给原生」。回前台自检可能把 nativeVideo 清过，
         播放页被重新拉起后靠这条恢复，否则网页以为自己在放，底栏状态全是错的 */
      nativeVideo = true;
      /* 原生列表索引可能和网页队列不同：按 id 对齐 */
      if (data.id) {
        const qi = queue.findIndex(function (t) { return t.id === data.id; });
        if (qi >= 0 && qi !== index) {
          index = qi; cur = queue[qi];
          ev.emit('track', cur, { restored: true });
          ev.emit('queue', queue, index);
        }
      }
    } else if (type === 'time') {
      nativePlaying = !!data.playing;
      const p = Number(data.cur) || 0;
      const d = Number(data.dur) || 0;
      if (data.id && d > 0) {
        const done = progressDone(data.id, p, d);
        FM.lib.setProgress(data.id, p, d, done);
        if (FM.fs.canSyncMeta()) {
          const now = Date.now();
          if (now - nativeRemoteAt > 10000) {
            nativeRemoteAt = now;
            FM.fs.pushProgress({ id: data.id, p: p, d: d, t: now, done: done });
          }
        }
      }
      ev.emit('time', p, d);
    } else if (type === 'state') {
      nativePlaying = !!data.playing;
      ev.emit('state', nativePlaying);
    } else if (type === 'ended') {
      ev.emit('end', cur);
    } else if (type === 'closed') {
      /* 关闭时把最终进度落盘（后台期间 JS 可能没执行，兜底） */
      const p = Number(data.cur) || 0;
      const d = Number(data.dur) || 0;
      if (data.id && d > 0) {
        const done = progressDone(data.id, p, d);
        FM.lib.setProgress(data.id, p, d, done);
        if (FM.fs.canSyncMeta()) FM.fs.pushProgress({ id: data.id, p: p, d: d, t: Date.now(), done: done });
      }
      nativeVideo = false;
      nativePlaying = false;
      if (data.id) {
        const qi = queue.findIndex(function (t) { return t.id === data.id; });
        if (qi >= 0) index = qi;
      }
      ev.emit('state', false);
    }
  }

  FM.player = {
    on: ev.on,
    play, pause, toggle, openNative, stop, seek, seekRatio, jumpBy,
    next, prev, setQueue, playAlbum, playTrack, addToQueue,
    setRate, cycleRate, setVolume, toggleMute, cycleLoop, setSleep, setSleepChapter, setAutoSleep, togglePip,
    setAutoRewind,
    setAudioOnly,
    restoreLast, saveProgress, onNative,
    restoreQueue, applyPrefs, clearQueue, saveQueueSoon,
    artworkFor,
    get current() { return cur; },
    get queue() { return queue; },
    get index() { return index; },
    get kind() { return kind; },
    get playing() { return nativeVideo ? nativePlaying : (!media.paused && !!media.src); },
    /* 这一集是否已经真的挂在播放器里：刚启动 / 刚换库 / 换集过渡期为 false，
       界面据此决定「显示媒体实时位置」还是「上次听到的位置」 */
    get loaded() { return !!(media.src && cur && mediaTrackId === cur.id); },
    get nativeVideo() { return nativeVideo; },
    get rate() { return rate; },
    get volume() { return media.muted ? 0 : media.volume; },
    get muted() { return media.muted; },
    get loop() { return loop; },
    get loopLabel() { return LOOP_LABEL[loop]; },
    get loopIcon() { return LOOP_ICON[loop]; },
    get sleepEnd() { return sleepEnd; },
    get sleepMode() { return sleepMode; },
    get sleepLeft() { return sleepLeft; },
    get autoSleep() { return sleepAuto; },
    get autoRewind() { return autoRewind; },
    get media() { return media; },
    RATES, LOOP_LABEL, LOOP_ICON
  };
})(window.FM);
