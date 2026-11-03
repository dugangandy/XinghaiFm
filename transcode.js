/* ── transcode.js · 按需转码（桌面端主进程与服务端共用）───────────────
 *
 * Chromium 没有 WMA / Monkey's Audio / WavPack 解码器，FLV 容器也基本啃不动。
 * 这些文件先交给系统 ffmpeg 转成它能解的 mp3 / mp4 落到缓存目录，
 * 再由 main.js 的 fm://app/__tc/<key>.<ext> 或 tools/serve.js 的 /api/tc/<key>.<ext>
 * 走已有的 Range 直读通道播放。转码结果是有索引的真文件，拖动、倍速、
 * 续播点、时长探测都和普通文件完全一样，不需要额外的流式逻辑。
 *
 * ffmpeg 不在包里：按 FM_FFMPEG → 项目 bin/ → PATH（含 macOS 常见安装位置）
 * 依次查找，找不到就返回空字符串，由调用方给用户明确的提示。
 *
 * 缓存：<cacheDir>/<sha1(rel|size|mtime)>.<mp3|mp4>
 *   key 里带 rel + size + mtime，文件被替换或重扫后自动失效，不需要额外的
 *   失效逻辑；删库换库也不会误用旧缓存。体积由 sweep() 兜底。
 */
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

/* 需要转码的扩展名 → 目标容器 */
const NEEDS = { wma: 'mp3', ape: 'mp3', wv: 'mp3', flv: 'mp4' };
/* 缓存文件名：40 位 sha1 + 目标扩展名，两个入口都按这个正则白名单校验 */
const NAME_RE = /^[a-f0-9]{40}\.(mp3|mp4)$/;
const DEFAULT_MAX = 2 * 1024 * 1024 * 1024;   // 2GB，超了按 mtime 从旧到新清到 80%
const RUN_TIMEOUT = 30 * 60 * 1000;           // 单个任务最多跑 30 分钟（超长视频兜底）
const PROBE_TIMEOUT = 15000;

function normExt(ext) {
  return String(ext || '').toLowerCase().replace(/^\./, '');
}
function outExt(ext) { return NEEDS[normExt(ext)] || ''; }
function needs(ext) { return !!outExt(ext); }

/* ── ffmpeg 定位 ──
   结果缓存起来：每个文件都去遍历 PATH 太浪费，用户装/卸载 ffmpeg 后重启即可。 */
let ffmpegPath = null;

function candidates() {
  const list = [];
  const env = String(process.env.FM_FFMPEG || '').trim();
  if (env) list.push(env);
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  list.push(path.join(__dirname, 'bin', exe));
  /* macOS 从 Finder/Dock 启动时 PATH 往往只有 /usr/bin:/bin，brew 装的 ffmpeg 找不到 */
  if (process.platform !== 'win32') {
    ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg'].forEach(function (p) { list.push(p); });
  }
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  String(process.env.PATH || '').split(path.delimiter).forEach(function (dir) {
    if (!dir) return;
    exts.forEach(function (e) { list.push(path.join(dir, 'ffmpeg' + e)); });
  });
  return list;
}

function findFfmpeg(refresh) {
  if (ffmpegPath !== null && !refresh) return ffmpegPath;
  ffmpegPath = '';
  const list = candidates();
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c) continue;
    /* 绝对路径先看存在性，避免对着一堆不存在的路径反复起进程；
       纯命令名（FM_FFMPEG=ffmpeg）交给 spawnSync 走 PATH */
    if (c.indexOf(path.sep) >= 0 || (process.platform === 'win32' && c.indexOf('/') >= 0)) {
      try { if (!fs.statSync(c).isFile()) continue; } catch (e) { continue; }
    }
    const r = spawnSync(c, ['-version'], { stdio: 'ignore', timeout: 8000, windowsHide: true });
    if (r && r.status === 0) { ffmpegPath = c; break; }
  }
  return ffmpegPath;
}

function tcError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

/* ── 缓存 key ── */
function key(rel, stat) {
  const s = (stat && stat.size) || 0;
  const m = (stat && (stat.mtimeMs || stat.mtime)) || 0;
  return crypto.createHash('sha1').update(String(rel) + '|' + s + '|' + m).digest('hex');
}
function fileName(rel, stat, ext) {
  return key(rel, stat) + '.' + ext;
}

/* ── 时长探测：只读文件头，不转码 ── */
function parseDuration(text) {
  const m = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(String(text || ''));
  if (!m) return 0;
  const v = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
  return isFinite(v) && v > 0 ? v : 0;
}

/* 时长探测走缓存：同一集在「专辑页探一次 + 播放时 prepare 再探一次」很常见，
   而且 /api/duration 是 GET 接口，没有缓存就等于每人每次刷新都起一遍 ffmpeg。
   只缓存成功结果（>0），失败的下次还值得再试。 */
const durCache = new Map();   // file -> { v, t }
const DUR_TTL = 10 * 60 * 1000;

function probeDuration(file) {
  const bin = findFfmpeg();
  if (!bin) return Promise.resolve(0);
  const hit = durCache.get(file);
  if (hit && Date.now() - hit.t < DUR_TTL) return Promise.resolve(hit.v);
  return new Promise(function (res) {
    let err = '';
    let done = false;
    const finish = function (v) {
      if (done) return;
      done = true;
      res(v);
    };
    let p;
    try {
      p = spawn(bin, ['-nostdin', '-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (e) { return finish(0); }
    const timer = setTimeout(function () { try { p.kill('SIGKILL'); } catch (e) {} finish(0); }, PROBE_TIMEOUT);
    p.stderr.on('data', function (d) {
      /* 只留前 64KB：正常文件头信息在第一屏，长文件后面都是流信息 */
      if (err.length < 65536) err += d;
    });
    p.on('error', function () { clearTimeout(timer); finish(0); });
    /* ffmpeg 不带输出文件时一定以非 0 退出，这里不看退出码，只解析 stderr */
    p.on('close', function () {
      clearTimeout(timer);
      const v = parseDuration(err);
      if (v > 0) {
        if (durCache.size > 1000) durCache.clear();
        durCache.set(file, { v: v, t: Date.now() });
      }
      finish(v);
    });
  });
}

/* ── 转码参数 ──
   输出文件带 .part 后缀（写一半被打断也不至于被当成缓存），ffmpeg 认不出扩展名，
   所以容器一律用 -f 显式指定。 */
function baseArgs(file, out, fmt, extra) {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', file]
    .concat(extra)
    .concat(['-f', fmt, '-progress', 'pipe:1', '-nostats', out]);
}

/* ext 是目标容器（mp3 / mp4），不是源扩展名 */
function argsFor(ext, file, out, remux) {
  if (ext === 'mp3') {
    /* 有声书基本是单声道人声：q:a 4 约 165kbps VBR，听感已经过剩，再高只是白占盘 */
    return baseArgs(file, out, 'mp3', ['-vn', '-c:a', 'libmp3lame', '-q:a', '4']);
  }
  if (remux) {
    /* 绝大多数 flv 是 H.264 + AAC，重封装几乎不耗 CPU（100 倍以上实时）。
       -map 带 ? 允许缺轨：只有音频的 flv 也能转出可播的 mp4 */
    return baseArgs(file, out, 'mp4', ['-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart']);
  }
  /* copy 失败（VP6 / H.263 / 老 MP3 音轨等）：真重编码，慢但能出画面 */
  return baseArgs(file, out, 'mp4', [
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart'
  ]);
}

function run(bin, args, totalSec, onProgress, signal) {
  return new Promise(function (res, rej) {
    let stderr = '';
    let pct = 0;
    let killed = false;
    let aborted = false;
    let p;
    try {
      p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { return rej(tcError('ffmpeg-failed', e.message)); }

    const timer = setTimeout(function () {
      killed = true;
      try { p.kill('SIGKILL'); } catch (e) {}
    }, RUN_TIMEOUT);

    /* 调用方取消（用户切到别的集）就把进程杀掉：没人要的文件继续转会白烧 CPU 和磁盘，
       服务端还会一直占着那条 HTTP 连接。Windows 上 SIGKILL 等价 TerminateProcess。 */
    const onAbort = function () {
      aborted = true;
      try { p.kill('SIGKILL'); } catch (e) {}
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    p.stdout.on('data', function (d) {
      if (!onProgress || !(totalSec > 0)) return;
      /* -progress 输出 out_time_us=12345678（老版本是 out_time_ms，单位同样是微秒） */
      const m = /out_time_(?:us|ms)=(\d+)/.exec(String(d));
      if (!m) return;
      const next = Math.min(99, Math.max(1, Math.round(parseInt(m[1], 10) / 1e6 / totalSec * 100)));
      if (next > pct) { pct = next; try { onProgress(next); } catch (e) {} }
    });
    p.stderr.on('data', function (d) {
      if (stderr.length < 65536) stderr += d;
    });
    p.on('error', function (e) {
      clearTimeout(timer);
      rej(tcError('ffmpeg-failed', e.message));
    });
    p.on('close', function (code) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) return res();
      if (aborted) return rej(tcError('aborted', '已取消'));
      if (killed) {
        /* 超时单独标出来：调用方不该拿「超时」去触发重编码，那会再等一个 30 分钟 */
        const e = tcError('ffmpeg-failed', '转换超时');
        e.timeout = true;
        return rej(e);
      }
      const tail = stderr.trim().slice(-400);
      console.warn('[tc] ffmpeg 退出码 ' + code + '：' + tail.replace(/\s+/g, ' '));
      rej(tcError('ffmpeg-failed', tail || ('ffmpeg 退出码 ' + code)));
    });
  });
}

/* ── 排他执行：同一时刻只转一个文件，避免多集连播时把 CPU 打满 ── */
let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(fn, fn);
  chain = p.then(function () {}, function () {});
  return p;
}

/* 同一文件的转码任务只有一个，但可能有多个调用方在等：展开/收起播放页会把同一次
   载入请求两遍。所以取消要按等待者计数——只有全都不等了才真的停掉任务。 */
const inflight = new Map();   // key -> { task, ctrl, waiters, settled }

function tcWait(entry, signal) {
  entry.waiters++;
  return new Promise(function (resolve, reject) {
    let done = false;
    const detach = function () { if (signal) signal.removeEventListener('abort', onAbort); };
    const leave = function (cancel) {
      if (done) return false;
      done = true;
      detach();
      entry.waiters--;
      if (cancel && entry.waiters <= 0 && !entry.settled) {
        try { entry.ctrl.abort(); } catch (e) {}
        /* 取消后不能再让后来的调用 join 到这个任务上（它会立刻以 aborted 收场），
           清掉登记，下一次请求重新开始转 */
        if (entry.key && inflight.get(entry.key) === entry) inflight.delete(entry.key);
      }
      return true;
    };
    const onAbort = function () {
      if (!leave(true)) return;
      reject(tcError('aborted', '已取消'));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    entry.task.then(function (v) { if (leave(false)) resolve(v); },
      function (e) { if (leave(false)) reject(e); });
  });
}

/**
 * 确保某个文件有可播放的缓存。
 * @param {{file:string, rel:string, stat:{size:number,mtimeMs:number}, cacheDir:string,
 *          onProgress?:(pct:number)=>void, signal?:AbortSignal}} opts
 * @returns {Promise<{file:string, ext:'mp3'|'mp4', cached:boolean}>}
 */
function prepare(opts) {
  const o = opts || {};
  const ext = outExt(path.extname(o.file || o.rel).slice(1));
  if (!ext) return Promise.reject(tcError('bad-format', '该格式不需要转码'));
  if (!o.cacheDir) return Promise.reject(tcError('ffmpeg-failed', '缺少缓存目录'));

  const k = key(o.rel, o.stat);
  const target = path.join(o.cacheDir, k + '.' + ext);
  const hit = inflight.get(k);
  if (hit) return tcWait(hit, o.signal);

  const ready = function () {
    return fsp.stat(target).then(function (st) {
      return st.isFile() && st.size > 0 ? { file: target, ext: ext, cached: true } : null;
    }, function () { return null; });
  };

  return ready().then(function (ok) {
    if (ok) return ok;
    /* 缓存命中不需要 ffmpeg：以前装过、后来卸掉的人也还能接着听 */
    const bin = findFfmpeg();
    if (!bin) throw tcError('no-ffmpeg', '未找到 ffmpeg');

    const ctrl = new AbortController();
    const entry = { key: k, ctrl: ctrl, waiters: 0, settled: false };
    entry.task = enqueue(function () {
      /* 排队期间可能已被前一个任务转好，也可能已经没人要了（用户早就切走了） */
      if (ctrl.signal.aborted) throw tcError('aborted', '已取消');
      return ready().then(function (again) {
        if (again) return again;
        const part = target + '.part';
        const t0 = Date.now();
        return fsp.mkdir(o.cacheDir, { recursive: true })
          /* 要报百分比就得先知道总时长：ffmpeg -i 只读头，几毫秒，不亏 */
          .then(function () {
            if (ctrl.signal.aborted) throw tcError('aborted', '已取消');
            return o.onProgress ? probeDuration(o.file) : 0;
          })
          .then(function (total) {
            const report = function (pct) { if (o.onProgress) o.onProgress(pct); };
            const one = function (remux) {
              return run(bin, argsFor(ext, o.file, part, remux), total, report, ctrl.signal);
            };
            if (ext !== 'mp4') return one(false);
            /* flv：先重封装（秒级）；失败再真重编码（VP6 / H.263 这类）。
               取消和超时都不该触发重编码——那等于把等待时间再翻一倍。 */
            return one(true).catch(function (e) {
              if (!e || e.code !== 'ffmpeg-failed' || e.timeout) throw e;
              console.info('[tc] 直接重封装失败，改重编码：' + o.rel);
              return one(false);
            });
          })
          .then(function () {
            if (ctrl.signal.aborted) throw tcError('aborted', '已取消');
            return fsp.rename(part, target);
          })
          .then(function () {
            console.info('[tc] 完成 ' + o.rel + ' → ' + path.basename(target) + '（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
            return { file: target, ext: ext, cached: false };
          })
          .catch(function (e) {
            /* 失败别留下半截文件：下次进来还以为是缓存命中 */
            fsp.unlink(part).catch(function () {});
            fsp.unlink(target).catch(function () {});
            /* 取消是正常路径，不刷告警 */
            if (!e || e.code !== 'aborted') console.warn('[tc] 失败 ' + o.rel + '：' + (e && e.message));
            throw e;
          });
      });
    });
    inflight.set(k, entry);
    /* 只删自己那一条：取消后可能已经有新的任务顶上来 */
    const clear = function () {
      entry.settled = true;
      if (inflight.get(k) === entry) inflight.delete(k);
    };
    entry.task.then(clear, clear);
    return tcWait(entry, o.signal);
  });
}

/* ── 缓存清理：超上限从最旧的删到 80%，顺手清掉 >6 小时的中断残留 ── */
async function sweep(cacheDir, maxBytes) {
  const limit = maxBytes > 0 ? maxBytes : DEFAULT_MAX;
  let list;
  try { list = await fsp.readdir(cacheDir, { withFileTypes: true }); } catch (e) { return; }
  const files = [];
  const now = Date.now();
  for (const f of list) {
    if (!f.isFile()) continue;
    const full = path.join(cacheDir, f.name);
    const isCache = NAME_RE.test(f.name);
    const isPart = /\.part$/.test(f.name);
    if (!isCache && !isPart) continue;
    let st;
    try { st = await fsp.stat(full); } catch (e) { continue; }
    /* 残留的 .part 只可能来自被强杀的进程，放 6 小时足够 */
    if (isPart && now - st.mtimeMs < 6 * 3600 * 1000) continue;
    files.push({ full: full, size: st.size, mtime: st.mtimeMs });
  }
  let total = 0;
  files.forEach(function (f) { total += f.size; });
  if (total > limit) {
    files.sort(function (a, b) { return a.mtime - b.mtime; });
    const floor = limit * 0.8;
    let freed = 0;
    for (const f of files) {
      if (total - freed <= floor) break;
      try { await fsp.unlink(f.full); freed += f.size; } catch (e) {}
    }
    if (freed > 0) console.info('[tc] 缓存清理 ' + (freed / 1048576).toFixed(0) + 'MB');
  } else {
    /* 没超限时只清中断残留 */
    for (const f of files) {
      if (!/\.part$/.test(f.full)) continue;
      try { await fsp.unlink(f.full); } catch (e) {}
    }
  }
}

module.exports = {
  NEEDS,
  NAME_RE,
  DEFAULT_MAX,
  findFfmpeg,
  needs,
  outExt,
  key,
  fileName,
  prepare,
  probeDuration,
  sweep
};
