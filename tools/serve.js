#!/usr/bin/env node
/* ── serve.js · 本地/远程用的静态 + 媒体服务器 ───────────────────────
 *
 *   node tools/serve.js --set-password 你的口令      # 首次：写 .auth.json（只存哈希）
 *   node tools/serve.js 8080                        # 只发前端
 *   node tools/serve.js 8080 --config /srv/fm/config.json   # 指定另一份库列表
 *
 * 有 .auth.json 就要先登录：GET /__auth 出表单，POST 校验后种 HMAC 签名的会话
 * cookie。口令不写在 URL 里，auth.json 里只有 pbkdf2 哈希。
 *
 * 服务器模式接口（前端 js/fs.js 检测到 /api/config 会切过去）：
 *   GET  /api/config            { server, rootName, multi }
 *   GET  /api/libs              资源库列表 { active, libs }
 *   GET  /api/activate?id=      切换当前资源库
 *   GET  /api/meta              当前库的 .fm-meta.json（桌面端整理的元数据）
 *   POST /api/progress          手机端回传播放进度，按时间戳合并进 .fm-meta.json
 *   GET  /api/scan              目录列表（和主进程扫描结果同构）
 *   GET  /api/covers            封面索引（.fm-covers/covers.json）
 *   GET  /api/cover/<file>      封面图片
 *   GET  /api/media/<rel>       音频流，支持 Range（拖动进度条）
 *
 * 资源库来源：config.json 的 libs 数组（--config 可指定另一份）
 * （--config 可指定路径，默认 %APPDATA%\星海FM\config.json）。
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const APP_ROOT = path.resolve(__dirname, '..');
const COVER_DIR = '.fm-covers';
/* 口令文件可重定向（测试/多实例用），默认项目根目录 */
const AUTH_FILE = process.env.FM_AUTH_FILE ? path.resolve(process.env.FM_AUTH_FILE) : path.join(APP_ROOT, '.auth.json');
const MEDIA_EXT = new Set([
  'm4a', 'm4b', 'mp3', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'ape',
  'mp4', 'm4v', 'mov', 'webm', 'ogv'
]);
const MAX_DEPTH = 3;
const META_FILE = '.fm-meta.json';
const SKIP_DIR = /^[._]|^(fm|dist|build|node_modules|[$]RECYCLE[.]BIN|System Volume Information)$/i;
const SESSION_COOKIE = 'fm_sess';
const SESSION_IDLE = 7 * 24 * 3600;   // 多久不用就失效（滑动）
const SESSION_ABS = 30 * 24 * 3600;   // 从首次登录算起的硬上限
const REISSUE_AFTER = 6 * 3600;       // 活跃时最快 6h 重签一次 cookie
const ITERATIONS = 600000;            // 新口令的 pbkdf2 轮数

let port = 8080;
let host = '127.0.0.1';
let CONFIG_FILE = '';
let ALLOW_LIB_EDIT = false;   // 是否允许远程增删资源库（默认关，显式 --allow-lib-edit 才开）
let SET_PASSWORD = null;
let NO_AUTH = false;
let CHECK_PASSWORD = false;
(function parse() {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--config') CONFIG_FILE = path.resolve(a[++i] || '');
    else if (a[i] === '--allow-lib-edit') ALLOW_LIB_EDIT = true;
    else if (a[i] === '--host') host = a[++i] || host;
    else if (a[i] === '--set-password') SET_PASSWORD = a[++i] || '';
    else if (a[i] === '--no-auth') NO_AUTH = true;
    else if (a[i] === '--check-password') CHECK_PASSWORD = true;
    else if (/^[0-9]+$/.test(a[i])) port = Number(a[i]);
  }
})();

/* ── 资源库 ─────────────────────────────────────────────
 * 读 config.json（默认桌面端的，可用 --config 指定），拿到库列表；
 * 读不到或 libs 为空 → 没有库，前端退回「自己选目录」模式
 */
let LIBS = [];            // [{ id, name, path }]
let activeId = null;
let MULTI = false;        // true = 跟着桌面端配置，前端可以切库

function desktopConfigPath() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '星海FM', 'config.json');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', '星海FM', 'config.json');
  return path.join(home, '.config', '星海FM', 'config.json');
}

let libsWarned = false;

/* keepActive：热加载时尽量保留当前选中的库（远程那边可能正看着别的库）
   返回 false = 这次没读成（文件不存在或正好被写了一半），调用方要保留原状、下轮再试 */
function loadLibs(keepActive) {
  const prev = keepActive ? activeId : null;
  const file = CONFIG_FILE || desktopConfigPath();
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  if (!cfg || !Array.isArray(cfg.libs)) {
    /* 读不到 / 解析失败：保持现有列表，别因为一次半截写入就把库全清空 */
    if (!libsWarned) { console.log('[libs] 暂时读不到桌面端配置，稍后重试：' + file); libsWarned = true; }
    return false;
  }
  libsWarned = false;
  if (!cfg.libs.length) {
    /* 文件是完整的，只是确实一个库都没有 */
    LIBS = [];
    activeId = null;
    MULTI = true;
    CONFIG_FILE = file;
    return true;
  }
  LIBS = cfg.libs
    .filter(l => l && typeof l.path === 'string' && l.path)
    .map(l => ({ id: l.id || l.path, name: l.name || path.basename(l.path), path: l.path }));
  const cfgActive = LIBS.some(l => l.id === cfg.active) ? cfg.active : (LIBS[0] ? LIBS[0].id : null);
  activeId = (prev && LIBS.some(l => l.id === prev)) ? prev : cfgActive;
  MULTI = true;
  CONFIG_FILE = file;
  return true;
}
loadLibs();

/* 桌面端随时可能增删资源库：按 config.json 的 mtime 热加载，最多每秒查一次 */
let cfgStamp = -1;
let cfgCheckedAt = 0;
function syncLibs() {
  const now = Date.now();
  if (now - cfgCheckedAt < 1000) return;
  cfgCheckedAt = now;
  const file = CONFIG_FILE || desktopConfigPath();
  let st = null;
  try { st = fs.statSync(file); } catch (e) { return; }
  if (st.mtimeMs === cfgStamp) return;
  /* 只有真的加载成功才记下这个 mtime，失败的话下一秒再试 */
  if (loadLibs(true)) cfgStamp = st.mtimeMs;
}

function activeLib() { return LIBS.find(l => l.id === activeId) || null; }
function activeRoot() { const l = activeLib(); return l ? l.path : ''; }
/* fixed = 前端不给改（单目录模式，或者没开 --allow-lib-edit） */
function libView(l) { return { id: l.id, name: l.name, missing: !fs.existsSync(l.path), fixed: !MULTI || !ALLOW_LIB_EDIT }; }

/* ── 元数据文件（桌面端写、这里读；进度双向） ── */
async function readMeta(root) {
  if (!root) return null;
  try { return JSON.parse(await fsp.readFile(path.join(root, META_FILE), 'utf8')) || {}; } catch (e) { return null; }
}
async function writeMeta(root, data) {
  const file = path.join(root, META_FILE);
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

const MAX_PROGRESS = 5000;

function statOrNull(file) {
  try { return fs.statSync(file); } catch (e) { return null; }
}
function stampOf(st) { return st ? st.mtimeMs + ':' + st.size : '0'; }

/* 进度条数兜底：异常 id 刷进来时丢最老的，别让文件无限长 */
function capProgress(prog) {
  const keys = Object.keys(prog);
  if (keys.length <= MAX_PROGRESS) return;
  keys.sort((a, b) => (Number(prog[a] && prog[a].t) || 0) - (Number(prog[b] && prog[b].t) || 0));
  for (let i = 0; i < keys.length - MAX_PROGRESS; i++) delete prog[keys[i]];
}

/* 手机推上来的一条进度：按时间戳合并，文件里更新的记录不会被覆盖 */
async function mergeProgress(lib, rec) {
  if (!lib) return false;
  const file = path.join(lib.path, META_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    /* 桌面端也在写这个文件：写前确认期间没人动过，动过就重来（乐观并发） */
    const before = statOrNull(file);
    const meta = (await readMeta(lib.path)) || {};
    meta.progress = meta.progress || {};
    const old = meta.progress[rec.id];
    if (!old || (Number(rec.t) || 0) >= (Number(old.t) || 0)) {
      meta.progress[rec.id] = { p: rec.p, d: rec.d, t: rec.t };
      if (rec.done) meta.progress[rec.id].done = true;
    }
    capProgress(meta.progress);
    meta.updatedAt = Date.now();
    const after = statOrNull(file);
    if (stampOf(before) !== stampOf(after) && attempt < 2) continue;
    await writeMeta(lib.path, meta);
    return true;
  }
  return false;
}

/* ── 改资源库（加 / 改名 / 移除）：直接改桌面端的 config.json ──
 * 服务跑在自己机器上，浏览器那边没法弹系统目录框，所以「添加」用路径输入。
 * 文件先写 .tmp 再 rename，桌面进程按 mtime 变化会重新读，不会互相覆盖。 */
function configPath() { return CONFIG_FILE || desktopConfigPath(); }

function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')) || null; } catch (e) { return null; }
}

function writeConfigFile(cfg) {
  const file = configPath();
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
}

function newLibId() { return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function mutateLibs(body) {
  const cfg = readConfigFile();
  if (!cfg || !Array.isArray(cfg.libs)) return { code: 400, msg: '读不到桌面端配置：' + configPath() };
  const act = String(body.action || '');

  if (act === 'add') {
    const raw = String(body.path || '').trim();
    if (!raw) return { code: 400, msg: '缺少目录路径' };
    const abs = path.resolve(raw);
    /* 挡一下「把整个盘加成资源库」这种最糟的用法 */
    if (path.parse(abs).root === abs) return { code: 400, msg: '不能直接添加磁盘根目录，请选具体文件夹' };
    let st = null;
    try { st = fs.statSync(abs); } catch (e) {}
    if (!st || !st.isDirectory()) return { code: 400, msg: '目录不存在：' + raw };
    const key = abs.toLowerCase();
    let lib = cfg.libs.find(l => path.resolve(l.path).toLowerCase() === key);
    if (!lib) {
      lib = { id: newLibId(), name: String(body.name || '').trim() || path.basename(abs) || '资源库', path: abs, addedAt: Date.now() };
      cfg.libs.push(lib);
      console.log('[lib] 远程添加资源库：' + lib.name + ' → ' + abs);
    }
    cfg.active = lib.id;
    writeConfigFile(cfg);
    return { code: 200 };
  }

  const id = String(body.id || '');
  const lib = cfg.libs.find(l => l.id === id);
  if (!lib) return { code: 400, msg: '资源库不存在' };

  if (act === 'rename') {
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return { code: 400, msg: '名称不能为空' };
    lib.name = name;
  } else if (act === 'remove') {
    cfg.libs = cfg.libs.filter(l => l.id !== id);
    if (cfg.active === id) cfg.active = cfg.libs[0] ? cfg.libs[0].id : null;
    console.log('[lib] 远程移除资源库：' + lib.name);
  } else {
    return { code: 400, msg: 'unknown action' };
  }
  writeConfigFile(cfg);
  return { code: 200 };
}

/* 写接口限流：同一 IP 每秒最多 5 次 */
const writeHits = new Map();
function writeAllowed(ip) {
  const now = Date.now();
  const rec = writeHits.get(ip) || { n: 0, since: now };
  if (now - rec.since > 1000) { rec.n = 0; rec.since = now; }
  rec.n++;
  writeHits.set(ip, rec);
  if (writeHits.size > 256) writeHits.clear();
  return rec.n <= 5;
}

/* ── 口令与会话 ── */
function loadAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch (e) { return null; }
}
function derive(password, saltB64, iterations) {
  return crypto.pbkdf2Sync(String(password), Buffer.from(saltB64, 'base64'), iterations, 32, 'sha256');
}
function saveAuth(password, iterations) {
  const rounds = iterations || ITERATIONS;
  const salt = crypto.randomBytes(16).toString('base64');
  const data = {
    version: 1,
    algo: 'pbkdf2_sha256',
    iterations: rounds,
    salt: salt,
    hash: derive(password, salt, rounds).toString('base64'),
    secret: crypto.randomBytes(32).toString('base64'),
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}
function verifyPassword(password) {
  const a = loadAuth();
  if (!a) return false;
  const got = derive(password, a.salt, a.iterations);
  const want = Buffer.from(a.hash, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
/* 登录成功后，如果旧文件轮数偏低，用同一个口令重算一份（会换 secret，其他设备需重登） */
function upgradeHash(password) {
  const a = loadAuth();
  if (a && a.iterations < ITERATIONS) saveAuth(password, ITERATIONS);
}
function sign(payload, secret) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(payload).digest('base64url');
}
/* token = iat.abs.sig，iat 随活跃滑动，abs 是硬上限 */
function makeToken(iat, abs) {
  const payload = iat + '.' + abs;
  return payload + '.' + sign(payload, loadAuth().secret);
}
function readSession(token) {
  const a = loadAuth();
  if (!a || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const iat = parseInt(parts[0], 10);
  const abs = parseInt(parts[1], 10);
  if (!(iat > 0) || !(abs > 0)) return null;
  const want = Buffer.from(sign(iat + '.' + abs, a.secret));
  const got = Buffer.from(parts[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now > abs) return null;
  if (now - iat > SESSION_IDLE) return null;
  return { iat: iat, abs: abs };
}
/* 短期票据：给 <audio>/<img> 这种带不了 Authorization 头的标签用。
   桌面端走 Bearer 的长期 token 不进 URL，URL 里只放这个 2 小时就过期的票。 */
const TICKET_TTL = 2 * 3600;
function makeTicket() {
  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL;
  return 't.' + exp + '.' + sign('t.' + exp, loadAuth().secret);
}
function readTicket(t) {
  const a = loadAuth();
  if (!a || !t) return false;
  const parts = String(t).split('.');
  if (parts.length !== 3 || parts[0] !== 't') return false;
  const exp = parseInt(parts[1], 10);
  if (!(exp > 0)) return false;
  const want = Buffer.from(sign('t.' + exp, a.secret));
  const got = Buffer.from(parts[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
  return Math.floor(Date.now() / 1000) <= exp;
}
function bearerOf(req) {
  const h = req.headers.authorization || '';
  return h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : '';
}

function sessionCookie(value) {
  return SESSION_COOKIE + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_IDLE;
}

/* 同一 IP 10 分钟内错 5 次，锁 10 分钟 */
const fails = new Map();
function lockedFor(ip) {
  const rec = fails.get(ip);
  if (!rec) return 0;
  const left = rec.until - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}
function noteFail(ip) {
  const now = Date.now();
  const rec = fails.get(ip) || { count: 0, since: now, until: 0 };
  if (now - rec.since > 600000) { rec.count = 0; rec.since = now; }
  rec.count++;
  if (rec.count >= 5) { rec.until = now + 600000; rec.count = 0; rec.since = now; }
  fails.set(ip, rec);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
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

/* gzip：只压文本类，压过的结果按内容哈希缓存，重复请求不再压一遍 */
const gzCache = new Map();
const reqOf = new WeakMap();

function wantsGzip(req) {
  return !!req && /gzip/.test(String(req.headers['accept-encoding'] || ''));
}
function gzipOf(buf) {
  const key = crypto.createHash('sha1').update(buf).digest('base64');
  const hit = gzCache.get(key);
  if (hit) return hit;
  const out = zlib.gzipSync(buf, { level: 9 });
  if (gzCache.size > 48) gzCache.delete(gzCache.keys().next().value);
  gzCache.set(key, out);
  return out;
}

function send(res, code, body, headers) {
  const h = Object.assign({ 'cache-control': 'no-store' }, headers || {});
  const type = String(h['content-type'] || '');
  const buf = Buffer.isBuffer(body) ? body : (typeof body === 'string' ? Buffer.from(body) : null);
  const canZip = buf && buf.length > 1024 && !h['content-encoding'] &&
    /text|json|javascript|css|svg/.test(type) && wantsGzip(reqOf.get(res));
  if (canZip) {
    const out = gzipOf(buf);
    h['content-encoding'] = 'gzip';
    h['vary'] = 'Accept-Encoding';
    h['content-length'] = String(out.length);
    res.writeHead(code, h);
    return res.end(out);
  }
  if (buf && h['content-length'] == null) h['content-length'] = String(buf.length);
  res.writeHead(code, h);
  res.end(body);
}
function json(res, obj) {
  send(res, 200, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });
}
function inside(base, rel) {
  const p = path.normalize(path.join(base, rel));
  if (!p.startsWith(path.normalize(base + path.sep))) throw new Error('越界');
  return p;
}
function cookieOf(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map(function (s) { return s.trim(); }).find(function (s) { return s.indexOf(name + '=') === 0; });
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}

function loginPage(err, next) {
  const style = 'body{background:#05070e;color:#e9eefb;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;display:grid;place-items:center;height:100vh;margin:0}' +
    'form{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);padding:28px 26px;border-radius:16px;width:300px}' +
    'h1{font-size:16px;margin:0 0 18px;font-weight:650}' +
    'input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.35);color:#e9eefb;font-size:14px;outline:none}' +
    'input:focus{border-color:#22d3ee}' +
    'button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:10px;background:linear-gradient(120deg,#22d3ee,#6366f1);color:#04070d;font-weight:700;cursor:pointer}' +
    'p.err{color:#fca5a5;font-size:12px;margin:0 0 12px}';
  return '<!doctype html><meta charset="utf-8"><title>星海 FM</title><style>' + style + '</style>' +
    '<form method="post" action="/__auth">' +
      '<h1>星海 FM</h1>' +
      (err ? '<p class="err">' + err + '</p>' : '') +
      '<input type="hidden" name="next" value="' + (next || '/') + '">' +
      '<input type="password" name="pw" placeholder="访问口令" autofocus autocomplete="current-password">' +
      '<button type="submit">进入媒体库</button>' +
    '</form>';
}

async function scanFolder(root) {
  const out = [];
  async function walk(dir, prefix, depth) {
    let list;
    try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of list) {
      if (SKIP_DIR.test(ent.name)) continue;
      const rel = prefix ? prefix + '/' + ent.name : ent.name;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(abs, rel, depth + 1);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).slice(1).toLowerCase();
        if (!MEDIA_EXT.has(ext)) continue;
        let st = null;
        try { st = await fsp.stat(abs); } catch (e) {}
        out.push({ rel: rel, name: ent.name, ext: ext, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0, depth: depth });
      }
    }
  }
  await walk(root, '', 1);
  return { rootName: path.basename(root), root: root, files: out };
}

function parseRange(header, size) {
  const m = /^bytes=([0-9]*)-([0-9]*)$/.exec(String(header || '').trim());
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
  if (start >= size || start > end) return 'bad';
  return { start: start, end: end };
}

async function serveMedia(req, res, rel) {
  /* 只放媒体文件：这个接口能顺着资源库根目录读任意路径，
     不挡扩展名就等于「登录后可以读整台机器的任意文件」（config.json、id_rsa……） */
  const ext = path.extname(rel).slice(1).toLowerCase();
  if (!MEDIA_EXT.has(ext)) return send(res, 404, 'not found');

  let file;
  try { file = inside(activeRoot(), rel); } catch (e) { return send(res, 403, 'forbidden'); }
  let st;
  try { st = await fsp.stat(file); } catch (e) { return send(res, 404, 'not found'); }
  if (!st.isFile()) return send(res, 404, 'not found');

  const head = {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store'
  };
  const range = parseRange(req.headers.range, st.size);
  if (range === 'bad') return send(res, 416, null, Object.assign({}, head, { 'content-range': 'bytes */' + st.size }));
  if (!range) {
    res.writeHead(200, Object.assign({}, head, { 'content-length': st.size }));
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(206, Object.assign({}, head, {
    'content-length': range.end - range.start + 1,
    'content-range': 'bytes ' + range.start + '-' + range.end + '/' + st.size
  }));
  fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
}

/* ── 一次性：设置 / 校验口令 ── */
/* 管道和交互都能用：行先到就先缓存，问到的时候再取 */
const stdinLines = [];
const stdinWaiters = [];
const stdinRL = require("node:readline").createInterface({ input: process.stdin, output: process.stdout });
stdinRL.on("line", function (line) {
  const w = stdinWaiters.shift();
  if (w) w(line); else stdinLines.push(line);
});
function ask(question) {
  process.stdout.write(question);
  if (stdinLines.length) return Promise.resolve(stdinLines.shift());
  return new Promise(function (resolve) { stdinWaiters.push(resolve); });
}
if (SET_PASSWORD !== null || CHECK_PASSWORD) {
  (async function () {
    if (CHECK_PASSWORD) {
      const pw = await ask('输入要校验的口令：');
      const ok = verifyPassword(pw);
      console.log(ok ? '✓ 口令正确' : '✗ 口令不正确');
      process.exit(ok ? 0 : 1);
    }
    let pw = SET_PASSWORD;
    /* 不带参数时交互输入：cmd 会吃掉 % & ^ ! 这类字符，用命令行传很容易悄悄变样 */
    if (!pw) {
      pw = await ask('设置新口令（会显示在屏幕上）：');
      const again = await ask('再输入一次确认：');
      if (pw !== again) { console.error('两次输入不一致，未修改'); process.exit(1); }
    }
    if (!pw) { console.error('口令不能为空'); process.exit(1); }
    saveAuth(pw);
    const ok = verifyPassword(pw);          /* 立刻回读校验，确保存进去的就是刚才输入的那串 */
    console.log(ok ? '✓ 已设置并校验通过：' + AUTH_FILE + '（pbkdf2 ' + ITERATIONS + ' 轮）' : '✗ 写入后校验失败，请重试');
    process.exit(ok ? 0 : 1);
  })();
  return;                     // 命令行模式下不要继续起服务
}
if (!loadAuth()) {
  console.error([
    '还没有设置访问口令：',
    '  node tools/serve.js --set-password',
    '',
    '（口令只存哈希在 .auth.json，不放在 URL 里）'
  ].join(String.fromCharCode(10)));
  process.exit(1);
}

const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  reqOf.set(res, req);

  /* 桌面端从 fm://app 跨源访问：不带 cookie（靠 Bearer），预检直接放行 */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  /* 桌面端登录：口令换长期 token（和 cookie 会话同一套 HMAC 签名） */
  if (p === '/api/login' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let pw = '';
    try { pw = JSON.parse(body || '{}').password || ''; } catch (e) {}
    const lock = lockedFor(ip);
    if (lock) return send(res, 429, '尝试过多，请 ' + lock + ' 秒后再试');
    if (NO_AUTH) return json(res, { token: '' });
    if (!verifyPassword(pw)) { noteFail(ip); return send(res, 401, '口令不正确'); }
    fails.delete(ip);
    upgradeHash(pw);
    const nowSec = Math.floor(Date.now() / 1000);
    return json(res, { token: makeToken(nowSec, nowSec + SESSION_ABS) });
  }

  if (!NO_AUTH && p === '/__auth') {
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const pw = form.get('pw') || '';
      const next = form.get('next') || '/';
      const lock = lockedFor(ip);
      if (lock) return send(res, 429, loginPage('尝试过多，请 ' + lock + ' 秒后再试', next), { 'content-type': 'text/html; charset=utf-8' });
      if (!verifyPassword(pw)) {
        noteFail(ip);
        return send(res, 401, loginPage('口令不正确', next), { 'content-type': 'text/html; charset=utf-8' });
      }
      fails.delete(ip);
      upgradeHash(pw);
      const nowSec = Math.floor(Date.now() / 1000);
      res.writeHead(302, {
        'set-cookie': sessionCookie(makeToken(nowSec, nowSec + SESSION_ABS)),
        'location': next.indexOf('/') === 0 ? next : '/'
      });
      return res.end();
    }
    return send(res, 200, loginPage('', u.searchParams.get('next') || '/'), { 'content-type': 'text/html; charset=utf-8' });
  }
  if (!NO_AUTH && p === '/__auth/logout') {
    res.writeHead(302, { 'set-cookie': SESSION_COOKIE + '=; Path=/; Max-Age=0', 'location': '/__auth' });
    return res.end();
  }

  /* 会话来源：浏览器 cookie，或桌面端的 Authorization: Bearer */
  const sess = NO_AUTH ? null
    : (readSession(cookieOf(req, SESSION_COOKIE)) || readSession(bearerOf(req)));
  /* 媒体/封面走 ?t= 短期票据（<audio>/<img> 没法带请求头） */
  const ticketOk = !NO_AUTH && !sess &&
    (p.indexOf('/api/media/') === 0 || p.indexOf('/api/cover/') === 0) &&
    readTicket(u.searchParams.get('t'));
  if (!NO_AUTH && !sess && !ticketOk) {
    if (p.indexOf('/api/') === 0) return send(res, 401, 'unauthorized');
    res.writeHead(302, { 'location': '/__auth?next=' + encodeURIComponent(req.url || '/') });
    return res.end();
  }
  /* 滑动续期：活跃就往后推，但不超过首次登录算起的硬上限 */
  if (sess) {
    const tick = Math.floor(Date.now() / 1000);
    if (tick - sess.iat > REISSUE_AFTER) {
      res.setHeader('set-cookie', sessionCookie(makeToken(tick, sess.abs)));
    }
  }

  /* 每个 API 请求都瞄一眼配置有没有变（内部限流，1 秒最多 stat 一次） */
  syncLibs();

  if (p === '/api/ticket') {
    return json(res, NO_AUTH ? { t: '', exp: 0 } : { t: makeTicket(), exp: Math.floor(Date.now() / 1000) + TICKET_TTL });
  }
  if (p === '/api/config') {
    const lib = activeLib();
    return json(res, { server: LIBS.length > 0, rootName: lib ? lib.name : '', multi: MULTI, libEdit: ALLOW_LIB_EDIT });
  }
  if (p === '/api/libs') {
    return json(res, { active: activeId, multi: MULTI, libs: LIBS.map(libView) });
  }
  if (p === '/api/activate') {
    const id = u.searchParams.get('id') || '';
    if (!LIBS.some(l => l.id === id)) return send(res, 400, 'unknown lib');
    activeId = id;
    return json(res, { active: activeId, libs: LIBS.map(libView) });
  }
  if (p === '/api/meta') {
    const meta = await readMeta(activeRoot());
    return json(res, meta || { empty: true });
  }
  if (p === '/api/progress') {
    if (req.method !== 'POST') return send(res, 405, 'POST only');
    if (!writeAllowed(ip)) return send(res, 429, 'too many writes');
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4096) return send(res, 413, 'too large');
    }
    let rec = null;
    try { rec = JSON.parse(body); } catch (e) { return send(res, 400, 'bad json'); }
    if (!rec || !rec.id) return send(res, 400, 'missing id');
    const lib = LIBS.find(l => l.id === rec.libId) || activeLib();
    const p2 = Number(rec.p), d2 = Number(rec.d);
    if (!isFinite(p2) || p2 < 0) return send(res, 400, 'bad progress');
    try {
      await mergeProgress(lib, {
        id: String(rec.id),
        p: Math.round(p2 * 100) / 100,
        d: isFinite(d2) && d2 > 0 ? Math.round(d2 * 100) / 100 : 0,
        t: Number(rec.t) || Date.now(),
        done: !!rec.done
      });
      return json(res, { ok: true });
    } catch (e) { return send(res, 500, e.message); }
  }
  if (p === '/api/lib') {
    if (req.method !== 'POST') return send(res, 405, 'POST only');
    if (!ALLOW_LIB_EDIT) return send(res, 403, '服务端未开启资源库编辑（启动时加 --allow-lib-edit）');
    if (!writeAllowed(ip)) return send(res, 429, 'too many writes');
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) return send(res, 413, 'too large');
    }
    let payload = null;
    try { payload = JSON.parse(body); } catch (e) { return send(res, 400, 'bad json'); }
    const r = mutateLibs(payload || {});
    if (r.code !== 200) return send(res, r.code, r.msg);
    loadLibs();
    return json(res, { active: activeId, multi: MULTI, libs: LIBS.map(libView) });
  }
  if (p === '/api/scan') {
    if (!activeRoot()) return send(res, 404, 'server mode off');
    try {
      const data = await scanFolder(activeRoot());
      data.libId = activeId;
      return json(res, data);
    } catch (e) { return send(res, 500, e.message); }
  }
  if (p === '/api/covers') {
    if (!activeRoot()) return send(res, 404, 'server mode off');
    try { return json(res, JSON.parse(await fsp.readFile(path.join(activeRoot(), COVER_DIR, 'covers.json'), 'utf8'))); }
    catch (e) { return json(res, {}); }
  }
  if (p.indexOf('/api/cover/') === 0) {
    if (!activeRoot()) return send(res, 404, 'server mode off');
    try {
      const file = inside(path.join(activeRoot(), COVER_DIR), p.slice('/api/cover/'.length));
      const buf = await fsp.readFile(file);
      return send(res, 200, buf, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'image/jpeg', 'cache-control': 'max-age=86400' });
    } catch (e) { return send(res, 404, 'not found'); }
  }
  if (p.indexOf('/api/media/') === 0) {
    if (!activeRoot()) return send(res, 404, 'server mode off');
    return serveMedia(req, res, p.slice('/api/media/'.length));
  }

  const rel = p === '/' ? 'index.html' : p.replace(/^[/]+/, '');
  if (!/^(index[.]html|css[/]|js[/]|build[/])/.test(rel)) return send(res, 404, 'not found');
  let file;
  try { file = inside(APP_ROOT, rel); } catch (e) { return send(res, 403, 'forbidden'); }
  try {
    const st = await fsp.stat(file);
    /* 内容没变就别重发：ETag 用 size+mtime，比每次算哈希便宜；no-cache 让浏览器每次回来问一句 */
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
    const inm = String(req.headers['if-none-match'] || '');
    if (inm && (inm === etag || inm === '*')) {
      res.writeHead(304, { 'etag': etag, 'cache-control': 'no-cache' });
      return res.end();
    }
    const buf = await fsp.readFile(file);
    return send(res, 200, buf, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'etag': etag,
      'cache-control': 'no-cache',
      'content-length': String(buf.length)
    });
  } catch (e) {
    return send(res, 404, 'not found: ' + rel);
  }
});

server.on('error', function (e) {
  if (e.code === 'EADDRINUSE') console.error('端口 ' + port + ' 已被占用，换一个：--port 8081');
  else console.error('启动失败: ' + e.message);
  process.exit(1);
});

server.listen(port, host, function () {
  console.log('星海 FM · http://' + host + ':' + port + '/');
  if (MULTI) {
    console.log('资源库 · 跟随桌面端配置，共 ' + LIBS.length + ' 个');
    LIBS.forEach(function (l) {
      const shown = String(l.path).replace(/\\/g, '/');
      console.log('  ' + (l.id === activeId ? '●' : '○') + ' ' + l.name + '  ' + shown + (fs.existsSync(l.path) ? '' : '  (目录不存在)'));
    });
  }
});
