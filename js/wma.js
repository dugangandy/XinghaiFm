/* ── 客户端转码：WMA → MP3（MSE 边转边播）───────────────────────
 *
 * 为什么要有这个：Chromium 内置 FFmpeg 只启用白名单编解码器，没有 wma，
 * <audio src="x.wma"> 必然 MEDIA_ERR_SRC_NOT_SUPPORTED。服务器转码能解决，
 * 但那是额外的 CPU 和磁盘开销（用户明确不要）。这里有第三条路——
 * 在浏览器里用 WASM 解码、再编码成 mp3：
 *
 *   · 服务端零 CPU、零磁盘：只按 Range 发原始字节
 *   · mp3 走 MediaSource 边转边喂：第一个块到手就能出声（约一秒），
 *     不用像 ogg 那样整段转完（10 分钟音频要等 20~40 秒）才开播
 *   · 转完把整段 mp3 写进 IndexedDB，之后点播直接走 blob 秒开
 *
 * 老版本存的是整段 ogg（MSE 不认 vorbis，只能整段等），缓存库升到 v2 洗掉了。
 */
(function () {
  'use strict';
  const FM = window.FM;

  /* 只处理 wma：ape/wv 的解码器还没接（同一个作者的 @audio/decode-ape） */
  const SUPPORT = { wma: 1 };

  const DB_NAME = 'fm-wma-cache';
  const DB_VER = 2;                  // v1 存 ogg，v2 换 mp3
  const STORE = 'mp3';
  const LIMIT = 300 * 1024 * 1024;   // 缓存上限，超了按最久未用淘汰
  const TARGET_RATE = 22050;         // 语音够用，PCM 减半、编码也快一倍
  const BITRATE = 0;                 // 0 = 交给 worker 按声道定（单声道 48 / 立体声 80）
  const QUALITY = 3;                 // 降级走整段 ogg 时的 Vorbis 质量
  const FIRST_TIMEOUT = 20000;       // 首块最多等 20 秒（实测 0.6 秒），超了就当走不通
  const START_TIMEOUT = 15000;       // 从「点播放」到「首块到手」的总兜底（含读缓存 / 取直链）
  const CACHE_READ_TIMEOUT = 3000;   // 读缓存最多等 3 秒，卡住就当没缓存
  const IDLE_TIMEOUT = 60000;        // 整段转码期间 60 秒没有任何进展就放弃
  const DROP_LIMIT = 3;              // 连续几块喂不进 SourceBuffer 就认输

  const MIME = 'audio/mpeg';

  /* 桌面 Chromium / Electron / 安卓 WebView 的 MSE 都认 audio/mpeg。
     万一不认（老 Safari 之类），退回「整段转完再播」，只是首次要等。 */
  const STREAM_OK = (function () {
    try { return !!(window.MediaSource && window.MediaSource.isTypeSupported(MIME)); }
    catch (e) { return false; }
  })();

  const urls = new Map();            // key -> objectURL（缓存命中 / 转完的整段 blob）
  const jobs = new Map();            // key -> {promise, tail, cancelled, worker, stream}
  const streams = new Map();         // key -> 流式 MediaSource 状态（元素还挂着它）
  let dbReady = null;
  let usage = 0;

  function supports(ext) {
    return !!SUPPORT[String(ext || '').toLowerCase()];
  }

  function idbKey(rel, version) {
    /* 缓存 key 必须带库标识和文件版本：同一路径被替换后不能继续播放旧 MP3。 */
    const lib = (FM.fs && FM.fs.activeId) || '';
    return lib + '|' + rel + '|' + String(version || '');
  }

  /* mse: true 表示这是 MediaSource 的地址 —— 同一个地址不能被元素二次 load
     （Chrome 会直接判 MEDIA_ERR_SRC_NOT_SUPPORTED），播放器要据此避开 el.load() */
  function result(url, cached, mse) {
    return { url, revoke: null, transcoded: true, client: true, cached: !!cached, mse: !!mse };
  }

  function abortErr() {
    const e = new Error('aborted');
    e.code = 'aborted';
    return e;
  }

  /* ── IndexedDB ── */
  function openDb() {
    if (dbReady) return dbReady;
    dbReady = new Promise(function (resolve, reject) {
      let retried = false;
      function attempt() {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = function () {
          const db = req.result;
          /* v1 存的是整段 ogg：现在不这么播了，留着白占配额 */
          if (db.objectStoreNames.contains('ogg')) {
            try { db.deleteObjectStore('ogg'); } catch (e) {}
          }
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
        };
        req.onsuccess = function () { resolve(req.result); };
        /* 别的标签页还开着旧版本，升级会被挂住：直接失败，让缓存这一层先停摆，
           播放本身还能走转码（下次调用会重试） */
        req.onblocked = function () { reject(new Error('缓存库被其它窗口占用')); };
        req.onerror = function () {
          const err = req.error;
          /* 库版本比代码新（回滚到旧版、或别的窗口升级过）：这个版本号永远打不开，
             留着就是整条缓存链失效。缓存本来就可丢，删库重建 */
          if (!retried && err && err.name === 'VersionError') {
            retried = true;
            try {
              const del = indexedDB.deleteDatabase(DB_NAME);
              del.onsuccess = del.onerror = del.onblocked = attempt;
            } catch (e) { reject(err); }
            return;
          }
          reject(err);
        };
      }
      attempt();
    }).catch(function (e) {
      dbReady = null;   // 下次调用重试（旧窗口关掉 / 删库成功后就能开）
      throw e;
    });
    return dbReady;
  }

  function cacheGet(key) {
    const read = openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { reject(r.error); };
      });
    }).catch(function () { return null; });
    /* 缓存只是加速手段：IndexedDB 万一挂住（被别的窗口占着、配额异常、隐私模式），
       绝不能把整条播放链一起拖死 —— 超时就当没缓存，直接转码 */
    return Promise.race([
      read,
      new Promise(function (res) { setTimeout(function () { res(null); }, CACHE_READ_TIMEOUT); })
    ]);
  }

  function cachePut(rec) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).put(rec);
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { reject(t.error); };
      });
    }).catch(function () {});
  }

  function cacheTouch(key) {
    cacheGet(key).then(function (rec) {
      if (!rec) return;
      rec.at = Date.now();
      cachePut(rec);
    });
  }

  /* 超出上限就按最久未用删，同时把内存里的 objectURL 释放掉 */
  function trim() {
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        const items = [];
        let total = 0;
        const t = db.transaction(STORE, 'readonly');
        t.objectStore(STORE).openCursor().onsuccess = function (e) {
          const c = e.target.result;
          if (!c) return;
          items.push({ key: c.value.key, size: c.value.size || 0, at: c.value.at || 0 });
          total += c.value.size || 0;
          c.continue();
        };
        t.oncomplete = function () {
          usage = total;
          let over = total - LIMIT;
          if (over <= 0) return resolve(total);
          const drop = items.sort(function (a, b) { return a.at - b.at; }).filter(function (it) {
            if (over <= 0) return false;
            over -= it.size;
            return true;
          });
          const t2 = db.transaction(STORE, 'readwrite');
          const os = t2.objectStore(STORE);
          let freed = 0;
          drop.forEach(function (it) {
            os.delete(it.key);
            freed += it.size;
            if (urls.has(it.key)) {
              try { URL.revokeObjectURL(urls.get(it.key)); } catch (e) {}
              urls.delete(it.key);
            }
          });
          /* 删过头（一块比超出量大）是正常的，别把用量算成负数 */
          t2.oncomplete = function () { usage = Math.max(0, total - freed); resolve(usage); };
          t2.onerror = function () { resolve(total); };
        };
        t.onerror = function () { resolve(0); };
      });
    }).catch(function () {});
  }

  /* ── 流式：worker 边编码边发块，主线程喂给 MediaSource ──
   *
   * 两条硬约束（都是 Chromium 的脾气，不是我们的选择）：
   *   1. SourceBuffer 有配额（实测音频约 7MB，48kbps 只够 20 分钟）。转码速度是
   *      实时的上百倍，来一块喂一块几秒钟就把整段灌进去，之后 appendBuffer 直接抛
   *      "SourceBuffer is full"，此后再也塞不进去，长一点的课永远播不完。
   *      → 只按「领先播放头 AHEAD_MAX 秒」喂，多出来的块先攒在 parts 里。
   *   2. mp3 帧不带时间戳，Chromium 的 mp3 解析器只认「从 0 往后接」：收到第一帧
   *      之后再改 timestampOffset 不生效，所以 remove 掉的区间没法重新喂回来，
   *      不能像视频那样靠回收 + 重喂做无限拖拽。
   *      → 转码一完成就把元素换成整段 mp3 blob（见 swapToBlob），那才是真正的
   *        文件，随便拖，也不再占 MSE 配额。
   */
  const AHEAD_MAX = 90;               // 最多领先播放头缓冲多少秒
  const BYTE_CAP = 5 * 1024 * 1024;   // 兜底：灌进 SourceBuffer 的字节上限
  const TICK = 1000;                  // 被限流时多久再看一眼

  function newStream(key) {
    const ms = new MediaSource();
    const st = {
      key: key, ms: ms, url: URL.createObjectURL(ms),
      sb: null, parts: [], qPos: 0, bytes: 0, blob: null, duration: 0, t0: Date.now(),
      el: null, timer: 0, swapped: false,
      ended: false, dead: false, started: false, done: false, appended: 0, drops: 0,
      worker: null, tail: null, fail: null
    };
    ms.addEventListener('sourceopen', function () { attach(st); });
    return st;
  }

  /* 播过一集的 MediaSource 会一直攥着它缓冲过的那几 MB。超过 6 条就把最老的
     从表里摘掉（元素还挂着时摘掉不影响播放，换源后自然回收），parts 也一起放掉 */
  function trimStreams() {
    const keys = Array.from(streams.keys());
    for (let i = 0; i < keys.length && streams.size > 6; i++) {
      const old = streams.get(keys[i]);
      if (!old || !old.done) continue;
      streams.delete(keys[i]);
      old.parts = [];
    }
  }

  /* 谁在播这个流：MediaSource 本身不知道播放头在哪，得由上层把元素交过来 */
  function attachEl(st, el) {
    if (st.el === el) return;
    st.el = el;
    ['seeking', 'timeupdate', 'waiting', 'play', 'playing'].forEach(function (n) {
      el.addEventListener(n, function () { pump(st); });
    });
    pump(st);
  }

  function bind(el, url) {
    if (!el) return;
    const u = url || el.currentSrc || el.src;
    let hit = null;
    streams.forEach(function (s) {
      if (hit) return;
      if (s.url === u || s.url === el.currentSrc || s.url === el.src) hit = s;
    });
    if (hit) attachEl(hit, el);
  }

  function attach(st) {
    /* 元素真的把这个 MediaSource 挂上来了才走到这里；这之前收到的块都在 parts 里攒着。
       元素被重新 load 过（断流重挂 / 恢复播放）会再触发一次，那时旧的 SourceBuffer
       已经没了，得重新建一个、把已经转出来的块再喂一遍。 */
    if (st.dead) return;
    if (!st.sb || st.ms.sourceBuffers.length === 0) {
      let sb;
      try { sb = st.ms.addSourceBuffer(MIME); }
      catch (e) {
        /* isTypeSupported 过了还失败，基本就是环境问题：必须让上层知道，
           否则 ensure 永远不 settle，转码遮罩会一直盖在界面上下不来 */
        st.dead = true;
        if (st.fail) st.fail(new Error('MSE 建不了 SourceBuffer：' + ((e && e.message) || e)));
        return;
      }
      st.sb = sb;
      st.appended = 0;
      st.drops = 0;
      st.bytes = 0;
      st.qPos = 0;
      try { sb.timestampOffset = 0; } catch (e) {}
      sb.addEventListener('updateend', function () { pump(st); });
      sb.addEventListener('error', function () {
        /* SourceBuffer 自己坏了（配额 / 解码）：再塞也是白塞，连 worker 一起收 */
        killStream(st, 'SourceBuffer 出错，停止喂数据');
      });
      /* parts 里是全部已转出的块：晚挂上（转码早就跑完了）或元素被重新 load
         过（断流重挂）都靠它从头重放一遍，别指望 SourceBuffer 还记得。
         parts 已经放掉的情况（短文件全喂完了）从整段 blob 重新切 */
      if (!st.parts.length) replayFromBlob(st);
    }
    setDuration(st);
    pump(st);
  }

  /* parts 已经回收之后元素又被重新 load：整段 blob 还在内存里
     （和 urls 里那个 objectURL 指向同一个对象，不额外占），切回块再喂一遍 */
  function replayFromBlob(st) {
    const b = st.blob;
    if (!b) return;
    b.arrayBuffer().then(function (ab) {
      if (st.dead || st.parts.length) return;
      const CH = 64 * 1024;
      st.parts = [];
      st.bytes = 0;
      for (let off = 0; off < ab.byteLength; off += CH) {
        st.parts.push(new Uint8Array(ab, off, Math.min(CH, ab.byteLength - off)));
      }
      st.qPos = 0;
      try { st.sb.timestampOffset = 0; } catch (e) {}
      pump(st);
    }).catch(function () {});
  }

  function setDuration(st) {
    if (!st.duration || st.ms.readyState !== 'open') return;
    try { st.ms.duration = st.duration; } catch (e) {}
  }

  /* 播放头：优先用 bind 交过来的元素；没绑上就按 src 在文档里找一次，
     这样别处直接把 url 塞给 <audio> 也能走窗口化（否则永远停在 AHEAD_MAX） */
  function playhead(st) {
    if (!st.el) {
      const els = document.querySelectorAll('audio,video');
      for (let i = 0; i < els.length; i++) {
        if (els[i].currentSrc === st.url || els[i].src === st.url) { attachEl(st, els[i]); break; }
      }
    }
    const t = st.el ? Number(st.el.currentTime) : 0;
    return isFinite(t) && t > 0 ? t : 0;
  }

  function retry(st, ms) {
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(function () { st.timer = 0; pump(st); }, ms || TICK);
  }

  /* 播放管线彻底废了：worker 必须一起停 —— 留着它会把整段转完（CPU 占满一个核）
     而界面永远拿不到结果，同一集再点一次还会挂在 tail 上等不到头 */
  function killStream(st, msg) {
    if (msg) console.warn('[wma] ' + msg);
    st.dead = true;
    if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
    st.parts = [];
    if (st.worker) { try { st.worker.terminate(); } catch (e) {} st.worker = null; }
    if (st.tail) st.tail();
  }

  function appendNext(st) {
    const sb = st.sb;
    const buf = st.parts[st.qPos];
    st.qPos++;                          // 失败也跳过：坏块留着只会一直卡在同一块
    try {
      /* 转码来的块是 ArrayBuffer，从 blob 重放的是 Uint8Array 视图：
         视图直接交给 appendBuffer，省一次整块拷贝 */
      sb.appendBuffer(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
      st.appended++;
      st.bytes += buf.byteLength || 0;
      st.drops = 0;
    } catch (e) {
      st.drops++;
      if (st.drops === 1) console.warn('[wma] appendBuffer 失败：' + ((e && e.message) || e));
      if (st.drops >= DROP_LIMIT) {
        killStream(st, '连续 ' + st.drops + ' 块喂不进 SourceBuffer，停止播放');
        return;
      }
      setTimeout(function () { pump(st); }, 0);   // 别递归：块多的时候会爆栈
    }
  }

  /* 转码完成：把元素从 MediaSource 换到整段 mp3 blob 上。
     为什么要换：mp3 帧不带时间戳，Chromium 的 mp3 解析器只认「从 0 往后接」，
     收到第一帧之后再改 timestampOffset 不生效 —— 所以既不能 remove 之后跳到
     中间重喂，也不能回收旧数据（回收了就再也回不去）。SourceBuffer 配额又只有
     几 MB（48kbps 约 20 分钟），长文件必然塞满。整段 blob 是真正的文件，
     随便拖，也不再占 MSE 配额。 */
  function swapToBlob(st, url) {
    const el = st.el;
    if (!el || !url || st.swapped) return false;
    if (el.src !== st.url && el.currentSrc !== st.url) return false;
    st.swapped = true;
    const at = Number(el.currentTime) || 0;
    const playing = !el.paused && !el.ended;
    /* 换源会把位置归零：等元数据到了再摆回原位，播放状态也接回去。
       万一 loadedmetadata 没来（源有问题），3 秒后照样摆一次，别把播放卡在 0 秒 */
    let fired = false, guard = 0;
    const restore = function () {
      if (fired) return;
      fired = true;
      clearTimeout(guard);
      el.removeEventListener('loadedmetadata', restore);
      try { if (at > 0) el.currentTime = Math.min(at, (el.duration || at) - 0.2); } catch (e) {}
      if (playing) { try { const p = el.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
    };
    guard = setTimeout(restore, 3000);
    el.addEventListener('loadedmetadata', restore);
    el.src = url;
    try { el.load(); } catch (e) {}
    console.info('[wma] 转码完成，切到整段播放（MSE 装不下长文件）');
    return true;
  }

  function pump(st) {
    const sb = st.sb;
    if (!sb || st.dead || st.swapped) return;
    if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
    if (sb.updating) return;

    const t = playhead(st);
    const buf = sb.buffered;
    const n = buf.length;
    const end = n ? buf.end(n - 1) : 0;

    if (st.qPos < st.parts.length) {
      /* 一次喂一块：appendBuffer 是异步的，得等 updateend 再喂下一块。
         只按「领先播放头多少秒」限流，绝不 remove 旧数据 —— 删了之后就回不去了 */
      if (n && end - t > AHEAD_MAX) { retry(st); return; }
      /* 兜底：真到了配额边上就停手，等转完换成整段 blob（用户往前跳得太远时
         可能会碰到，那时两边都在等，done 一到 swapToBlob 就接上了） */
      if (st.bytes > BYTE_CAP) return;
      appendNext(st);
      return;
    }

    /* 一块都没进去就 endOfStream，元素会报 MEDIA_ERR_SRC_NOT_SUPPORTED */
    if (!st.ended || !st.appended || st.ms.readyState !== 'open') return;
    /* 转完且全都喂进 SourceBuffer 了：parts 只是白占一份内存（短文件走这里）。
       元素重新 load 时由 replayFromBlob 从整段 blob 重放 */
    if (st.done && st.parts.length) st.parts = [];
    try {
      /* 时长拿不到时（ASF 头里没有）用实际缓冲到的末尾兜底，否则进度条是 Infinity */
      if (!(st.ms.duration > 0) && n) st.ms.duration = end;
      st.ms.endOfStream();
    } catch (e) {}
  }

  function dropStream(st) {
    st.dead = true;
    if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
    st.parts = [];
    st.blob = null;
    if (st.worker) { try { st.worker.terminate(); } catch (e) {} st.worker = null; }
    if (streams.get(st.key) === st) streams.delete(st.key);
    /* 取消 = 用户已经切走，这个地址不会再被用到，连同 MediaSource 一起放掉 */
    try { URL.revokeObjectURL(st.url); } catch (e) {}
  }

  function transcodeStream(rel, key, job, source) {
    return Promise.resolve(source || FM.fs.src(rel, { raw: true })).then(function (s) {
      if (job.cancelled) throw abortErr();
      if (!s || !s.url) throw new Error('拿不到媒体地址');
      const srcUrl = s.url;
      const st = newStream(key);
      streams.set(key, st);
      trimStreams();
      job.stream = st;

      let resolveFirst, rejectFirst;
      const first = new Promise(function (res, rej) { resolveFirst = res; rejectFirst = rej; });
      /* 首块到手只是「能播了」，转码本身还在后台跑：tail 决定 jobs 什么时候释放 */
      job.tail = new Promise(function (res) { st.tail = res; });
      let settled = false;
      let timer = 0;

      function ok(r) { clearTimeout(timer); resolveFirst(r); }
      function no(e) { clearTimeout(timer); rejectFirst(e); }

      const w = new Worker('js/wma/transcode.worker.js');
      st.worker = w;
      job.worker = w;

      function stopWorker() {
        try { w.terminate(); } catch (e) {}
        if (job.worker === w) job.worker = null;
        st.worker = null;
      }

      /* 首块之前就失败：对着界面还盖着转码遮罩（pointer-events:auto，会拦住所有点击），
         绝不能让它永远挂着 —— 一律拒绝，让上层退回整段转码 */
      st.fail = function (err) {
        if (settled) {
          /* 已经出声了：url 早在元素手上了，换不回来，只能停掉 worker 提示一句 */
          killStream(st, '流式播放中断：' + ((err && err.message) || err));
          return;
        }
        settled = true;
        stopWorker();
        dropStream(st);
        no(err || new Error('转码失败'));
        if (st.tail) st.tail();
      };

      /* 解码器 wasm 加载、首次 Range 请求都可能挂住（远程 / 网盘半死连接）。
         实测首块 0.6 秒，20 秒还没动静就当这条路走不通 */
      timer = setTimeout(function () { st.fail(new Error('转码超时')); }, FIRST_TIMEOUT);

      job.abort = function () {
        clearTimeout(timer);
        stopWorker();
        dropStream(st);
        if (!settled) { settled = true; no(abortErr()); }
        if (st.tail) st.tail();
      };

      w.onmessage = function (e) {
        const d = e.data || {};
        if (st.dead) return;

        if (d.type === 'meta') {
          st.duration = Number(d.duration) || 0;
          setDuration(st);
          if (st.t0) console.info('[wma] 头部就绪 ' + (Date.now() - st.t0) + 'ms，时长 ' +
            Math.round(st.duration) + 's，' + d.sampleRate + 'Hz/' + d.channels + 'ch');
          /* 头部解析完就推一个最小进度：遮挡层从「正在转换，请稍候…」变成带数字的
             百分比，用户能看出它确实动了（大文件首块要读几百 KB） */
          if (!st.started && job.cb && !job.cancelled) job.cb(0.02, 'probe');
          return;
        }

        if (d.type === 'chunk') {
          if (!d.bytes) return;
          st.parts.push(d.bytes);        // 留着转完拼成整段写缓存
          pump(st);
          if (!st.started) {
            st.started = true;
            if (st.t0) console.info('[wma] 首块 ' + (Date.now() - st.t0) + 'ms（可以起播了）');
            ok(result(st.url, false, true));   // 有第一个块了，界面可以撤等待层
          }
          return;
        }

        if (d.type === 'progress') {
          /* 首块之前才报百分比：之后玩家已经在出声，进度层也收了 */
          if (!st.started && job.cb && !job.cancelled) {
            job.cb(d.total ? Math.min(0.95, d.done / d.total) : 0, 'encode');
          }
          return;
        }

        if (d.type === 'error') {
          stopWorker();
          if (!settled) {
            /* 一个块都没出来：这个 url 永远播不出来，让上层退回整段转码 */
            st.fail(new Error(d.message || '转码失败'));
          } else {
            /* 已经在出声了：把剩下的块排完就收尾，别让元素永远卡在缓冲 */
            clearTimeout(timer);
            console.warn('[wma] 流式转码中断：' + (d.message || ''));
            st.ended = true;
            pump(st);
            if (st.tail) st.tail();
          }
          return;
        }

        if (d.type === 'done') {
          stopWorker();
          settled = true;
          st.ended = true;
          st.done = true;
          const blob = new Blob(st.parts, { type: MIME });
          let url = '';
          if (blob.size) {
            /* blob 留着给「元素被重新 load」时整段重放用：它和 urls 里那个
               objectURL 指向同一个对象，不额外占内存 */
            st.blob = blob;
            url = URL.createObjectURL(blob);
            urls.set(key, url);
            cachePut({ key: key, blob: blob, size: blob.size, at: Date.now() }).then(trim);
            if (st.t0) {
              const m = d.ms || {};
              console.info('[wma] 转码完成 ' + (Date.now() - st.t0) + 'ms，' +
                Math.round(blob.size / 1024) + 'KB mp3' +
                (m.dec ? '（读数据 ' + m.net + 'ms / 解码 ' + m.dec + 'ms / 编码 ' + m.enc + 'ms）' : ''));
            }
          }
          /* 整段装得进 SourceBuffer 就别换源（换源要重新 load，会停顿一下）：
             短文件继续走 MSE，全部喂完照样随便拖。
             装不下才切到整段 blob；切不了（元素还没挂上来 / 已经不在这条流上）
             就继续喂 MSE */
          const swapped = blob.size > BYTE_CAP && swapToBlob(st, url);
          if (!swapped) pump(st);
          if (swapped || st.qPos >= st.parts.length) st.parts = [];
          st.started = true;
          ok(result(st.url, false, true));
          if (st.tail) st.tail();
          return;
        }
      };

      w.onerror = function (e) {
        if (st.dead) return;
        st.fail(new Error((e && e.message) || '转码线程出错'));
      };

      w.postMessage({
        type: 'start', mode: 'stream', url: srcUrl, size: Number(s.size) || 0,
        targetRate: TARGET_RATE, bitrate: BITRATE
      });

      return first;
    });
  }

  /* ── 整段转（MSE 不可用 / 流式失败的降级路）：wma → ogg ── */
  function transcodeBlob(rel, key, job, source) {
    return Promise.resolve(source || FM.fs.src(rel, { raw: true })).then(function (s) {
      if (job.cancelled) throw abortErr();
      if (!s || !s.url) throw new Error('拿不到媒体地址');
      const srcUrl = s.url;
      /* 从流式降级过来时 job.tail 已经被 resolve 过了：这条路的 promise 本身就是
         完成信号，清掉它，否则 ensure 里的 release 会以为「转完了」提前把 job 删掉，
         整段转码还在跑的时候同一集会再开一份 */
      job.tail = null;
      return new Promise(function (resolve, reject) {
        const w = new Worker('js/wma/transcode.worker.js');
        job.worker = w;
        let settled = false;
        let idle = 0;

        function finish() {
          clearTimeout(idle);
          try { w.terminate(); } catch (e) {}
          job.worker = null;
        }

        /* 整段转码期间 worker 会不停发 progress：一条消息都没有就说明拉数据
           或编码彻底卡死了，别让遮罩一直转圈（流式那边已经拒了，这里再挂住
           等于前功尽弃） */
        function kick() {
          clearTimeout(idle);
          if (settled) return;
          idle = setTimeout(function () {
            if (settled) return;
            settled = true;
            finish();
            reject(new Error('转码超时'));
          }, IDLE_TIMEOUT);
        }
        kick();

        job.abort = function () {
          if (settled) return;
          settled = true;
          finish();
          reject(abortErr());
        };

        w.onmessage = function (e) {
          const d = e.data || {};
          if (settled) return;
          kick();
          if (d.type === 'progress') {
            if (job.cancelled) return;
            const p = d.stage === 'read'
              ? (d.total ? d.done / d.total * 0.15 : 0)
              : 0.15 + (d.total ? d.done / d.total * 0.85 : 0);
            if (job.cb) job.cb(Math.min(0.999, p), d.stage);
            return;
          }
          if (d.type === 'error') {
            settled = true;
            finish();
            reject(new Error(d.message || '转码失败'));
            return;
          }
          if (d.type === 'done') {
            settled = true;
            const blob = new Blob([d.bytes], { type: 'audio/ogg' });
            const u = URL.createObjectURL(blob);
            urls.set(key, u);
            cachePut({ key: key, blob: blob, size: blob.size, at: Date.now() }).then(trim);
            if (job.cb) job.cb(1, 'done');
            finish();
            resolve(result(u, false));
          }
        };
        w.onerror = function (e) {
          if (settled) return;
          settled = true;
          finish();
          reject(new Error((e && e.message) || '转码线程出错'));
        };
        w.postMessage({
          type: 'start', mode: 'blob', url: srcUrl, size: Number(s.size) || 0,
          targetRate: TARGET_RATE, quality: QUALITY
        });
      });
    });
  }

  function transcode(rel, key, job, source) {
    if (!STREAM_OK) return transcodeBlob(rel, key, job, source);
    return transcodeStream(rel, key, job, source).catch(function (e) {
      if (job.cancelled || (e && e.code === 'aborted')) throw e;
      console.warn('[wma] 边转边播没起来，退回整段转码：' + ((e && e.message) || e));
      return transcodeBlob(rel, key, job, source);
    });
  }

  function run(rel, key, job, source) {
    return cacheGet(key).then(function (rec) {
      if (job.cancelled) throw abortErr();
      if (rec && rec.blob) {
        const u = URL.createObjectURL(rec.blob);
        urls.set(key, u);
        cacheTouch(key);
        if (job.cb) job.cb(1, 'cached');
        return result(u, true);
      }
      return transcode(rel, key, job, source);
    });
  }

  /**
   * 拿到一个能直接喂给 <audio> 的地址。命中缓存立刻返回；否则流式转码
   * 首个块到手就返回（转码在后台继续，转完自动落缓存）。
   * @param {string} rel 曲目相对路径
   * @param {{signal?:AbortSignal, onProgress?:function(number,string)}} [opts]
   */
  function ensure(rel, opts) {
    opts = opts || {};
    const key = idbKey(rel, opts.version);
    if (urls.has(key)) return Promise.resolve(result(urls.get(key), true));

    /* 同一集可能被请求两次（重挂数据源、恢复进度）：复用同一条转码链，别开两份 worker */
    const prev = jobs.get(key);
    if (prev) {
      /* 这个 MediaSource 地址已经发出去过一次了：再发一遍，元素重新 load 它
         会被 Chrome 判 MEDIA_ERR_SRC_NOT_SUPPORTED。等这条链收尾，直接给整段 blob */
      if (prev.stream && prev.stream.started) {
        return (prev.tail || Promise.resolve()).then(function () {
          if (urls.has(key)) return result(urls.get(key), true);
          throw new Error('转码结束了但没有产物');
        });
      }
      return prev.promise;
    }

    const job = { cancelled: false, cb: opts.onProgress, worker: null, stream: null, tail: null };
    jobs.set(key, job);

    function release() {
      if (jobs.get(key) === job) jobs.delete(key);
      if (job.sourceRevoke) {
        const revoke = job.sourceRevoke;
        job.sourceRevoke = null;
        revoke();
      }
    }

    job.sourceRevoke = opts.source && opts.source.revoke;
    const inner = run(rel, key, job, opts.source).then(function (r) {
      /* 流式时这里只是「首块到了」，worker 还在转：等 tail 收尾再释放，
         否则同一集马上再请求一次会重复开一份转码 */
      if (job.tail) job.tail.then(release, release);
      else release();
      return r;
    }, function (e) {
      release();
      throw e;
    });

    /* 总兜底：读缓存、取直链、起 worker 任何一步卡住（IndexedDB 被占、自定义协议
       不响应、远程地址半死），界面上都是一层收不掉的转码遮罩（pointer-events:auto）。
       实测首块 0.6 秒，15 秒还没动静就放弃并报错，让用户看到到底哪一步不通 */
    job.promise = new Promise(function (resolve, reject) {
      let done = false;
      const guard = setTimeout(function () {
        if (done) return;
        done = true;
        job.cancelled = true;
        if (job.abort) job.abort();
        else if (job.worker) { try { job.worker.terminate(); } catch (e) {} job.worker = null; }
        release();
        reject(new Error('转码启动超时'));
      }, START_TIMEOUT);
      inner.then(function (r) {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolve(r);
      }, function (e) {
        if (done) return;
        done = true;
        clearTimeout(guard);
        reject(e);
      });
    });
    job.promise.catch(function () {});   // 上层可能不看，别制造 unhandled rejection

    if (opts.signal) {
      const onAbort = function () {
        job.cancelled = true;
        /* 转码实现自己负责拒绝 promise（流式：杀掉 worker + 放掉 MediaSource；
           整段：杀掉 worker）。都还没起来（正在取直链 / 读缓存）就让它自己走到
           上面那两个 cancelled 检查里抛 aborted */
        if (job.abort) job.abort();
        else if (job.worker) { try { job.worker.terminate(); } catch (e) {} job.worker = null; }
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    return job.promise;
  }

  function stats() {
    return {
      cached: urls.size,
      running: jobs.size,
      streams: streams.size,
      usage: usage,
      limit: LIMIT
    };
  }

  function clear() {
    streams.forEach(function (st) { dropStream(st); });
    return openDb().then(function (db) {
      urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
      urls.clear();
      return new Promise(function (resolve) {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).clear();
        t.oncomplete = function () { usage = 0; resolve(); };
        t.onerror = function () { resolve(); };
      });
    }).catch(function () {});
  }

  /* bind：把 <audio>/<video> 交给转码流，好让喂数据跟着播放头走（见 pump）。
     播放器换源后调用；不调也能工作，只是靠定时器按 src 反查元素 */
  FM.wma = { supports, ensure, bind, stats, clear };
})(window.FM);
