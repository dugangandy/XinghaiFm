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
  let pausedAt = 0;       // 上次暂停的时刻，用来判断恢复时要不要回退
  let pausedTrackId = null;
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

  const st = FM.db.state();
  let rate = snapRate(st.rate || 1);
  let volume = st.volume == null ? 1 : st.volume;
  let loop = st.loop || 'all';
  let muted = false;
  /* 暂停多久之后恢复才回退：10 秒内基本是误触或短暂中断，退回去反而烦 */
  const AUTO_REWIND_AFTER = 10000;
  let autoRewind = st.autoRewind == null ? 10 : (Number(st.autoRewind) || 0);
  let sleepAuto = st.sleepAuto || { on: false, from: '22:00', to: '07:00', minutes: 30 };

  function persistState(patch) {
    const s = FM.db.state();
    Object.assign(s, patch);
    FM.db.setState(s);
    FM.store.touch('state');
  }

  function setKind(next) {
    if (next === kind) return;
    kind = next;
    ev.emit('kind', kind);
  }

  function once(el, name) {
    return new Promise(function (res, rej) {
      const on = () => { el.removeEventListener(name, on); res(); };
      el.addEventListener(name, on);
      setTimeout(() => { el.removeEventListener(name, on); res(); }, 8000);
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
    const el = track.kind === 'video' ? videoEl : audioEl;
    if (media !== el) { stopEl(media); media = el; }
    setKind(track.kind === 'video' ? 'video' : 'audio');
    ev.emit('track', track, { restored: false });
    updateSession(track);
    try {
      const s = await FM.fs.src(track.rel);
      if (my !== loadToken) { if (s.revoke) s.revoke(); return; }
      if (objectRevoke) { objectRevoke(); objectRevoke = null; }
      objectUrl = s.url;
      objectRevoke = s.revoke;
      /* 远程库的媒体是跨源的：不声明 CORS，WebAudio 的 MediaElementSource 会把采样全输出 0（进度条走、没声音） */
      el.crossOrigin = FM.fs.remote ? 'anonymous' : null;
      el.src = objectUrl;
      el.playbackRate = rate;
      el.volume = volume;
      el.muted = muted;
      el.load();
      await once(el, 'loadedmetadata');
      if (my !== loadToken) return;
      /* 扩展名说是视频、实际只有音轨（或者反过来）时以真实轨道为准 */
      setKind(el.videoWidth > 0 ? 'video' : 'audio');
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

  /* ── 停止并清空（切换资源库时用） ── */
  function stop() {
    if (cur) saveProgress(true);
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
  async function play() {
    if (!cur) return;
    if (nativeVideo) return;
    if (!media.src) { await load(cur, { autoplay: true }); return; }
    try {
      await media.play();
    } catch (e) {
      if (e && e.name !== 'AbortError') ev.emit('error', e);
    }
  }

  function pause() { if (nativeVideo) return; if (media.src) media.pause(); }

  function toggle() {
    if (!cur) return;
    if (nativeVideo) return;
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

  function setQueue(list, i, opts) {
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
    const have = new Set(queue.map(t => t.id));
    list.forEach(function (t) { if (!have.has(t.id)) { queue.push(t); have.add(t.id); } });
    ev.emit('queue', queue, index);
  }

  function playTrack(track) {
    if (!track) return;
    if (cur && track.id === cur.id && media.src) { play(); return; }
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

  /* 落盘：播放中每 4 秒一次，切集 / 暂停 / 拖动 / 进后台 / 退出时立即写。
     push=false 只写本地、远程仍走 10 秒节流（拖动用）。 */
  function saveProgress(force, push) {
    if (!cur || !media.src || mediaTrackId !== cur.id) return;
    const now = Date.now();
    if (!force && now - saveAt < 4000) return;
    const d = isFinite(media.duration) ? media.duration : (cur.duration || 0);
    const p = media.currentTime || 0;
    const done = d > 0 && p / d > 0.965;
    /* 同一位置不重复写：next() 先落一次，load() 换集前还会再落一次 */
    const sig = cur.id + '|' + Math.round(p * 10) + '|' + Math.round(d) + '|' + (done ? 1 : 0);
    if (sig === savedSig) return;
    savedSig = sig;
    saveAt = now;
    FM.lib.setProgress(cur.id, p, d, done);
    const pushNow = push == null ? !!force : push;
    if (FM.fs.server && (pushNow || now - remoteSaveAt > 10000)) {
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

  function restoreLast() {
    const s = FM.db.state();
    if (!s.lastTrackId) return false;
    const t = FM.lib.track(s.lastTrackId);
    if (!t) return false;
    setKind(t.kind === 'video' ? 'video' : 'audio');
    const list = FM.lib.albumTracks(t.albumId);
    const i = Math.max(0, list.findIndex(x => x.id === t.id));
    queue = list;
    index = i;
    cur = t;
    ev.emit('track', t, { restored: true });
    ev.emit('time', 0, t.duration || 0);
    updateSession(t);
    return true;
  }

  function rememberTrack(track) {
    if (!track) return;
    persistState({ lastTrackId: track.id, lastAlbumId: track.albumId });
  }
  ev.on('track', rememberTrack);
  ev.on('loop', () => {});
  setRate(rate);
  setVolume(volume);
  bindSession();

  /* 原生视频播放器回传的事件（track/time/state/ended/closed） */
  function onNative(type, data) {
    data = data || {};
    if (type === 'track') {
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
        const done = p / d > 0.965;
        FM.lib.setProgress(data.id, p, d, done);
        if (FM.fs.server) {
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
        const done = p / d > 0.965;
        FM.lib.setProgress(data.id, p, d, done);
        if (FM.fs.server) FM.fs.pushProgress({ id: data.id, p: p, d: d, t: Date.now(), done: done });
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
    play, pause, toggle, stop, seek, seekRatio, jumpBy,
    next, prev, setQueue, playAlbum, playTrack, addToQueue,
    setRate, cycleRate, setVolume, toggleMute, cycleLoop, setSleep, setSleepChapter, setAutoSleep, togglePip,
    setAutoRewind,
    restoreLast, saveProgress, onNative,
    artworkFor,
    get current() { return cur; },
    get queue() { return queue; },
    get index() { return index; },
    get kind() { return kind; },
    get playing() { return nativeVideo ? nativePlaying : (!media.paused && !!media.src); },
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
