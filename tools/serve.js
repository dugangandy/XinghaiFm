#!/usr/bin/env node
/* ── serve.js · 本地/远程用的静态 + 媒体服务器 ───────────────────────
 *
 *   node tools/init-db.js                           # 首次：初始化数据库（迁移旧配置 / 生成 admin）
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
'use strict';
/* 静音 node:sqlite 的 ExperimentalWarning（必须在 require 之前挂上） */
(function () {
  const orig = process.emitWarning;
  process.emitWarning = function (w, t) {
    const ty = typeof t === 'string' ? t : (t && t.type);
    if (ty === 'ExperimentalWarning' || /SQLite/i.test(String(w))) return;
    return orig.apply(process, arguments);
  };
})();

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const APP_ROOT = path.resolve(__dirname, '..');
const covers = require('../cover-fetch');
/* 版本号：打包前已把 package.json 的 version 自增，这里读出来给远程页面显示 */
const APP_VERSION = (function () {
  try { return String(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || ''); }
  catch (e) { return ''; }
})();
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
let CONFIG_FILE = '';         // 旧 config.json 路径（仅作迁移来源）
let ALLOW_LIB_EDIT = false;   // 是否允许远程增删资源库（默认关，显式 --allow-lib-edit 才开）
let NO_AUTH = false;
let CLI = null;               // 一次性用户管理命令：{ action, name, pw }
(function parse() {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === '--config') CONFIG_FILE = path.resolve(a[++i] || '');
    else if (x === '--allow-lib-edit') ALLOW_LIB_EDIT = true;
    else if (x === '--host') host = a[++i] || host;
    else if (x === '--no-auth') NO_AUTH = true;
    else if (x === '--add-user') { CLI = { action: 'add', name: a[++i] || '', pw: '' }; if (a[i + 1] && a[i + 1][0] !== '-') CLI.pw = a[++i]; }
    else if (x === '--set-password') { CLI = { action: 'setpw', name: a[++i] || '', pw: '' }; if (a[i + 1] && a[i + 1][0] !== '-') CLI.pw = a[++i]; }
    else if (x === '--check-password') { CLI = { action: 'check', name: a[++i] || '', pw: '' }; if (a[i + 1] && a[i + 1][0] !== '-') CLI.pw = a[++i]; }
    else if (x === '--list-users') { CLI = { action: 'list', name: '', pw: '' }; }
    else if (x === '--remove-user') { CLI = { action: 'remove', name: a[++i] || '', pw: '' }; }
    else if (/^[0-9]+$/.test(x)) port = Number(x);
  }
})();

/* ── 资源库 ─────────────────────────────────────────────
 * 读 config.json（默认桌面端的，可用 --config 指定），拿到库列表；
 * 读不到或 libs 为空 → 没有库，前端退回「自己选目录」模式
 */
/* ── 数据库：users / libs / remote / settings ── */
const DB = require('../db');

function desktopDataDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '星海FM');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', '星海FM');
  return path.join(home, '.config', '星海FM');
}
function desktopConfigPath() { return path.join(desktopDataDir(), 'config.json'); }

function dataFilePath() {
  if (process.env.FM_DATA_FILE) return path.resolve(process.env.FM_DATA_FILE);
  return path.join(desktopDataDir(), 'fm.db');
}
const db = DB.open(dataFilePath());
DB.ensureSchema(db);

/* 首次运行：用户表为空但存在旧文件 → 自动迁移，升级无感 */
(function autoMigrate() {
  if (DB.countUsers(db) > 0) return;
  const legacyCfg = CONFIG_FILE || desktopConfigPath();
  const summary = DB.migrate(db, {
    authFile: AUTH_FILE,
    configFile: legacyCfg,
    remoteFile: path.join(path.dirname(legacyCfg), 'remote.json')
  });
  if (summary.user) console.log('[db] 已迁移旧配置：用户 ' + summary.user + '，资源库 ' + summary.libs + ' 个');
})();

const MULTI = true;   // 每个用户都可以有多个资源库

function userLibs(uid) { return DB.listLibs(db, uid); }
function userActiveLib(uid) { return DB.activeLib(db, uid); }
function userActiveRoot(uid) { const l = userActiveLib(uid); return l ? l.path : ''; }
/* fixed = 前端不给改（没开 --allow-lib-edit） */
function libView(l) { return { id: l.id, name: l.name, missing: !fs.existsSync(l.path), fixed: !ALLOW_LIB_EDIT }; }

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

/* ── 改资源库（加 / 改名 / 移除）：改数据库里该用户的库列表 ──
 * 服务跑在自己机器上，浏览器那边没法弹系统目录框，所以「添加」用路径输入。 */
function newLibId() { return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function mutateLibs(uid, body) {
  const libs = DB.listLibs(db, uid).map(function (l) { return { id: l.id, name: l.name, path: l.path, addedAt: l.addedAt }; });
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
    let lib = libs.find(l => path.resolve(l.path).toLowerCase() === key);
    if (!lib) {
      lib = { id: newLibId(), name: String(body.name || '').trim() || path.basename(abs) || '资源库', path: abs, addedAt: Date.now() };
      libs.push(lib);
      console.log('[lib] 远程添加资源库：' + lib.name + ' → ' + abs);
    }
    DB.replaceLibs(db, uid, libs, lib.id);
    return { code: 200 };
  }

  const id = String(body.id || '');
  const lib = libs.find(l => l.id === id);
  if (!lib) return { code: 400, msg: '资源库不存在' };
  const cur = DB.activeLib(db, uid);
  let active = cur ? cur.id : null;

  if (act === 'rename') {
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return { code: 400, msg: '名称不能为空' };
    lib.name = name;
  } else if (act === 'remove') {
    libs.splice(libs.findIndex(l => l.id === id), 1);
    if (active === id) active = libs[0] ? libs[0].id : null;
    console.log('[lib] 远程移除资源库：' + lib.name);
  } else {
    return { code: 400, msg: 'unknown action' };
  }
  DB.replaceLibs(db, uid, libs, active);
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

/* ── 用户与会话（多用户，token 带 uid） ── */
function verifyPassword(username, password) {
  const u = DB.findUser(db, username);
  return !!u && DB.checkPassword(u, password);
}
/* 登录成功后，如果旧轮数偏低，用同一口令重算（换 salt/hash，不动 secret） */
function upgradeHash(user, password) {
  if (user && user.iterations < ITERATIONS) DB.setUserPassword(db, user.id, password);
}
function sign(payload, secret) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(payload).digest('base64url');
}
/* token = iat.abs.uid.ver.sig，iat 随活跃滑动，abs 是硬上限，ver 是用户 token 版本 */
function makeToken(iat, abs, uid, ver) {
  const payload = iat + '.' + abs + '.' + uid + '.' + (Number(ver) || 0);
  return payload + '.' + sign(payload, DB.secret(db));
}
function readSession(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 5) return null;
  const iat = parseInt(parts[0], 10);
  const abs = parseInt(parts[1], 10);
  const uid = parts[2];
  const ver = parseInt(parts[3], 10);
  if (!(iat > 0) || !(abs > 0) || !uid || !(ver >= 0)) return null;
  const want = Buffer.from(sign(iat + '.' + abs + '.' + uid + '.' + ver, DB.secret(db)));
  const got = Buffer.from(parts[4]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now > abs) return null;
  if (now - iat > SESSION_IDLE) return null;
  const u = DB.getUser(db, uid);
  if (!u) return null;
  /* 改过密码（token_version 变了）→ 旧 token 作废 */
  if ((Number(u.token_version) || 0) !== ver) return null;
  return { iat: iat, abs: abs, uid: uid, ver: ver, username: u.username, role: u.role };
}
/* 短期票据：带 uid，只能读该用户自己的库（<audio>/<img> 带不了请求头） */
const TICKET_TTL = 2 * 3600;
function makeTicket(uid) {
  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL;
  const payload = 't.' + exp + '.' + uid;
  return payload + '.' + sign(payload, DB.secret(db));
}
function readTicket(t) {
  if (!t) return null;
  const parts = String(t).split('.');
  if (parts.length !== 4 || parts[0] !== 't') return null;
  const exp = parseInt(parts[1], 10);
  const uid = parts[2];
  if (!(exp > 0) || !uid) return null;
  const want = Buffer.from(sign('t.' + exp + '.' + uid, DB.secret(db)));
  const got = Buffer.from(parts[3]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  if (Math.floor(Date.now() / 1000) > exp) return null;
  if (!DB.getUser(db, uid)) return null;
  return { uid: uid, exp: exp };
}
function bearerOf(req) {
  const h = req.headers.authorization || '';
  return h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : '';
}

function sessionCookie(value) {
  return SESSION_COOKIE + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_IDLE;
}
/* 非 HttpOnly：前端据此把 localStorage 按用户隔离（同一浏览器多人不串数据） */
function uidCookie(uid) {
  return 'fm_uid=' + encodeURIComponent(uid) + '; Path=/; SameSite=Lax; Max-Age=' + SESSION_IDLE;
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
    'p.err{color:#fca5a5;font-size:12px;margin:0 0 12px}' +
    'input+input{margin-top:10px}';
  return '<!doctype html><meta charset="utf-8"><title>星海 FM</title><style>' + style + '</style>' +
    '<form method="post" action="/__auth">' +
      '<h1>星海 FM</h1>' +
      (err ? '<p class="err">' + err + '</p>' : '') +
      '<input type="hidden" name="next" value="' + (next || '/') + '">' +
      '<input type="text" name="user" placeholder="用户名" autofocus autocomplete="username">' +
      '<input type="password" name="pw" placeholder="密码" autocomplete="current-password">' +
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

async function serveMedia(req, res, rel, root) {
  /* 只放媒体文件：这个接口能顺着资源库根目录读任意路径，
     不挡扩展名就等于「登录后可以读整台机器的任意文件」（config.json、id_rsa……） */
  const ext = path.extname(rel).slice(1).toLowerCase();
  if (!MEDIA_EXT.has(ext)) return send(res, 404, 'not found');

  let file;
  try { file = inside(root, rel); } catch (e) { return send(res, 403, 'forbidden'); }
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
if (CLI) {
  (async function () {
    const act = CLI.action;
    if (act === 'list') {
      const us = DB.listUsers(db);
      if (!us.length) console.log('（没有用户）');
      us.forEach(function (u) { console.log('  ' + (u.role === 'admin' ? '*' : ' ') + ' ' + u.username + '  [' + u.role + ']'); });
      process.exit(0);
    }
    if (act === 'add') {
      if (!CLI.name) { console.error('用法：--add-user <name> [口令]'); process.exit(1); }
      if (DB.findUser(db, CLI.name)) { console.error('用户已存在：' + CLI.name); process.exit(1); }
      let pw = CLI.pw;
      if (!pw) { pw = await ask('设置密码（会显示在屏幕上）：'); const again = await ask('再输入一次确认：'); if (pw !== again) { console.error('两次输入不一致'); process.exit(1); } }
      if (!pw) { console.error('密码不能为空'); process.exit(1); }
      const u = DB.addUser(db, { username: CLI.name, role: 'user', password: pw });
      console.log('✓ 已添加用户：' + u.username);
      process.exit(0);
    }
    if (act === 'remove') {
      const u = DB.findUser(db, CLI.name);
      if (!u) { console.error('用户不存在：' + CLI.name); process.exit(1); }
      DB.removeUser(db, u.id);
      console.log('✓ 已删除用户：' + u.username);
      process.exit(0);
    }
    const u = DB.findUser(db, CLI.name);
    if (!u) { console.error('用户不存在：' + CLI.name); process.exit(1); }
    let pw = CLI.pw;
    if (act === 'check') {
      if (!pw) pw = await ask('输入要校验的密码：');
      const ok = DB.checkPassword(u, pw);
      console.log(ok ? '✓ 密码正确' : '✗ 密码不正确');
      process.exit(ok ? 0 : 1);
    }
    if (act === 'setpw') {
      if (!pw) { pw = await ask('设置新密码（会显示在屏幕上）：'); const again = await ask('再输入一次确认：'); if (pw !== again) { console.error('两次输入不一致'); process.exit(1); } }
      if (!pw) { console.error('密码不能为空'); process.exit(1); }
      DB.setUserPassword(db, u.id, pw);
      console.log('✓ 已修改密码：' + u.username);
      process.exit(0);
    }
    process.exit(0);
  })();
  return;                     // 命令行模式下不要继续起服务
}
if (DB.countUsers(db) === 0) {
  console.error([
    '还没有任何用户：',
    '  node tools/init-db.js                      # 迁移旧配置 / 生成 admin',
    '  node tools/serve.js --add-user 用户名 密码   # 或直接加用户',
    ''
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

  /* 桌面端登录：用户名 + 密码换长期 token */
  if (p === '/api/login' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let username = '', pw = '';
    try { const j = JSON.parse(body || '{}'); username = j.username || j.user || ''; pw = j.password || ''; } catch (e) {}
    const key = ip + '|' + username;
    const lock = lockedFor(key);
    if (lock) return send(res, 429, '尝试过多，请 ' + lock + ' 秒后再试');
    if (NO_AUTH) { const fu = DB.getUser(db, DB.firstUserId(db) || ''); const t0 = Math.floor(Date.now() / 1000); return json(res, { token: fu ? makeToken(t0, t0 + SESSION_ABS, fu.id, fu.token_version) : '' }); }
    const user = DB.findUser(db, username);
    if (!user || !DB.checkPassword(user, pw)) { noteFail(key); return send(res, 401, '用户名或密码不正确'); }
    fails.delete(key);
    upgradeHash(user, pw);
    DB.touchLogin(db, user.id);
    res.appendHeader('set-cookie', uidCookie(user.id));
    const nowSec = Math.floor(Date.now() / 1000);
    return json(res, { token: makeToken(nowSec, nowSec + SESSION_ABS, user.id, user.token_version), uid: user.id, username: user.username });
  }

  if (!NO_AUTH && p === '/__auth') {
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const username = form.get('user') || '';
      const pw = form.get('pw') || '';
      const next = form.get('next') || '/';
      const key = ip + '|' + username;
      const lock = lockedFor(key);
      if (lock) return send(res, 429, loginPage('尝试过多，请 ' + lock + ' 秒后再试', next), { 'content-type': 'text/html; charset=utf-8' });
      const user = DB.findUser(db, username);
      if (!user || !DB.checkPassword(user, pw)) {
        noteFail(key);
        return send(res, 401, loginPage('用户名或密码不正确', next), { 'content-type': 'text/html; charset=utf-8' });
      }
      fails.delete(key);
      upgradeHash(user, pw);
      DB.touchLogin(db, user.id);
      const nowSec = Math.floor(Date.now() / 1000);
      res.writeHead(302, {
        'set-cookie': [sessionCookie(makeToken(nowSec, nowSec + SESSION_ABS, user.id, user.token_version)), uidCookie(user.id)],
        'location': next.indexOf('/') === 0 ? next : '/'
      });
      return res.end();
    }
    return send(res, 200, loginPage('', u.searchParams.get('next') || '/'), { 'content-type': 'text/html; charset=utf-8' });
  }
  /* 退出登录：清 cookie 后回登录页；--no-auth 时没有登录页，直接回首页 */
  if (p === '/__auth/logout') {
    res.writeHead(302, { 'set-cookie': [SESSION_COOKIE + '=; Path=/; Max-Age=0', 'fm_uid=; Path=/; Max-Age=0'], 'location': NO_AUTH ? '/' : '/__auth' });
    return res.end();
  }

  /* 会话来源：浏览器 cookie，或桌面端的 Authorization: Bearer；媒体/封面可用 ?t= 票据 */
  let sess = null, ticket = null;
  if (!NO_AUTH) {
    sess = readSession(cookieOf(req, SESSION_COOKIE)) || readSession(bearerOf(req));
    if (!sess && (p.indexOf('/api/media/') === 0 || p.indexOf('/api/cover/') === 0)) {
      ticket = readTicket(u.searchParams.get('t'));
    }
  }
  /* --no-auth：免密，但必须有用户（取第一个用户） */
  const uid = NO_AUTH ? DB.firstUserId(db) : (sess ? sess.uid : (ticket ? ticket.uid : null));
  if (!uid) {
    if (p.indexOf('/api/') === 0) return send(res, 401, 'unauthorized');
    res.writeHead(302, { 'location': '/__auth?next=' + encodeURIComponent(req.url || '/') });
    return res.end();
  }
  /* 让前端能同步拿到当前用户（用于本地缓存命名空间），no-auth 也补一份 */
  if (cookieOf(req, 'fm_uid') !== uid) { try { res.appendHeader('set-cookie', uidCookie(uid)); } catch (e) {} }
  /* 滑动续期：活跃就往后推，但不超过首次登录算起的硬上限 */
  if (sess) {
    const tick = Math.floor(Date.now() / 1000);
    if (tick - sess.iat > REISSUE_AFTER) {
      res.setHeader('set-cookie', sessionCookie(makeToken(tick, sess.abs, sess.uid, sess.ver)));
    }
  }

  const me = DB.getUser(db, uid);
  if (p === '/api/me') {
    return json(res, { uid: uid, username: me ? me.username : '', role: me ? me.role : '' });
  }
  if (p === '/api/ticket') {
    return json(res, NO_AUTH ? { t: '', exp: 0 } : { t: makeTicket(uid), exp: Math.floor(Date.now() / 1000) + TICKET_TTL });
  }
  if (p === '/api/config') {
    const libs = userLibs(uid);
    const lib = userActiveLib(uid);
    return json(res, { server: libs.length > 0, rootName: lib ? lib.name : '', multi: MULTI, libEdit: ALLOW_LIB_EDIT, version: APP_VERSION });
  }
  if (p === '/api/libs') {
    const a = userActiveLib(uid);
    return json(res, { active: a ? a.id : null, multi: MULTI, libs: userLibs(uid).map(libView) });
  }
  if (p === '/api/activate') {
    const id = u.searchParams.get('id') || '';
    if (!DB.setActiveLib(db, uid, id)) return send(res, 400, 'unknown lib');
    const a = userActiveLib(uid);
    return json(res, { active: a ? a.id : null, libs: userLibs(uid).map(libView) });
  }
  if (p === '/api/meta') {
    const meta = await readMeta(userActiveRoot(uid));
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
    const lib = userLibs(uid).find(l => l.id === rec.libId) || userActiveLib(uid);
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
    const r = mutateLibs(uid, payload || {});
    if (r.code !== 200) return send(res, r.code, r.msg);
    const a = userActiveLib(uid);
    return json(res, { active: a ? a.id : null, multi: MULTI, libs: userLibs(uid).map(libView) });
  }
  if (p === '/api/scan') {
    const root = userActiveRoot(uid);
    if (!root) return send(res, 404, 'server mode off');
    try {
      const data = await scanFolder(root);
      const a = userActiveLib(uid);
      data.libId = a ? a.id : null;
      /* 新专辑的封面在后台补，接口先返回；页面轮询 /api/covers 拿结果 */
      data.coversPending = await covers.pendingOf(root);
      if (data.coversPending) covers.auto(root);
      return json(res, data);
    } catch (e) { return send(res, 500, e.message); }
  }
  if (p === '/api/covers') {
    const root = userActiveRoot(uid);
    if (!root) return send(res, 404, 'server mode off');
    try { return json(res, JSON.parse(await fsp.readFile(path.join(root, COVER_DIR, 'covers.json'), 'utf8'))); }
    catch (e) { return json(res, {}); }
  }
  if (p.indexOf('/api/cover/') === 0) {
    const root = userActiveRoot(uid);
    if (!root) return send(res, 404, 'server mode off');
    try {
      const file = inside(path.join(root, COVER_DIR), p.slice('/api/cover/'.length));
      const buf = await fsp.readFile(file);
      return send(res, 200, buf, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'image/jpeg', 'cache-control': 'max-age=86400' });
    } catch (e) { return send(res, 404, 'not found'); }
  }
  if (p.indexOf('/api/media/') === 0) {
    const root = userActiveRoot(uid);
    if (!root) return send(res, 404, 'server mode off');
    return serveMedia(req, res, p.slice('/api/media/'.length), root);
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
  const users = DB.listUsers(db);
  console.log('星海 FM · http://' + host + ':' + port + '/');
  console.log('数据库 · ' + dataFilePath() + '（用户 ' + users.length + ' 个' + (NO_AUTH ? '，--no-auth 免密' : '') + '）');
  users.forEach(function (u) {
    const libs = DB.listLibs(db, u.id);
    console.log('  ' + (u.role === 'admin' ? '*' : ' ') + ' ' + u.username + '  资源库 ' + libs.length + ' 个');
  });
});
