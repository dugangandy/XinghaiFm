/* ── transcode.js · 按需转码（桌面端主进程与服务端共用）───────────────
 *
 * Chromium 啃不动 FLV 容器（ape / wv / wma 干脆没有解码器，已在
 * js/media.js 里归为「不支持」，不走这里）。FLV 先交给系统 ffmpeg
 * 重封装成 mp4 落到缓存目录，再由 main.js 的 fm://app/__tc/<key>.<ext>
 * 或 tools/serve.js 的 /api/tc/<key>.<ext> 走已有的 Range 直读通道播放。
 * 转码结果是有索引的真文件，拖动、倍速、续播点、时长探测都和普通文件
 * 完全一样，不需要额外的流式逻辑。
 *
 * ffmpeg 不在包里：按 FM_FFMPEG → 项目 bin/ → PATH（含 macOS 常见安装位置）
 * 依次查找，找不到就返回空字符串，由调用方给用户明确的提示。
 *
 * 缓存：<cacheDir>/<sha1(rel|size|mtime)>.<mp4>
 *   key 里带 rel + size + mtime，文件被替换或重扫后自动失效，不需要额外的
 *   失效逻辑；删库换库也不会误用旧缓存。体积由 sweep() 兜底。
 */
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

/* 需要转码的扩展名 → 目标容器。
   ape / wv / wma 不在这里：转一份要几十秒，等待体验太差，改成前端直接提示不支持
   （见 js/media.js 的 UNSUPPORTED），文件仍会被扫描、时长仍能探测。 */
const NEEDS = { flv: 'mp4' };
/* 缓存文件名：40 位 sha1 + 目标扩展名，两个入口都按这个正则白名单校验。
   mp3 是历史遗留：早期 ape / wv 会转成 mp3，留着才能被 sweep() 清掉。 */
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
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const env = String(process.env.FM_FFMPEG || '').trim();
  if (env) {
    list.push(env);
    /* 允许直接把 FM_FFMPEG 设成目录（写成 /opt/homebrew/bin 的比写成全路径的多） */
    try { if (fs.statSync(env).isDirectory()) list.push(path.join(env, exe)); } catch (e) {}
  }
  list.push(path.join(__dirname, 'bin', exe));
  /* macOS 从 Finder/Dock/launchd 启动时 PATH 往往只有 /usr/bin:/bin，brew 装的找不到 */
  if (process.platform !== 'win32') {
    ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg'].forEach(function (p) { list.push(p); });
  }
  /* 非 brew 的常见装法：cargo/pip 装到 ~/.local/bin，asdf/mise 的 shim，nix profile */
  const home = String(process.env.HOME || process.env.USERPROFILE || '');
  if (home) {
    ['/.local/bin', '/bin', '/.asdf/shims', '/.nix-profile/bin'].forEach(function (d) {
      list.push(path.join(home + d, exe));
    });
  }
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  String(process.env.PATH || '').split(path.delimiter).forEach(function (dir) {
    if (!dir) return;
    exts.forEach(function (e) { list.push(path.join(dir, 'ffmpeg' + e)); });
  });
  return list;
}

/* 上次查找留下的线索：远程机器上没法 debug，报错要自己带信息 */
let ffmpegTried = [];

function findFfmpeg(refresh) {
  if (ffmpegPath !== null && !refresh) return ffmpegPath;
  ffmpegPath = '';
  ffmpegTried = [];
  const list = candidates();
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c) continue;
    /* 绝对路径先看存在性，避免对着一堆不存在的路径反复起进程；
       纯命令名（FM_FFMPEG=ffmpeg）交给 spawnSync 走 PATH */
    if (c.indexOf(path.sep) >= 0 || (process.platform === 'win32' && c.indexOf('/') >= 0)) {
      let ok = false;
      try { ok = fs.statSync(c).isFile(); } catch (e) { ok = false; }
      if (!ok) { ffmpegTried.push({ path: c, why: '不存在' }); continue; }
    }
    const r = spawnSync(c, ['-version'], { stdio: 'ignore', timeout: 8000, windowsHide: true });
    if (r && r.status === 0) { ffmpegPath = c; break; }
    /* 文件在却跑不起来：一般是架构不对（x86 的 node 找 arm 的二进制没事，反过来会报
       bad CPU type）或者没有执行权限 —— 这类线索比「未找到」有用得多 */
    ffmpegTried.push({ path: c, why: (r && r.error && r.error.code) || ('退出码 ' + (r && r.status)) });
  }
  return ffmpegPath;
}

/* 找不到 ffmpeg 时给一段人能看懂的说明（serve.js / 主进程启动日志里打） */
function explain() {
  const bad = ffmpegTried.filter(function (t) { return t.why !== '不存在'; });
  const missing = ffmpegTried.length - bad.length;
  const lines = [];
  if (bad.length) {
    lines.push('  存在但执行失败：' + bad.slice(0, 3).map(function (t) {
      return t.path + '（' + t.why + '）';
    }).join('、'));
  }
  lines.push('  共检查 ' + ffmpegTried.length + ' 个位置，其中 ' + missing + ' 个不存在');
  return lines.join('\n');
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

/* 探测走缓存：同一集在「专辑页探一次 + 播放时 prepare 再探一次」很常见，
   而且 /api/duration 是 GET 接口，没有缓存就等于每人每次刷新都起一遍 ffmpeg。
   只缓存成功结果，失败的下次还值得再试。 */
const durCache = new Map();   // file -> { v: {duration}, t }
const DUR_TTL = 10 * 60 * 1000;
const NO_INFO = { duration: 0 };

function probeInfo(file) {
  const bin = findFfmpeg();
  if (!bin) return Promise.resolve(NO_INFO);
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
    } catch (e) { return finish(NO_INFO); }
    const timer = setTimeout(function () { try { p.kill('SIGKILL'); } catch (e) {} finish(NO_INFO); }, PROBE_TIMEOUT);
    p.stderr.on('data', function (d) {
      /* 只留前 64KB：正常文件头信息在第一屏，长文件后面都是流信息 */
      if (err.length < 65536) err += d;
    });
    p.on('error', function () { clearTimeout(timer); finish(NO_INFO); });
    /* ffmpeg 不带输出文件时一定以非 0 退出，这里不看退出码，只解析 stderr */
    p.on('close', function () {
      clearTimeout(timer);
      const info = { duration: parseDuration(err) };
      if (info.duration > 0) {
        if (durCache.size > 1000) durCache.clear();
        durCache.set(file, { v: info, t: Date.now() });
      }
      finish(info);
    });
  });
}

function probeDuration(file) {
  return probeInfo(file).then(function (i) { return i.duration; });
}

/* ── 转码参数 ──
   输出文件带 .part 后缀（写一半被打断也不至于被当成缓存），ffmpeg 认不出扩展名，
   所以容器一律用 -f 显式指定。 */
function baseArgs(file, out, fmt, extra) {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', file]
    .concat(extra)
    .concat(['-f', fmt, '-progress', 'pipe:1', '-nostats', out]);
}

/* ── 重编码用哪个编码器 ──
   10 分钟 720p 用 libx264 veryfast 要 20~40 秒，等待时间太长。优先用硬件编码：
   macOS VideoToolbox / NVIDIA NVENC / Intel QSV / AMD AMF，通常能压到 3~8 秒；
   硬件不可用（没驱动、虚拟机、远程桌面）或运行失败时退回软件 x264。 */
const ENC_ARGS = {
  h264_videotoolbox: ['-c:v', 'h264_videotoolbox', '-b:v', '2500k', '-pix_fmt', 'yuv420p'],
  h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '2500k', '-pix_fmt', 'yuv420p'],
  h264_qsv: ['-c:v', 'h264_qsv', '-global_quality', '23', '-pix_fmt', 'yuv420p'],
  h264_amf: ['-c:v', 'h264_amf', '-quality', 'speed', '-b:v', '2500k', '-pix_fmt', 'yuv420p'],
  /* ultrafast：比 veryfast 再快一倍多，体积大一些，但这类文件本来就是过渡用的 */
  libx264: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p']
};
const SOFT_ENC = { name: 'libx264', args: ENC_ARGS.libx264 };

let encPick = null;
function pickEncoder(bin) {
  if (encPick) return encPick;
  encPick = SOFT_ENC;
  let list = '';
  try {
    const r = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    list = (r && r.stdout) || '';
  } catch (e) { list = ''; }
  const prefs = process.platform === 'darwin'
    ? ['h264_videotoolbox']
    : process.platform === 'win32'
      ? ['h264_nvenc', 'h264_qsv', 'h264_amf']
      : ['h264_nvenc', 'h264_qsv'];
  for (const name of prefs) {
    if (list.indexOf(name) >= 0) { encPick = { name: name, args: ENC_ARGS[name] }; break; }
  }
  if (encPick.name !== 'libx264') console.info('[tc] 重编码使用硬件编码器 ' + encPick.name);
  return encPick;
}

/* 目标容器固定是 mp4（只有 flv 走这条路）。
   mode：copy（音视频都直接搬）｜copyv（视频搬、音频转 aac）｜encode（全重编码） */
function argsFor(file, out, mode, enc) {
  /* -map 带 ? 允许缺轨：只有音频的 flv 也能转出可播的 mp4 */
  const map = ['-map', '0:v:0?', '-map', '0:a:0?'];
  if (mode === 'copy') {
    /* 绝大多数 flv 是 H.264 + AAC，重封装几乎不耗 CPU（100 倍以上实时） */
    return baseArgs(file, out, 'mp4', map.concat(['-c', 'copy', '-movflags', '+faststart']));
  }
  if (mode === 'copyv') {
    /* 视频能搬、音频搬不动（MP3 音轨、AAC 的 extradata 不合规等）：
       只把音频重新编一遍，10 分钟的视频也就 1 秒左右，比整体重编码划算得多 */
    return baseArgs(file, out, 'mp4', map.concat(['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']));
  }
  return baseArgs(file, out, 'mp4', map.concat(enc.args).concat(['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']));
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
 * @returns {Promise<{file:string, ext:'mp4', cached:boolean}>}
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
      if (!(st.isFile() && st.size > 0)) return null;
      /* 命中就摸一下 mtime：sweep() 按 mtime 清「最久未用」的缓存，
         只按转码完成时间排会把常听的老文件先删掉。 */
      const now = new Date();
      fsp.utimes(target, now, now).catch(function () {});
      return { file: target, ext: ext, cached: true };
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
        let how = '';   // 记下这次实际走的哪条路，完成日志里带上
        return fsp.mkdir(o.cacheDir, { recursive: true })
          /* 探测总时长：只为了报转换百分比。
             ffmpeg -i 只读文件头，百毫秒级，比转码本身便宜得多 */
          .then(function () {
            if (ctrl.signal.aborted) throw tcError('aborted', '已取消');
            if (!o.onProgress) return NO_INFO;
            return probeInfo(o.file);
          })
          .then(function (info) {
            const total = (info && info.duration) || 0;
            const report = function (pct) { if (o.onProgress) o.onProgress(pct); };
            const one = function (mode, enc) {
              if (mode === 'copy') how = '重封装';
              else if (mode === 'copyv') how = '视频搬+音频转码';
              else how = '重编码(' + (enc || SOFT_ENC).name + ')';
              return run(bin, argsFor(o.file, part, mode, enc || SOFT_ENC), total, report, ctrl.signal);
            };
            const enc = pickEncoder(bin);
            /* 三级降级：整体重封装（1~2 秒）→ 只重编音频（几秒）→ 全重编码（硬件优先）。
               取消和超时都不升级，否则等于把等待时间再翻一倍。 */
            const again = function (e) { return e && e.code === 'ffmpeg-failed' && !e.timeout; };
            return one('copy').catch(function (e) {
              if (!again(e)) throw e;
              console.info('[tc] 整体重封装失败，先只重编音频：' + o.rel);
              return one('copyv').catch(function (e2) {
                if (!again(e2)) throw e2;
                console.info('[tc] 音轨也搬不动，改重编码（' + enc.name + '）：' + o.rel);
                return one('encode', enc).catch(function (e3) {
                  /* 硬件编码器在列表里但跑不起来（无 GPU 的虚拟机、远程桌面）→ 退回软件 */
                  if (enc.name === 'libx264' || !again(e3)) throw e3;
                  console.info('[tc] ' + enc.name + ' 不可用，改用 libx264：' + o.rel);
                  return one('encode', SOFT_ENC);
                });
              });
            });
          })
          .then(function () {
            if (ctrl.signal.aborted) throw tcError('aborted', '已取消');
            return fsp.rename(part, target);
          })
          .then(function () {
            console.info('[tc] 完成 ' + o.rel + ' → ' + path.basename(target) + '（' + ((Date.now() - t0) / 1000).toFixed(1) + 's，' + how + '）');
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
  candidates,
  explain,
  needs,
  outExt,
  key,
  fileName,
  prepare,
  probeInfo,
  probeDuration,
  sweep
};
