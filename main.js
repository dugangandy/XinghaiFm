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

const ROOT = __dirname;
const MEDIA = new Set([
  'm4a', 'm4b', 'mp3', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'ape',
  'mp4', 'm4v', 'mov', 'webm', 'ogv'
]);
const MAX_DEPTH = 3;
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
  const libs = DB.listLibs(db, uid).map(function (l) { return { id: l.id, name: l.name, path: l.path, addedAt: l.addedAt }; });
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
  return { id: l.id, name: l.name, path: l.path, missing: !fs.existsSync(l.path) };
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
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg'
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

/* ── 专辑封面：直接从 .fm-covers 里读，不需要 Range ── */
async function serveCover(name) {
  if (!activeLib() || !name) return new Response('not found', { status: 404 });
  let file;
  try { file = insideRoot(COVER_DIR + '/' + name); } catch (e) { return new Response('forbidden', { status: 403 }); }
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
    if (segs[0] === COVER_PREFIX) return serveCover(segs.slice(1).join('/'));

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

/* ── 扫描 ── */
async function scanFolder(root) {
  const out = [];
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
        let st = null;
        try { st = await fsp.stat(abs); } catch (e) {}
        out.push({
          rel: rel,
          name: entry.name,
          ext: ext,
          size: st ? st.size : 0,
          mtime: st ? st.mtimeMs : 0,
          depth: depth
        });
      }
    }
  }
  await walk(root, '', 1);
  return { rootName: path.basename(root), root: root, files: out };
}

function insideRoot(rel) {
  const lib = activeLib();
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

/* ── IPC ── */
function bindIpc() {
  /* 远程配置：preload 启动时同步取一次，连接/断开后由页面 reload 生效 */
  ipcMain.on('fm:remote', function (e) { e.returnValue = readRemote(); });
  /* 应用版本号：渲染进程在左侧 logo 旁显示 */
  ipcMain.on('fm:version', function (e) { e.returnValue = app.getVersion(); });
  ipcMain.handle('fm:setRemote', function (e, cfg) { return writeRemote(cfg); });

  ipcMain.handle('fm:libs', function () {
    const cfg = getConfig();
    return { active: cfg.active, libs: cfg.libs.map(libView) };
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
    lib.path = res.filePaths[0];
    /* 选目录期间可能有其它 IPC 刷新 lastCfg，必须保存这次修改的配置对象 */
    saveConfig(cfg);
    return libView(lib);
  });

  ipcMain.handle('fm:removeLib', function (e, id) {
    const cfg = getConfig();
    const i = cfg.libs.findIndex(l => l.id === id);
    if (i < 0) return { active: cfg.active };
    cfg.libs.splice(i, 1);
    if (cfg.active === id) cfg.active = cfg.libs[0] ? cfg.libs[0].id : null;
    saveConfig();
    return { active: cfg.active };
  });

  ipcMain.handle('fm:scan', async function () {
    const lib = activeLib();
    if (!lib) throw new Error('尚未选择资源库');
    if (!fs.existsSync(lib.path)) throw new Error('资源库目录不存在：' + lib.name);
    const res = await scanFolder(lib.path);
    res.libId = lib.id;
    /* 有新专辑就在后台去喜马拉雅补封面，扫完先返回，界面不用等 */
    res.coversPending = await covers.pendingOf(lib.path);
    if (res.coversPending) {
      covers.auto(lib.path).then(function (r) {
        if (!r || !r.ok) return;
        if (win && !win.isDestroyed()) win.webContents.send('fm:covers', { libId: lib.id, added: r.ok });
      });
    }
    return res;
  });

  ipcMain.handle('fm:covers', function () {
    const lib = activeLib();
    if (!lib) return null;
    try {
      const raw = fs.readFileSync(path.join(lib.path, COVER_DIR, 'covers.json'), 'utf8');
      return JSON.parse(raw);
    } catch (e) { return null; }
  });

  ipcMain.handle('fm:saveMeta', async function (e, libPath, json) {
    const root = knownLibPath(libPath);
    if (!root) return false;
    const file = path.join(root, META_FILE);
    try {
      const incoming = JSON.parse(String(json || '{}')) || {};
      /* 手机上也在写同一个文件：写前确认这期间没人动过，动过就重来（乐观并发，最多 3 次） */
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
    setupMenu();
    registerProtocol();
    bindIpc();
    getConfig();          // 老的 { root } 配置在这里就地升级
    createWindow();

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
  });
}
