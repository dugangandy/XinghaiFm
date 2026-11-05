/* ── main.js · Electron 主进程 ───────────────────────── */
/* 静音 node:sqlite 的 ExperimentalWarning（必须在 require db 之前） */
(function () {
  const orig = process.emitWarning;
  process.emitWarning = function (w, t) {
    const ty = typeof t === 'string' ? t : (t && t.type);
    if (ty === 'ExperimentalWarning' || /SQLite/i.test(String(w))) return;
    return orig.apply(process, arguments);
  };
})();
const { app, BrowserWindow, ipcMain, dialog, protocol, net, nativeTheme, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');
const DB = require('./db');
const covers = require('./cover-fetch');
const TC = require('./transcode');
const { createWatcher } = require('./watch');

const ROOT = __dirname;
/* ape / wv / wma 能扫进来但 Chromium 解不了（点了明确提示不支持）；
   flv 容器认不全，播放前由 transcode.js 重封装成 mp4 */
const MEDIA = new Set([
  'm4a', 'm4b', 'mp3', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'ape', 'wv',
  'mp4', 'm4v', 'mov', 'webm', 'ogv', 'flv'
]);
/* 递归深度上限。一次 walk 的结果要同时服务两种分组口径（「按目录分两级」开关只影响
   分组，不影响扫描缓存），所以留足余量：分类/专辑/子目录/CD1/… 里的音频都要能收到，
   再深的目录按同一张专辑归并，不会因为开关切换就要重新扫盘 */
const MAX_DEPTH = 6;
const SKIP = /^[._]|^(fm|dist|build|node_modules|\$RECYCLE\.BIN|System Volume Information)$/i;

let win = null;
let lastCfg = null;

/* ── 配置：存 SQLite，桌面端固定用 admin 用户 ── */
function getDb() {
  if (getDb._db) return getDb._db;
  const file = process.env.FM_DATA_FILE ? path.resolve(process.env.FM_DATA_FILE) : path.join(app.getPath('userData'), 'fm.db');
  const db = DB.open(file);
  DB.ensureSchema(db);
  if (DB.countUsers(db) === 0) {
    /* 首次启动：把旧的 config.json / .auth.json / remote.json 迁进来 */
    const s = DB.migrate(db, {
      authFile: process.env.FM_AUTH_FILE ? path.resolve(process.env.FM_AUTH_FILE) : path.join(__dirname, '.auth.json'),
      configFile: path.join(app.getPath('userData'), 'config.json'),
      remoteFile: path.join(app.getPath('userData'), 'remote.json')
    });
    if (s.generatedPassword) {
      console.log('[db] 已创建 admin，初始密码：' + s.generatedPassword + '（用 npm run init-db -- --set-password admin 修改）');
    }
  }
  getDb._db = db;
  return db;
}
function adminUid() {
  const u = DB.adminUser(getDb());
  return u ? u.id : DB.ADMIN_ID;
}

function newLibId() { return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/* getConfig/saveConfig 保持原接口：IPC 里先 getConfig() 改对象，再 saveConfig() 落库。
   每次 getConfig 都从库里读，服务端改了库桌面端能立刻看到。 */
function getConfig() {
  const db = getDb();
  const uid = adminUid();
  const libs = DB.listLibs(db, uid).map(function (l) { return { id: l.id, name: l.name, path: l.path, addedAt: l.addedAt, watch: l.watch ? 1 : 0 }; });
  const a = DB.activeLib(db, uid);
  lastCfg = { libs: libs, active: a ? a.id : (libs[0] ? libs[0].id : null) };
  return lastCfg;
}

function saveConfig(cfg) {
  const c = cfg || lastCfg;
  if (!c) throw new Error('资源库配置保存失败：没有可保存的配置');
  try {
    DB.replaceLibs(getDb(), adminUid(), c.libs, c.active);
  } catch (e) {
    console.warn('[config] 写入失败', e);
    throw new Error('资源库配置保存失败，请稍后重试');
  }
  lastCfg = c;
}

/* ── 远程后端：本地 UI + 远端数据（存 SQLite 的 remote 表） ── */
function readRemote() {
  const r = DB.getRemote(getDb());
  if (r && r.base) return { base: String(r.base).replace(/\/+$/, ''), token: String(r.token || '') };
  return null;
}
function writeRemote(cfg) {
  try {
    if (!cfg || !cfg.base) { DB.setRemote(getDb(), null); return null; }
    const data = { base: String(cfg.base).replace(/\/+$/, ''), token: String(cfg.token || ''), uid: adminUid() };
    DB.setRemote(getDb(), data);
    return { base: data.base, token: data.token };
  } catch (e) { console.warn('[remote] 写入失败', e); return null; }
}

function activeLib() {
  const cfg = getConfig();
  return cfg.libs.find(l => l.id === cfg.active) || null;
}

function libView(l) {
  return {
    id: l.id, name: l.name, path: l.path, missing: !fs.existsSync(l.path),
    /* dirMode 是三档（flat / cat / auto）；dirGroup 是老字段，只为兼容旧版渲染层 */
    dirMode: DB.libDirMode(getDb(), l.path),
    dirGroup: DB.libDirGroup(getDb(), l.path),
    watch: !!l.watch
  };
}

/* ── 自定义协议：把静态资源当作 app 源，localStorage / Web Audio 才有正常 origin ── */
protocol.registerSchemesAsPrivileged([{
  scheme: 'fm',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
}]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* ── 音频流：Range 直读磁盘，避免把整本有声书读进内存 ──
   挂在 fm://app 下而不是独立 host，保证与页面同源：
   跨源的话 Web Audio 的 createMediaElementSource 只能拿到静音波形。 */
const MEDIA_PREFIX = '__media';
const COVER_PREFIX = '__cover';
const TC_PREFIX = '__tc';
const COVER_DIR = '.fm-covers';
const META_FILE = '.fm-meta.json';
const MEDIA_MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.ape': 'audio/x-ape',
  '.wv': 'audio/x-wavpack',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.flv': 'video/x-flv'
};

/* 只支持单段 Range；多段请求当作整段返回，播放器不会走到那条路 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {
    const tail = parseInt(m[2], 10);
    if (!(tail > 0)) return null;
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

function mediaResponse(request, file, stat) {
  const size = stat.size;
  const headers = {
    'content-type': MEDIA_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store'
  };
  const range = parseRange(request.headers.get('range'), size);
  const head = request.method === 'HEAD';

  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: Object.assign({}, headers, { 'content-range': 'bytes */' + size })
    });
  }
  if (!range) {
    return new Response(head ? null : Readable.toWeb(fs.createReadStream(file)), {
      status: 200,
      headers: Object.assign({}, headers, { 'content-length': String(size) })
    });
  }
  return new Response(head ? null : Readable.toWeb(fs.createReadStream(file, { start: range.start, end: range.end })), {
    status: 206,
    headers: Object.assign({}, headers, {
      'content-length': String(range.end - range.start + 1),
      'content-range': 'bytes ' + range.start + '-' + range.end + '/' + size
    })
  });
}

async function serveMedia(request, rel) {
  if (!activeLib()) return new Response('no library', { status: 404 });
  let file;
  try { file = insideRoot(rel); } catch (e) { return new Response('forbidden', { status: 403 }); }
  let stat;
  try {
    stat = await fsp.stat(file);
    if (!stat.isFile()) return new Response('not found', { status: 404 });
  } catch (e) {
    return new Response('not found', { status: 404 });
  }
  return mediaResponse(request, file, stat);
}

/* ── 转码缓存：flv 转出来的 mp4 落在这里 ── */
function tcDir() {
  return path.join(app.getPath('userData'), 'tc');
}

/* 缓存文件名由 transcode.js 生成（40 位 sha1 + 目标扩展名），
   这里只认这个形状，天然挡住路径穿越；再在缓存目录内二次确认。 */
async function serveTc(request, name) {
  if (!TC.NAME_RE.test(name)) return new Response('not found', { status: 404 });
  const file = path.join(tcDir(), name);
  if (path.dirname(path.normalize(file)) !== path.normalize(tcDir())) return new Response('forbidden', { status: 403 });
  let stat;
  try {
    stat = await fsp.stat(file);
    if (!stat.isFile()) return new Response('not found', { status: 404 });
  } catch (e) {
    return new Response('not found', { status: 404 });
  }
  return mediaResponse(request, file, stat);
}

/* ── 专辑封面：直接从 .fm-covers 里读，不需要 Range ──
   libId 由 URL 的 ?lib= 带上：封面文件名是「目录哈希-内容哈希」，
   早期数据只有目录哈希 —— 两个库有同名目录时 URL 会撞在一起，
   浏览器缓存（24h）下就会把 A 库的图显示到 B 库头上。 */
async function serveCover(name, libId) {
  const cfg = getConfig();
  const lib = (libId && cfg.libs.find(l => l.id === libId)) || activeLib();
  if (!lib || !name) return new Response('not found', { status: 404 });
  let file;
  try { file = insideRoot(COVER_DIR + '/' + name, lib); } catch (e) { return new Response('forbidden', { status: 403 }); }
  try {
    const data = await fsp.readFile(file);
    return new Response(data, {
      status: 200,
      headers: {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'image/jpeg',
        'cache-control': 'max-age=86400'
      }
    });
  } catch (e) {
    return new Response('not found', { status: 404 });
  }
}

function registerProtocol() {
  protocol.handle('fm', async function (request) {
    const u = new URL(request.url);
    /* 逐段解码，避免 %2F 重新变成路径分隔符 */
    const segs = u.pathname.split('/').filter(Boolean).map(function (s) {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    });
    if (segs[0] === MEDIA_PREFIX) return serveMedia(request, segs.slice(1).join('/'));
    if (segs[0] === COVER_PREFIX) return serveCover(segs.slice(1).join('/'), u.searchParams.get('lib') || '');
    if (segs[0] === TC_PREFIX) return serveTc(request, segs.slice(1).join('/'));

    const target = path.normalize(path.join(ROOT, '/' + (segs.length ? segs.join('/') : 'index.html')));
    /* 必须带分隔符，否则同名兄弟目录（fm-xxx）也能通过前缀匹配 */
    if (!target.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
    try {
      const data = await fsp.readFile(target);
      return new Response(data, {
        status: 200,
        headers: { 'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' }
      });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });
}

/* ── 扫描 ──
 * 结果按库目录缓存到 fm.db（settings 键 scan:<库目录>）：一台机器扫过一次之后，
 * 重启 App、切库、换个用户在网页端登录都直接读这份，不再各自重扫整库。
 * 只有「重新扫描」（refresh=true）才真走盘。 */
const scanMem = new Map();   // settings 反序列化后的结果，省掉每次请求的 JSON.parse

function scanKey(root) { return 'scan:' + DB.libRootKey(root); }

/* 内存层用 settings 里的小时间戳（scan:<库>:at）校验：serve.js 和桌面主进程共用同一个 fm.db，
   另一端重新扫描后这里也能跟上，不会抱着常驻内存里的旧结果直到重启 */
function readScanCache(root) {
  const k = scanKey(root);
  let stamp = '';
  try { stamp = DB.getSetting(getDb(), k + ':at', ''); } catch (e) { return null; }
  const mem = scanMem.get(k);
  if (mem && stamp && String(mem.scannedAt) === stamp) return mem;
  let raw = '';
  try { raw = DB.getSetting(getDb(), k, ''); } catch (e) { return null; }
  if (!raw) { scanMem.delete(k); return null; }
  try {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.files)) return null;
    scanMem.set(k, data);
    return data;
  } catch (e) { return null; }
}

function writeScanCache(root, data) {
  const k = scanKey(root);
  const at = data.scannedAt || Date.now();
  try {
    /* 新旧守卫：两次扫描交错时，别让先开始那次（较旧）的快照把新快照盖回去 */
    const prev = Number(DB.getSetting(getDb(), k + ':at', '0')) || 0;
    if (prev > at) return;
    DB.setSetting(getDb(), k, JSON.stringify(data));
    DB.setSetting(getDb(), k + ':at', String(at));
  } catch (e) { console.warn('[scan] 写缓存失败', e.message); }
  scanMem.set(k, data);
}

function dropScanCache(root) {
  const k = scanKey(root);
  scanMem.delete(k);
  try { DB.setSetting(getDb(), k, ''); DB.setSetting(getDb(), k + ':at', ''); } catch (e) {}
}

/* 同一库同一时刻只跑一个 walk（重复点「重新扫描」不会叠出多路 stat）。
   卡死的 walk（移动硬盘拔了、网络盘掉线）超过 SCAN_STALE_MS 就放弃重来，
   否则手动重扫也会永远挂在那一个 Promise 上 */
const scanInflight = new Map();
const SCAN_STALE_MS = 5 * 60 * 1000;

async function walkAndCache(root) {
  const out = [];
  /* 先把文件收集起来，readdir 走完再统一 stat：stat 是逐个系统调用，串行做在
     NAS / 移动硬盘 / 机械盘上能把整库扫描拖到分钟级，8 路并发快一个数量级，
     又不至于把磁盘打满（网络盘再大会退化成排队，不会更慢） */
  const pending = [];
  const STAT_CONC = 8;
  async function walk(dir, prefix, depth) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (SKIP.test(entry.name)) continue;
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(abs, rel, depth + 1);
      } else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf('.');
        const ext = dot < 0 ? '' : entry.name.slice(dot + 1).toLowerCase();
        if (!MEDIA.has(ext)) continue;
        pending.push({ rel, name: entry.name, ext, depth, abs, size: 0, mtime: 0 });
      }
    }
  }
  await walk(root, '', 1);
  for (let i = 0; i < pending.length; i += STAT_CONC) {
    await Promise.all(pending.slice(i, i + STAT_CONC).map(async function (it) {
      let st = null;
      try { st = await fsp.stat(it.abs); } catch (e) {}
      it.size = st ? st.size : 0;
      it.mtime = st ? st.mtimeMs : 0;
    }));
  }
  pending.forEach(function (it) {
    out.push({ rel: it.rel, name: it.name, ext: it.ext, size: it.size, mtime: it.mtime, depth: it.depth });
  });
  const data = { rootName: path.basename(root), root: root, scannedAt: Date.now(), files: out };
  writeScanCache(root, data);
  return data;
}

/* 等同一库那次 walk 最多等这么久：移动硬盘/网络盘卡住时不能让请求一直挂着，
   超时先把旧缓存回给界面，后台那次 walk 跑完仍然会落盘。
   第一次扫大库（几万文件、外接盘）两分钟也未必够，120 秒是个折中：
   超过就先用旧数据顶上，扫描不会白跑 */
const SCAN_WAIT_MS = 120000;

function withTimeout(p, ms) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () {
      const e = new Error('扫描超时'); e.code = 'ETIMEDOUT'; reject(e);
    }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

async function scanFolder(root, opts) {
  const o = opts || {};
  const cached = readScanCache(root);
  if (!o.refresh && cached) return cached;
  const k = scanKey(root);
  let rec = scanInflight.get(k);
  if (rec && Date.now() - rec.at > SCAN_STALE_MS) {
    console.warn('[scan] 上一次扫描卡住超过 5 分钟，丢弃重来');
    scanInflight.delete(k);
    rec = null;
  }
  if (!rec) {
    const entry = { at: Date.now(), p: null };
    entry.p = walkAndCache(root).finally(function () {
      /* 只清自己这一条：被判定卡死而替换掉的旧 walk 结束时不能把新的删掉 */
      if (scanInflight.get(k) === entry) scanInflight.delete(k);
    });
    scanInflight.set(k, entry);
    rec = entry;
  }
  try {
    return await withTimeout(rec.p, SCAN_WAIT_MS);
  } catch (err) {
    if (cached) {
      console.warn('[scan] 扫描超过 ' + Math.round(SCAN_WAIT_MS / 1000) + ' 秒，先回上次结果；后台扫完会自动落盘');
      /* stale：前端据此提示「还在后台扫」，别让人以为已经扫完了 */
      return Object.assign({}, cached, { stale: true });
    }
    /* 连旧缓存都没有（第一次扫这么大的库）：不能说「扫描失败」，
       后台那次 walk 还在跑，扫完会落盘，再扫一次就读到了。
       真正的走盘错误（目录被删、权限不足）照原样抛出去 */
    if (err && err.code === 'ETIMEDOUT') {
      const e2 = new Error('库太大，第一次扫描还没跑完；它会在后台继续，稍后再点「重新扫描」就能看到结果');
      e2.code = 'ESCANNING';
      throw e2;
    }
    throw err;
  }
}

/* ── 目录自动监听（chokidar）──
   只对用户在库设置里打开的库生效；命中变化后防抖触发 scanFolder(refresh)，
   复用上面的 scanInflight 互斥与扫描缓存写入，扫描逻辑本身不变。 */
const libWatcher = createWatcher({
  scan: function (root) { return scanFolder(root, { refresh: true }); }
});
function syncWatchers() {
  try {
    const cfg = getConfig();
    libWatcher.setRoots(cfg.libs.map(function (l) {
      return { id: l.id, path: l.path, watch: !!l.watch };
    }));
  } catch (e) {
    console.warn('[watch] 同步监听失败：' + ((e && e.message) || e));
  }
}
let watchTick = 0;   /* 60 秒对账定时器（另一个进程改 watch 时也能跟上） */

function insideRoot(rel, libIn) {
  const lib = libIn || activeLib();
  if (!lib) throw new Error('尚未选择资源库');
  const target = path.normalize(path.join(lib.path, rel));
  const base = path.normalize(lib.path + path.sep);
  if (!target.startsWith(base)) throw new Error('路径越界');
  return target;
}

/* ── 资源库元数据：桌面端写、服务端读、手机端的进度再合并回来 ── */
function knownLibPath(p) {
  if (!p) return null;
  const target = path.resolve(String(p)).toLowerCase();
  const lib = getConfig().libs.find(l => path.resolve(l.path).toLowerCase() === target);
  return lib ? lib.path : null;
}

async function statOrNull(file) {
  try { return await fsp.stat(file); } catch (e) { return null; }
}
function stampOf(st) { return st ? st.mtimeMs + ':' + st.size : '0'; }

/* 进度按时间戳逐条合并：谁更新听谁的，不会把手机刚听的记录冲掉 */
function mergeMeta(cur, incoming) {
  const out = Object.assign({}, incoming || {});
  const a = (cur && cur.progress) || {};
  const b = out.progress || {};
  const merged = Object.assign({}, a, b);
  Object.keys(a).forEach(function (k) {
    const x = a[k];
    const y = b[k];
    if (!y || (Number(y.t) || 0) < (Number(x.t) || 0)) merged[k] = x;
  });
  out.progress = merged;
  out.updatedAt = Date.now();
  return out;
}

/* ── 界面特效档位 ──
   默认走精简档。这里踩过一次坑：老 Intel Mac 上 gpu_compositing 依然报 enabled，
   但 90px 模糊 + 混合模式 + 毛玻璃一开，CPU 立刻翻倍 —— 从 Chromium 的任何接口
   都分不清「没有硬件加速」和「有加速但显卡扛不住」，前者还能靠 glRenderer 里的
   warp/swiftshader 认出来，后者完全看不出来。
   所以默认取安全档，想要全特效启动前设 FM_FX=full。 */
let gpuAccel = false;

function resolveFx() {
  const fx = String(process.env.FM_FX || '').toLowerCase();
  if (fx === 'full') return true;
  return false;
}

/* 只打日志，不参与决策：真出问题时能一眼看出跑的是哪条渲染路径 */
function logGpuInfo() {
  let done = false;
  function dump() {
    if (done) return;
    done = true;
    app.getGPUInfo('complete').then(function (info) {
      const s = app.getGPUFeatureStatus() || {};
      const aux = info.auxAttributes || {};
      console.log('[gpu] 合成=' + s.gpu_compositing +
        ' 光栅=' + s.rasterization +
        ' 渲染器=' + (aux.glRenderer || '?') +
        ' 特效档位=' + (gpuAccel ? 'full' : 'light'));
    }).catch(function () {});
  }
  app.once('gpu-info-update', dump);
  setTimeout(dump, 1500);
}

/* ── IPC ── */
function bindIpc() {
  /* 远程配置：preload 启动时同步取一次，连接/断开后由页面 reload 生效 */
  ipcMain.on('fm:remote', function (e) { e.returnValue = readRemote(); });
  /* 硬件加速开关：preload 同步取一次，页面据此加 html.hw */
  ipcMain.on('fm:gpu', function (e) { e.returnValue = gpuAccel; });
  /* 应用版本号：渲染进程在左侧 logo 旁显示 */
  ipcMain.on('fm:version', function (e) { e.returnValue = app.getVersion(); });
  ipcMain.handle('fm:setRemote', function (e, cfg) { return writeRemote(cfg); });

  ipcMain.handle('fm:libs', function () {
    const cfg = getConfig();
    return { active: cfg.active, libs: cfg.libs.map(libView), watchAvailable: libWatcher.available };
  });

  /* preset 有值时跳过系统选目录框（自动化测试用） */
  ipcMain.handle('fm:addLib', async function (e, preset) {
    let dir = typeof preset === 'string' && preset ? preset : '';
    if (!dir) {
      const res = await dialog.showOpenDialog(win, {
        title: '添加资源库',
        buttonLabel: '添加此文件夹',
        properties: ['openDirectory', 'dontAddToRecent']
      });
      if (res.canceled || !res.filePaths.length) return null;
      dir = res.filePaths[0];
    }
    if (!fs.existsSync(dir)) throw new Error('资源库目录不存在');
    const cfg = getConfig();
    const key = path.resolve(dir).toLowerCase();
    const exist = cfg.libs.find(l => path.resolve(l.path).toLowerCase() === key);
    if (exist) {
      cfg.active = exist.id;
      saveConfig();
      return { lib: libView(exist), existing: true };
    }
    const lib = { id: newLibId(), name: path.basename(dir) || '资源库', path: dir, addedAt: Date.now() };
    cfg.libs.push(lib);
    cfg.active = lib.id;
    saveConfig();
    syncWatchers();
    return { lib: libView(lib), existing: false };
  });

  ipcMain.handle('fm:activate', function (e, id) {
    const cfg = getConfig();
    const lib = cfg.libs.find(l => l.id === id);
    if (!lib) return false;
    cfg.active = lib.id;
    saveConfig();
    return true;
  });

  ipcMain.handle('fm:renameLib', function (e, id, name) {
    const cfg = getConfig();
    const lib = cfg.libs.find(l => l.id === id);
    if (!lib) return null;
    const clean = String(name || '').trim().slice(0, 40);
    if (clean) lib.name = clean;
    saveConfig();
    return libView(lib);
  });

  ipcMain.handle('fm:relocate', async function (e, id) {
    const cfg = getConfig();
    const lib = cfg.libs.find(l => l.id === id);
    if (!lib) return null;
    const res = await dialog.showOpenDialog(win, {
      title: '重新定位「' + lib.name + '」',
      buttonLabel: '使用此文件夹',
      properties: ['openDirectory', 'dontAddToRecent']
    });
    if (res.canceled || !res.filePaths.length) return null;
    const oldPath = lib.path;
    lib.path = res.filePaths[0];
    /* 选目录期间可能有其它 IPC 刷新 lastCfg，必须保存这次修改的配置对象 */
    saveConfig(cfg);
    /* 旧路径的扫描缓存已经没用了，清掉（几 MB 的孤儿行），新路径第一次进库会重新扫 */
    if (oldPath && path.resolve(oldPath) !== path.resolve(lib.path)) dropScanCache(oldPath);
    /* 监听的是目录：重新定位后要按新路径重挂 */
    syncWatchers();
    return libView(lib);
  });

  ipcMain.handle('fm:removeLib', function (e, id) {
    const cfg = getConfig();
    const i = cfg.libs.findIndex(l => l.id === id);
    if (i < 0) return { active: cfg.active };
    const gone = cfg.libs[i];
    cfg.libs.splice(i, 1);
    if (cfg.active === id) cfg.active = cfg.libs[0] ? cfg.libs[0].id : null;
    saveConfig();
    DB.clearFavs(getDb(), adminUid(), id);
    /* 元数据按库目录存：库被移除时顺手清掉，别留孤儿行 */
    try { DB.clearLibMeta(getDb(), gone.path); } catch (err) {}
    /* 扫描缓存也一起清掉，重新加回来时按新内容扫 */
    dropScanCache(gone.path);
    /* 库没了就别再监听它的目录 */
    syncWatchers();
    return { active: cfg.active };
  });

  /* refresh=true 只有前端「重新扫描」会传；平时读 fm.db 里的扫描缓存 */
  ipcMain.handle('fm:scan', async function (e, refresh) {
    const lib = activeLib();
    if (!lib) throw new Error('尚未选择资源库');
    if (!fs.existsSync(lib.path)) throw new Error('资源库目录不存在：' + lib.name);
    /* 封面不再扫描时自动拉取：交给用户在网页里手动编辑（上传/抓取/删除）。
       扫描结果里不再带 coversPending，界面不会去轮询不存在的后台抓取。 */
    const scan = await scanFolder(lib.path, { refresh: !!refresh });
    /* 目录结构跟着扫描结果一起下发：渲染层不用再单独取一次。
       拷贝后补字段，扫描缓存里的对象保持不变 */
    return Object.assign({}, scan, {
      dirMode: DB.libDirMode(getDb(), lib.path),
      dirGroup: DB.libDirGroup(getDb(), lib.path)
    });
  });

  /* 「目录结构」三档开关：只改元数据，不动扫描缓存。
     id 必须精确命中，找不到就返回 'flat'——别回退到当前库，否则传错 id 会悄悄改掉另一个库 */
  ipcMain.handle('fm:setLibDirMode', function (e, id, mode) {
    const lib = getConfig().libs.find(l => l.id === id);
    if (!lib) return 'flat';
    return DB.setLibDirMode(getDb(), lib.path, mode);
  });

  /* 老通道：布尔版（false=默认，true=二级目录）。新版渲染层走 fm:setLibDirMode */
  ipcMain.handle('fm:setLibDirGroup', function (e, id, on) {
    const lib = getConfig().libs.find(l => l.id === id);
    if (!lib) return false;
    return DB.setLibDirGroup(getDb(), lib.path, !!on);
  });

  /* 目录自动监听开关：只改 fm.db 的库记录并即时启停 chokidar */
  ipcMain.handle('fm:setLibWatch', function (e, id, on) {
    const lib = getConfig().libs.find(l => l.id === id);
    if (!lib) return false;
    const v = DB.setLibWatch(getDb(), id, !!on);
    if (v === null) return false;
    lib.watch = v ? 1 : 0;
    syncWatchers();
    return !!v;
  });

  /* ── 网页手动编辑封面：搜索候选 / 保存 / 删除，三者都走 .fm-covers/ ── */
  ipcMain.handle('fm:searchCover', async function (e, title, opts) {
    const lib = activeLib();
    if (!lib) return [];
    const o = (opts && typeof opts === 'object') ? opts : {};
    const limit = Math.max(1, Math.min(24, Number(o.limit) || 8));
    try {
      return await covers.searchCandidates(title, limit, { page: o.page, limit: limit, seed: o.seed });
    } catch (err) { return []; }
  });
  /* libId 由渲染层带上：封面写入可能跨过切库那一刻，不能按「主进程当前库」定位，
     否则会把这一库的封面写进另一个库的同名目录 */
  ipcMain.handle('fm:saveCover', async function (e, dirName, payload, libId) {
    const lib = (libId && getConfig().libs.find(l => l.id === libId)) || activeLib();
    if (!lib || !dirName) return null;
    try {
      const entry = await covers.saveCoverForDir(lib.path, dirName, payload || {});
      if (win && !win.isDestroyed()) win.webContents.send('fm:covers', { libId: lib.id, added: 1 });
      return entry;
    } catch (err) {
      /* 原因带回渲染进程：权限类错误（EACCES）只说一句「本地写入失败」没法排查 */
      const reason = (err && err.message) || '未知错误';
      console.warn('[cover] 保存失败：' + reason);
      return { error: reason };
    }
  });
  ipcMain.handle('fm:deleteCover', async function (e, dirName, libId) {
    const lib = (libId && getConfig().libs.find(l => l.id === libId)) || activeLib();
    if (!lib || !dirName) return false;
    try {
      await covers.removeCover(lib.path, dirName);
      if (win && !win.isDestroyed()) win.webContents.send('fm:covers', { libId: lib.id, added: 0 });
      return true;
    } catch (err) { return false; }
  });

  ipcMain.handle('fm:covers', function (e, libId) {
    /* 读索引同样按调用方指定的库：切库瞬间的读要落到发起时那个库 */
    const lib = (libId && getConfig().libs.find(l => l.id === libId)) || activeLib();
    if (!lib) return null;
    try {
      const raw = fs.readFileSync(path.join(lib.path, COVER_DIR, 'covers.json'), 'utf8');
      return JSON.parse(raw);
    } catch (e) { return null; }
  });

  /* 导出快照：真数据在 fm.db，这里只是把当前状态写一份 .fm-meta.json 方便排查/回滚 */
  ipcMain.handle('fm:saveMeta', async function (e, libPath, json) {
    const root = knownLibPath(libPath);
    if (!root) return false;
    const file = path.join(root, META_FILE);
    try {
      const incoming = JSON.parse(String(json || '{}')) || {};
      /* 老版本的另一端可能还在写这个文件：写前确认这期间没人动过，动过就重来（乐观并发，最多 3 次） */
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await statOrNull(file);
        let cur = null;
        try { cur = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e2) {}
        const out = mergeMeta(cur, incoming);
        const after = await statOrNull(file);
        if (stampOf(before) !== stampOf(after) && attempt < 2) continue;
        const tmp = file + '.' + process.pid + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify(out));
        await fsp.rename(tmp, file);
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[meta] 写入失败', err.message);
      return false;
    }
  });

  /* 旧接口：只读 .fm-meta.json（现在它是导出快照，界面不再从这儿取数据） */
  ipcMain.handle('fm:loadMeta', async function (e, libPath) {
    const root = knownLibPath(libPath);
    if (!root) return null;
    try {
      const data = JSON.parse(await fsp.readFile(path.join(root, META_FILE), 'utf8'));
      return {
        progress: data.progress || {},
        durations: data.durations || {},
        updatedAt: data.updatedAt || 0
      };
    } catch (err) { return null; }
  });

  /* ── 库元数据（分类 / 专辑整理 / 进度 / 时长）──
     住 SQLite，和网页端、手机端共用同一份；按库目录共享，不区分用户。
     升级后第一次读某个库时，把 .fm-meta.json 里的旧数据搬进库（每库一次，失败不影响读） */
  ipcMain.handle('fm:meta', function (e, libId) {
    const cfg = getConfig();
    const id = libId || cfg.active;
    const lib = id ? cfg.libs.find(l => l.id === id) : null;
    if (!lib) return null;
    try { DB.migrateLegacyMeta(getDb(), lib.path, lib.path); } catch (err) { console.warn('[meta] 迁移失败', err.message); }
    /* 桌面是单用户：收听类数据（进度 / 队列 / 偏好）挂在固定 admin 账号下，
       和 favs 用的是同一个 uid，换设备搬到服务端也认得出是同一个人 */
    return DB.metaSnapshot(getDb(), lib.path, adminUid());
  });
  ipcMain.handle('fm:metaPatch', function (e, libId, patch) {
    const cfg = getConfig();
    const id = libId || cfg.active;
    const lib = id ? cfg.libs.find(l => l.id === id) : null;
    if (!lib) return null;
    try { return DB.metaApply(getDb(), lib.path, patch || {}, adminUid()); }
    catch (err) { console.warn('[meta] 写入失败', err.message); return null; }
  });

  /* 收藏：跟用户绑定，落 SQLite（桌面端固定 admin 用户） */
  ipcMain.handle('fm:favs', function (e, libId) {
    const cfg = getConfig();
    const id = libId || cfg.active;
    if (!id) return [];
    return DB.listFavs(getDb(), adminUid(), id);
  });
  ipcMain.handle('fm:setFav', function (e, libId, albumId, on) {
    const id = libId || (activeLib() && activeLib().id);
    if (!id || !albumId) return false;
    return DB.setFav(getDb(), adminUid(), id, albumId, !!on);
  });
  ipcMain.handle('fm:favTracks', function (e, libId) {
    const cfg = getConfig();
    const id = libId || cfg.active;
    if (!id) return [];
    return DB.listFavTracks(getDb(), adminUid(), id);
  });
  ipcMain.handle('fm:setFavTrack', function (e, libId, trackId, on) {
    const id = libId || (activeLib() && activeLib().id);
    if (!id || !trackId) return false;
    return DB.setFavTrack(getDb(), adminUid(), id, trackId, !!on);
  });

  /* ── 收听时长统计：桌面端单用户挂在固定 admin 账号下（服务端由会话决定 uid） ── */
  ipcMain.handle('fm:listenAdd', function (e, day, deltaSecs, hour, catId) {
    try { DB.listenStatsAdd(getDb(), adminUid(), String(day || ''), Number(deltaSecs) || 0, Number(hour) || 0, catId); return { ok: true }; }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  ipcMain.handle('fm:listenQuery', function (e, fromDay, toDay) {
    try { return { ok: true, rows: DB.listenStatsQuery(getDb(), adminUid(), String(fromDay || ''), String(toDay || '')) }; }
    catch (err) { return { ok: false, rows: [] }; }
  });

  /* ── 转码：Chromium 认不全的 flv 先重封装成 mp4 再播（ape / wv / wma 前端直接提示不支持） ──
     返回 { url, ext, cached } 或 { error, message }。前端拿到 url 直接当媒体源用；
     进度通过 'fm:tc' 推给页面（同一时间只会有一个任务在转，串行限流在 transcode.js 里）。 */
  /* 页面切走时按 id 取消：光让页面「不等了」没用，主进程得把排队中/正在转的任务停掉，
     否则连点几集就会在后台排一长串没人要的转码，CPU 一直烧着 */
  const tcCancels = new Map();   // id -> AbortController
  ipcMain.on('fm:tcCancel', function (e, id) {
    const c = tcCancels.get(String(id || ''));
    if (c) { try { c.abort(); } catch (err) {} }
  });

  ipcMain.handle('fm:prepare', async function (e, rel, id) {
    const name = String(rel || '');
    const key = String(id || '');
    const ctrl = new AbortController();
    if (key) tcCancels.set(key, ctrl);
    try {
      const file = insideRoot(name);
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error('文件不存在');
      const r = await TC.prepare({
        file: file,
        rel: name,
        stat: stat,
        cacheDir: tcDir(),
        signal: ctrl.signal,
        onProgress: function (pct) {
          if (win && !win.isDestroyed()) win.webContents.send('fm:tc', { rel: name, pct: pct });
        }
      });
      return { url: 'fm://app/' + TC_PREFIX + '/' + path.basename(r.file), ext: r.ext, cached: r.cached };
    } catch (err) {
      /* 取消是正常路径（用户切集了），不刷告警 */
      if (err && err.code === 'aborted') return { error: 'aborted' };
      console.warn('[tc] 准备失败 ' + name + '：' + (err && err.message));
      return { error: (err && err.code) || 'ffmpeg-failed', message: (err && err.message) || '转换失败' };
    } finally {
      if (key) tcCancels.delete(key);
    }
  });

  /* 时长探测：只读文件头（ffmpeg -i），不触发转码。转码格式的曲目靠它拿时长 */
  ipcMain.handle('fm:probeDur', async function (e, rel) {
    try {
      return await TC.probeDuration(insideRoot(String(rel || '')));
    } catch (err) { return 0; }
  });

  /* 在文件管理器里定位某一集 */
  ipcMain.handle('fm:reveal', function (e, rel) {
    try { shell.showItemInFolder(insideRoot(String(rel))); } catch (err) {}
  });

  /* 在系统文件管理器里打开某个资源库的目录（方便往里丢新书） */
  ipcMain.handle('fm:openLib', function (e, id) {
    const cfg = getConfig();
    const lib = cfg.libs.find(l => l.id === id);
    if (!lib) return false;
    shell.openPath(lib.path);
    return true;
  });
}

/* ── 菜单 ──
   Windows 上不需要菜单栏；macOS 得留一个，否则 Cmd+Q / Cmd+W / 复制粘贴都没了 */
function setupMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]));
}

/* ── 窗口 ── */
function createWindow() {
  win = new BrowserWindow({
    width: 1340,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#05070e',
    title: '星海 FM',
    autoHideMenuBar: true,
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.loadURL('fm://app/index.html');
  /* 不等 ready-to-show：立刻把纯色窗口亮出来，页面首帧（启动画面）一到就盖在上面。
     打包后 Chromium 起窗要 1-2 秒，空等这段时间屏幕上什么都没有。 */
  win.show();

  win.webContents.setWindowOpenHandler(function () { return { action: 'deny' }; });
  win.webContents.on('will-navigate', function (e, url) {
    if (!url.startsWith('fm://app/')) e.preventDefault();
  });

  if (process.env.FM_DEV) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', function () { win = null; });
}

/* ── 生命周期 ── */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(function () {
    nativeTheme.themeSource = 'dark';
    /* 必须在 createWindow 之前算好：preload 会在窗口创建时同步读它 */
    gpuAccel = resolveFx();
    logGpuInfo();
    setupMenu();
    registerProtocol();
    bindIpc();
    getConfig();          // 老的 { root } 配置在这里就地升级
    syncWatchers();       // 给已开启自动监听的库挂上 chokidar
    /* serve.js 可能也在跑并改过 watch：60 秒对一次账，顺带兜住漏掉的库增删 */
    watchTick = setInterval(syncWatchers, 60000);
    if (watchTick.unref) watchTick.unref();
    createWindow();
    /* 转码依赖系统 ffmpeg：启动时把结果打在控制台，找不到时至少留下排查线索
       （macOS 从 Finder 启动的 app，PATH 往往只有 /usr/bin:/bin） */
    if (!TC.findFfmpeg()) {
      console.warn('[tc] 未找到 ffmpeg：flv 将无法播放');
      console.warn('     安装：macOS「brew install ffmpeg」，或启动前设置 FM_FFMPEG 指向它');
      console.warn(TC.explain());
    }
    /* 转码缓存清理放到启动稳定之后：翻目录不该跟首屏抢 IO */
    setTimeout(function () {
      TC.sweep(tcDir(), TC.DEFAULT_MAX).catch(function () {});
    }, 8000);

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', function () {
    if (watchTick) { clearInterval(watchTick); watchTick = 0; }
    try { libWatcher.stopAll(); } catch (e) {}
  });
}
