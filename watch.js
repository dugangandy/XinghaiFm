/* ── watch.js · 资源库目录自动监听（主机侧，main.js / serve.js 共用） ──
 *
 * 只负责「什么时候该重扫」，具体怎么扫由调用方注入（scan(root) → 各自的 scanFolder）。
 * 目标：往资源库里丢新书后，主机自己发现并重扫，不用再手动点「重新扫描」。
 *
 * 几个约定：
 *   · 同一物理目录只挂一个 watcher：共享副本和源库路径相同，按规范化路径去重。
 *   · 忽略隐藏文件 / 点开头目录（.fm-covers、.fm-meta.json、._xxx 等）：
 *     这些是程序自己写的，监听到会把「保存封面」误当成「加书」而反复重扫。
 *   · 文件夹增删一律算变化；文件只认音频 / 视频扩展名，别因为来了个字幕、封面就重扫。
 *   · 事件去抖：一次拷贝几十集时会连发几百个事件，合并成一次重扫。
 *   · SMB / NFS 上 inotify 不触发：可设 FM_WATCH_POLLING=1 改用轮询（更费 CPU/IO）。
 *   · 监听失败（EMFILE / ENOSPC / 目录不在）只告警并跳过，不让主机进程崩。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

let chokidar = null;
try { chokidar = require('chokidar'); } catch (e) {
  console.warn('[watch] 未安装 chokidar，目录自动监听不可用（npm install chokidar）');
}
/* 后端是否真的能监听（没装 chokidar / 打包漏了依赖时为 false）。
   UI 和接口据此隐藏开关，避免「打开了但其实没在监听」的假成功。 */
const available = !!chokidar;

/* 与 main.js / serve.js / js/fs.js 的扫描口径保持一致 */
const MAX_DEPTH = 6;
const MEDIA = new Set([
  'm4a', 'm4b', 'mp3', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'ape', 'wv',
  'mp4', 'm4v', 'mov', 'webm', 'ogv', 'flv'
]);
const SKIP = /^[._]|^(fm|dist|build|node_modules|\$RECYCLE\.BIN|System Volume Information)$/i;

function isMedia(file) {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return false;
  return MEDIA.has(file.slice(dot + 1).toLowerCase());
}

/* 路径归一化：大小写 / 分隔符 / 尾斜杠不同也要认成同一个目录 */
function normKey(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  let out = s;
  try { out = path.resolve(s); } catch (e) {}
  out = out.replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32' || process.platform === 'darwin') out = out.toLowerCase();
  return out;
}

/* rel 里只要有一段是隐藏 / 跳过目录，就不算资源库内容 */
function ignoredPath(full, root) {
  let rel = '';
  try { rel = path.relative(root, full); } catch (e) { return false; }
  if (!rel || rel === '' || rel.startsWith('..')) return false;
  return rel.split(/[\\/]/).some(function (s) { return s && SKIP.test(s); });
}

/* opts.scan(root)：触发该库重扫，返回 Promise（由调用方注入 scanFolder(root, {refresh:true})）
   opts.debounceMs：事件去抖窗口，默认 2000ms
   opts.minScanIntervalMs：同一目录两次自动重扫的最小间隔，默认 30000ms（0 = 不限制）
   opts.usePolling：强制轮询；不传时读 FM_WATCH_POLLING=1 */
function createWatcher(opts) {
  const o = opts || {};
  const scan = typeof o.scan === 'function' ? o.scan : function () { return Promise.resolve(); };
  const debounceMs = Math.max(300, Number(o.debounceMs) || 2000);
  const minScanIntervalMs = o.minScanIntervalMs !== undefined
    ? Math.max(0, Number(o.minScanIntervalMs) || 0)
    : 30000;
  const usePolling = o.usePolling !== undefined ? !!o.usePolling : (process.env.FM_WATCH_POLLING === '1');
  const records = new Map();      // normKey -> { watcher, timer, lastScanAt }

  /* 到点后还要过「最短扫描间隔」这一关：拷贝几十集时事件会持续不断，
     不能让每个文件都触发一次全库扫描。间隔没到就顺延到窗口末尾再扫。 */
  function fire(key, root, rec) {
    rec.timer = 0;
    /* 定时器等待期间可能被 stop 掉：别让已经关掉的 watcher 再触发扫描 */
    if (records.get(key) !== rec) return;
    const wait = minScanIntervalMs - (Date.now() - (rec.lastScanAt || 0));
    if (wait > 0) {
      rec.timer = setTimeout(function () { fire(key, root, rec); }, wait);
      return;
    }
    rec.lastScanAt = Date.now();
    let p;
    try { p = scan(root); } catch (e) {
      console.warn('[watch] 重扫失败 ' + root + '：' + ((e && e.message) || e));
      return;
    }
    if (p && typeof p.catch === 'function') {
      p.catch(function (e) { console.warn('[watch] 重扫失败 ' + root + '：' + ((e && e.message) || e)); });
    }
  }

  function schedule(key, root, rec) {
    if (records.get(key) !== rec) return;
    clearTimeout(rec.timer);
    rec.timer = setTimeout(function () { fire(key, root, rec); }, debounceMs);
  }

  function start(root, key) {
    if (!chokidar) return;
    /* 目录不在（移动硬盘拔了、网络盘掉线）：先不挂监听，等下次 setRoots 再试 */
    try { if (!fs.statSync(root).isDirectory()) return; } catch (e) { return; }
    let watcher;
    try {
      watcher = chokidar.watch(root, {
        ignoreInitial: true,
        depth: MAX_DEPTH,
        persistent: true,
        /* 拷贝大文件还没写完就先别扫：等大小稳定 1.5 秒 */
        awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
        usePolling: usePolling,
        interval: usePolling ? 1500 : undefined,
        ignored: function (full) { return ignoredPath(full, root); }
      });
    } catch (e) {
      console.warn('[watch] 无法监听 ' + root + '：' + ((e && e.message) || e));
      return;
    }
    const rec = { watcher: watcher, timer: 0, lastScanAt: 0 };
    records.set(key, rec);

    watcher.on('all', function (event, full) {
      if (records.get(key) !== rec) return;
      if (event === 'add' || event === 'change' || event === 'unlink') {
        /* 只关心音视频文件：字幕 / 图片 / 说明文本变动不用整库重扫 */
        if (!isMedia(String(full || ''))) return;
      } else if (event !== 'addDir' && event !== 'unlinkDir') {
        return;
      }
      schedule(key, root, rec);
    });
    watcher.on('error', function (e) {
      console.warn('[watch] 监听异常 ' + root + '：' + ((e && e.message) || e));
    });
    console.log('[watch] 开始监听：' + root + (usePolling ? '（轮询模式）' : ''));
  }

  function stopKey(key) {
    const rec = records.get(key);
    if (!rec) return;
    records.delete(key);
    clearTimeout(rec.timer);
    try { rec.watcher.close(); } catch (e) {}
  }

  /* roots: [{ id, path, watch }]，只有 watch 为真的才监听 */
  function setRoots(list) {
    const want = new Map();
    (list || []).forEach(function (l) {
      if (!l || !l.watch || !l.path) return;
      const key = normKey(l.path);
      if (key && !want.has(key)) want.set(key, l.path);
    });
    /* 先停掉不该再监听的（关开关 / 删库 / 改了目录） */
    Array.from(records.keys()).forEach(function (key) {
      if (!want.has(key)) stopKey(key);
    });
    /* 再给新开启的挂上 */
    want.forEach(function (root, key) {
      if (!records.has(key)) start(root, key);
    });
  }

  function stopAll() {
    Array.from(records.keys()).forEach(stopKey);
  }

  return {
    setRoots: setRoots,
    stopAll: stopAll,
    isWatching: function (p) { return records.has(normKey(p)); },
    get size() { return records.size; },
    available: available
  };
}

module.exports = { createWatcher: createWatcher, available: available };
