/* ── player.js · 播放内核 ─────────────────────────────── */
(function (FM) {
  'use strict';
  const U = FM.util;
  const RATES = [0.75, 1, 1.25, 1.5, 2, 3];

  /* 把倍速吸附到档位表里最接近的一档：旧版本存过 1.75× / 2.5× 这类已删掉的档 */
  function snapRate(r) {
    if (RATES.indexOf(r) >= 0) return r;
    return RATES.reduce(function (best, x) {
      return Math.abs(x - r) < Math.abs(best - r) ? x : best;
    }, RATES[0]);
  }
  const LOOPS = ['all', 'one', 'shuffle', 'off'];
  const LOOP_LABEL = { all: '列表循环', one: '单集循环', shuffle: '随机播放', off: '顺序播放' };
  const LOOP_ICON = { all: 'repeat', one: 'repeat1', shuffle: 'shuffle', off: 'repeat' };

  const media = document.getElementById('media');
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
  let sleepTimer = null;
  let sleepEnd = 0;
  let artCache = new Map();

  const st = FM.db.state();
  let rate = snapRate(st.rate || 1);
  let volume = st.volume == null ? 1 : st.volume;
  let loop = st.loop || 'all';
  let muted = false;

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
    cur = track;
    setKind(track.kind === 'video' ? 'video' : 'audio');
    ev.emit('track', track, { restored: false });
    updateSession(track);
    try {
      const s = await FM.fs.src(track.rel);
      if (my !== loadToken) { if (s.revoke) s.revoke(); return; }
      if (objectRevoke) { objectRevoke(); objectRevoke = null; }
      objectUrl = s.url;
      objectRevoke = s.revoke;
      media.src = objectUrl;
      media.playbackRate = rate;
      media.load();
      await once(media, 'loadedmetadata');
      if (my !== loadToken) return;
      /* 扩展名说是视频、实际只有音轨（或者反过来）时以真实轨道为准 */
      setKind(media.videoWidth > 0 ? 'video' : 'audio');
      const dur = isFinite(media.duration) ? media.duration : (track.duration || 0);
      if (dur > 0) FM.lib.setDuration(track.id, dur);
      const p = FM.lib.progressOf(track.id);
      let start = o.seek;
      if (start == null && p && p.p > 3 && (!p.d || p.p < p.d - 8)) start = p.p;
      if (start && start > 0) {
        media.currentTime = dur ? Math.min(start, Math.max(0, dur - 1)) : start;
      }
      ev.emit('time', media.currentTime, dur);
      if (o.autoplay) await play();
      else ev.emit('state', false);
    } catch (e) {
      if (my !== loadToken) return;
      ev.emit('error', e);
    }
  }

  /* ── 停止并清空（切换资源库时用） ── */
  function stop() {
    if (cur) saveProgress(true);
    try { media.pause(); } catch (e) {}
    if (objectRevoke) { objectRevoke(); objectRevoke = null; }
    objectUrl = null;
    media.removeAttribute('src');
    try { media.load(); } catch (e) {}
    queue = [];
    index = -1;
    cur = null;
    ev.emit('stop');
    ev.emit('queue', queue, index);
  }

  /* ── 播放控制 ── */
  async function play() {
    if (!cur) return;
    if (!media.src) { await load(cur, { autoplay: true }); return; }
    try {
      await media.play();
    } catch (e) {
      if (e && e.name !== 'AbortError') ev.emit('error', e);
    }
  }

  function pause() { if (media.src) media.pause(); }

  function toggle() {
    if (!cur) return;
    if (media.paused) play(); else pause();
  }

  function seek(t) {
    if (!media.src || !isFinite(media.duration)) return;
    media.currentTime = U.clamp(t, 0, media.duration || 0);
    ev.emit('time', media.currentTime, media.duration);
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

  function saveProgress(force) {
    if (!cur || !media.src) return;
    const now = Date.now();
    if (!force && now - saveAt < 4000) return;
    saveAt = now;
    const d = isFinite(media.duration) ? media.duration : (cur.duration || 0);
    const p = media.currentTime || 0;
    const done = d > 0 && p / d > 0.965;
    FM.lib.setProgress(cur.id, p, d, done);
    /* 远程访问时把进度回传给服务端，10 秒一次；暂停/切集/关页面时 force 立即推 */
    if (FM.fs.server && (force || now - remoteSaveAt > 10000)) {
      remoteSaveAt = now;
      FM.fs.pushProgress({ id: cur.id, p: p, d: d, t: now, done: done });
    }
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
    media.playbackRate = rate;
    media.preservesPitch = true;
    media.mozPreservesPitch = true;
    media.webkitPreservesPitch = true;
    persistState({ rate });
    ev.emit('rate', rate);
  }

  function cycleRate(dir) {
    const i = RATES.indexOf(rate);
    /* 档位表缩过之后，老状态里可能存着 1.75× 这种不存在的档：从最接近的一档起步 */
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
    media.volume = volume;
    media.muted = false;
    persistState({ volume });
    ev.emit('volume', volume, muted);
  }

  function toggleMute() {
    if (media.muted || media.volume === 0) {
      media.muted = false;
      if (media.volume === 0) media.volume = volume || 1;
    } else {
      media.muted = true;
    }
    muted = media.muted;
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
  function setSleep(minutes) {
    if (sleepTimer) { clearInterval(sleepTimer); sleepTimer = null; }
    if (!minutes) { sleepEnd = 0; ev.emit('sleep', 0); return; }
    sleepEnd = Date.now() + minutes * 60000;
    sleepTimer = setInterval(function () {
      if (Date.now() >= sleepEnd) {
        clearInterval(sleepTimer); sleepTimer = null; sleepEnd = 0;
        pause(); ev.emit('sleep', 0); ev.emit('sleepend');
      } else {
        ev.emit('sleep', sleepEnd - Date.now());
      }
    }, 1000);
    ev.emit('sleep', sleepEnd - Date.now());
  }

  /* ── 音频事件 ── */
  let tick = 0;
  media.addEventListener('timeupdate', function () {
    ev.emit('time', media.currentTime, isFinite(media.duration) ? media.duration : (cur ? cur.duration : 0));
    if (!media.paused) saveProgress(false);
  });
  media.addEventListener('play', function () { ev.emit('state', true); });
  media.addEventListener('pause', function () { ev.emit('state', false); saveProgress(true); });
  media.addEventListener('ended', function () {
    saveProgress(true);
    if (cur) FM.lib.setProgress(cur.id, media.duration || cur.duration || 0, media.duration || cur.duration || 0, true);
    next(true);
  });
  media.addEventListener('error', function () {
    if (!media.src) return;
    ev.emit('error', new Error('音频无法播放'));
  });
  media.addEventListener('ratechange', function () { if (media.playbackRate !== rate) media.playbackRate = rate; });
  window.addEventListener('pagehide', function () { saveProgress(true); });
  window.addEventListener('beforeunload', function () { saveProgress(true); });

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

  FM.player = {
    on: ev.on,
    play, pause, toggle, stop, seek, seekRatio, jumpBy,
    next, prev, setQueue, playAlbum, playTrack, addToQueue,
    setRate, cycleRate, setVolume, toggleMute, cycleLoop, setSleep, togglePip,
    restoreLast, saveProgress,
    artworkFor,
    get current() { return cur; },
    get queue() { return queue; },
    get index() { return index; },
    get kind() { return kind; },
    get playing() { return !media.paused && !!media.src; },
    get rate() { return rate; },
    get volume() { return media.muted ? 0 : media.volume; },
    get muted() { return media.muted; },
    get loop() { return loop; },
    get loopLabel() { return LOOP_LABEL[loop]; },
    get loopIcon() { return LOOP_ICON[loop]; },
    get sleepEnd() { return sleepEnd; },
    get media() { return media; },
    RATES, LOOP_LABEL, LOOP_ICON
  };
})(window.FM);
