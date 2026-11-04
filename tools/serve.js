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
 *   GET  /api/meta              当前库的元数据快照（分类 / 专辑整理 / 进度 / 时长，来自 fm.db）
 *   POST /api/meta              增量写回元数据（网页端、手机端也能改分类）
 *   POST /api/progress          手机端回传播放进度，按时间戳合并进 fm.db
 *   GET  /api/scan[?refresh=1] 目录列表（和主进程扫描结果同构；默认读 fm.db 里的扫描缓存）
 *   GET  /api/scan/at          扫描缓存的时间戳（客户端据此判断要不要同步别人的扫描结果）
 *   GET  /api/covers            封面索引（.fm-covers/covers.json）
 *   GET  /api/cover/<file>      封面图片
 *   GET  /api/media/<rel>       音频流，支持 Range（拖动进度条）
 *   POST /api/prepare           把 flv 重封装成 mp4，返回可播地址
 *   GET  /api/tc/<file>         转码缓存流，支持 Range
 *   GET  /api/duration?rel=     只读文件头取时长（不转码）
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
/* 和桌面端主进程共用同一套转码逻辑：flv → mp4（ape/wv/wma 直接提示不支持） */
const TC = require('../transcode');
/* 登录页的转义与站内跳转校验：单独成模块，方便单测 */
const { escHtml, safeNext } = require('./safe');
/* 版本号：打包前已把 package.json 的 version 自增，这里读出来给远程页面显示 */
const APP_VERSION = (function () {
  try { return String(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || ''); }
  catch (e) { return ''; }
})();
const COVER_DIR = '.fm-covers';
/* 口令文件可重定向（测试/多实例用），默认项目根目录 */
const AUTH_FILE = process.env.FM_AUTH_FILE ? path.resolve(process.env.FM_AUTH_FILE) : path.join(APP_ROOT, '.auth.json');
const MEDIA_EXT = new Set([
  'm4a', 'm4b', 'mp3', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'ape', 'wv',
  'mp4', 'm4v', 'mov', 'webm', 'ogv', 'flv'
]);
/* 同上（main.js）：扫描结果按库缓存、与分组开关无关，深度留足余量 */
const MAX_DEPTH = 6;
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

/* 读库前先同步「别人共享给我的库」：物化成只读副本，后面的读路径就无需再关心共享 */
function userLibs(uid) { DB.syncUserSharedLibs(db, uid); return DB.listLibs(db, uid); }
function userActiveLib(uid) { DB.syncUserSharedLibs(db, uid); return DB.activeLib(db, uid); }
function userActiveRoot(uid) { const l = userActiveLib(uid); return l ? l.path : ''; }
/* fixed = 前端不给改（没开 --allow-lib-edit，或者是别人共享来的只读库） */
function libView(l) {
  return {
    id: l.id, name: l.name, missing: !fs.existsSync(l.path),
    fixed: !ALLOW_LIB_EDIT || !!l.shared_id,
    shared: !!l.shared_id,
    /* 目录结构三档：flat / cat / auto；dirGroup 是老字段，只为兼容旧客户端 */
    dirMode: DB.libDirMode(db, l.path),
    dirGroup: DB.libDirGroup(db, l.path)
  };
}
/* 库列表响应：管理员看自己可编辑的库时附带共享配置（供弹窗预填） */
function libsView(uid, isAdmin) {
  return userLibs(uid).map(function (l) {
    const v = libView(l);
    if (isAdmin && !l.shared_id) v.shares = DB.listShares(db, l.id) || { targetAll: false, targets: [] };
    return v;
  });
}
/* 用户列表（用户管理页 / 共享弹窗共用；只有管理员接口会返回） */
function usersView() {
  return DB.listUsers(db).map(function (x) {
    return {
      id: x.id, username: x.username, role: x.role,
      disabled: !!x.disabled, createdAt: x.createdAt, lastLoginAt: x.lastLoginAt
    };
  });
}

/* ── 库元数据（分类 / 专辑整理 / 进度 / 时长）──
 * 住 fm.db，和桌面端共用同一份：一次事务只写变化的部分，不再有「谁把谁覆盖」的问题。
 * 库目录 .fm-meta.json 降级为导出快照（桌面端写，这里不读）。 */
function ensureMetaMigrated(lib) {
  if (!lib || !lib.path) return;
  try { DB.migrateLegacyMeta(db, lib.path, lib.path); }
  catch (e) { console.log('[meta] 迁移旧数据失败：' + e.message); }
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
    DB.clearFavs(db, uid, id);
    /* 元数据、扫描缓存都按库目录存：库移除时顺手清掉，别留孤儿行 */
    if (lib.path) { try { DB.clearLibMeta(db, lib.path); } catch (e) {} }
    dropScanCache(lib.path);
    /* 源库被删：连带撤掉共享关系和别人手里的只读副本 */
    DB.removeLibShare(db, id);
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
function writeAllowed(ip, limit, scope) {
  const now = Date.now();
  /* 按用途分开计数：收藏连点不该把进度上报/资源库操作的额度吃掉 */
  const key = ip + '|' + (scope || '');
  const rec = writeHits.get(key) || { n: 0, since: now };
  if (now - rec.since > 1000) { rec.n = 0; rec.since = now; }
  rec.n++;
  writeHits.set(key, rec);
  /* 超量时按时间清旧数据；不能直接 clear()——那样刷一批 key 就能把别人的计数也清零 */
  if (writeHits.size > 512) {
    for (const [k, v] of writeHits) if (now - v.since > 60000) writeHits.delete(k);
  }
  return rec.n <= (limit || 5);
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
  /* 账号被禁用：已签发的 token 一律不认（配合禁用时 token_version 自增，双重保险） */
  if (u.disabled) return null;
  /* 改过密码（token_version 变了）→ 旧 token 作废 */
  if ((Number(u.token_version) || 0) !== ver) return null;
  return { iat: iat, abs: abs, uid: uid, ver: ver, username: u.username, role: u.role };
}
/* 短期票据：带 uid，只能读该用户自己的库（<audio>/<img> 带不了请求头）。
   按用途分范围、不同寿命：封面图 10 分钟就够；媒体要覆盖单集时长——整本一个文件的有声书
   可能一两个小时，签太短会让中途拖动进度条直接 403。 */
const TICKET_TTL = { cover: 10 * 60, media: 2 * 3600 };
function makeTicket(uid, scope, ver) {
  const exp = Math.floor(Date.now() / 1000) + (TICKET_TTL[scope] || TICKET_TTL.media);
  const payload = 't.' + exp + '.' + uid + '.' + scope + '.' + (Number(ver) || 0);
  return payload + '.' + sign(payload, DB.secret(db));
}
function readTicket(t, scope) {
  if (!t) return null;
  const parts = String(t).split('.');
  if (parts.length !== 6 || parts[0] !== 't') return null;
  const exp = parseInt(parts[1], 10);
  const uid = parts[2];
  const ver = parseInt(parts[4], 10);
  if (!(exp > 0) || !uid || !(ver >= 0)) return null;
  /* 票据分范围：封面票不能拿来读媒体，反之亦然 */
  if (parts[3] !== scope) return null;
  const payload = 't.' + exp + '.' + uid + '.' + scope + '.' + ver;
  const want = Buffer.from(sign(payload, DB.secret(db)));
  const got = Buffer.from(parts[5]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  if (Math.floor(Date.now() / 1000) > exp) return null;
  const u = DB.getUser(db, uid);
  if (!u) return null;
  /* 账号被禁用：媒体/封面票据立即作废 */
  if (u.disabled) return null;
  /* 改过密码（token_version 变了）→ 旧票据也立即作废，不用等它自然过期 */
  if ((Number(u.token_version) || 0) !== ver) return null;
  return { uid: uid, exp: exp, scope: scope };
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

/* 同一用户名 10 分钟内错 5 次，锁 10 分钟。
   键里不放 IP：经 SSH 隧道进来的请求 remoteAddress 全是 127.0.0.1，
   带上 IP 等于所有人共享一个计数，一个人输错几次就把别人（尤其 admin）一起锁死。 */
const FAIL_WINDOW = 600000;
const FAIL_LIMIT = 5;
const FAIL_MAX = 4096;        /* 上限：防止有人拿随机用户名把 Map 刷爆 */
const fails = new Map();
function failKey(username) { return String(username || '').trim().toLowerCase(); }
function lockedFor(key) {
  const rec = fails.get(key);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.until > now) return Math.ceil((rec.until - now) / 1000);
  /* 锁过期、统计窗口也过了：校验时顺手删掉，别让 Map 只长不缩 */
  if (now - rec.since > FAIL_WINDOW) fails.delete(key);
  return 0;
}
function pruneFails(now) {
  for (const [k, v] of fails) {
    if (v.until < now && now - v.since > FAIL_WINDOW) fails.delete(k);
  }
  /* 极端情况（随机用户名刷锁）：按插入顺序丢掉最早的一批 */
  if (fails.size > FAIL_MAX) {
    let n = fails.size - FAIL_MAX;
    for (const k of fails.keys()) { if (n-- <= 0) break; fails.delete(k); }
  }
}
function noteFail(key) {
  const now = Date.now();
  const rec = fails.get(key) || { count: 0, since: now, until: 0 };
  if (now - rec.since > FAIL_WINDOW) { rec.count = 0; rec.since = now; }
  rec.count++;
  if (rec.count >= FAIL_LIMIT) { rec.until = now + FAIL_WINDOW; rec.count = 0; rec.since = now; }
  fails.set(key, rec);
  if (fails.size > 256) pruneFails(now);
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
  '.wv': 'audio/x-wavpack',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.flv': 'video/x-flv'
};

/* gzip：只压文本类，压过的结果按内容哈希缓存，重复请求不再压一遍 */
const gzCache = new Map();
const reqOf = new WeakMap();

function wantsGzip(req) {
  return !!req && /gzip/.test(String(req.headers['accept-encoding'] || ''));
}
/* 大包异步压缩：gzipSync 会把事件循环整段占住（整库清单 2~3MB 要几百毫秒），
 * 这期间正在传输的视频流一字节都发不出去，播放端就卡住等数据。 */
function gzipAsync(buf) {
  return new Promise(function (resolve, reject) {
    zlib.gzip(buf, { level: 6 }, function (e, out) { if (e) reject(e); else resolve(out); });
  });
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

/* 页面侧的安全策略：脚本/样式只认同源（页面里没有内联脚本），
   图片额外放行 data/blob 与封面候选的外链，媒体放行 blob 和 APK 里的本机 127.0.0.1 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' blob: data: http://127.0.0.1:*",
  "connect-src 'self' http://127.0.0.1:*",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

/* 登录类请求体上限。这两个入口未认证可达，其它接口都有自己的上限，
   这里不设的话，公网上一个超大 body 就能把进程内存吃光。 */
const MAX_LOGIN_BODY = 64 * 1024;
/* 读完返回字符串；超限返回 null（调用方直接断开连接，别再继续收） */
async function readBody(req, limit) {
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > limit) {
        /* 必须直接销毁 socket：for-await 的 return 只会 destroy 请求流，
           而 IncomingMessage.destroy() 不关 socket，剩下的 body 会继续进来，
           连接和内存都挂着不释放。 */
        try { req.socket.destroy(); } catch (e) {}
        return null;
      }
    }
  } catch (e) {
    return null;
  }
  return body;
}

function send(res, code, body, headers) {
  const h = Object.assign({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',     /* 媒体票据在 query 里，别随 Referer 漏出去 */
    'x-frame-options': 'DENY',
    'content-security-policy': CSP
  }, headers || {});
  const type = String(h['content-type'] || '');
  const buf = Buffer.isBuffer(body) ? body : (typeof body === 'string' ? Buffer.from(body) : null);
  const canZip = buf && buf.length > 1024 && !h['content-encoding'] &&
    /text|json|javascript|css|svg/.test(type) && wantsGzip(reqOf.get(res));
  if (canZip) {
    /* 压缩成功之后才写头：先 writeHead 的话，头里已经声明 content-encoding: gzip，
       压缩失败再发原始 buf，客户端会收到解不出来的响应（Node 也不允许写完头再改）。 */
    const zh = Object.assign({}, h, { 'content-encoding': 'gzip', 'vary': 'Accept-Encoding' });
    /* 小包同步压（1ms 级）+ 缓存；大包（整库清单动辄几 MB）必须异步，
       否则压缩的几百毫秒里视频流发不出去，播放端就卡住等 */
    if (buf.length <= 64 * 1024) {
      const out = gzipOf(buf);
      zh['content-length'] = String(out.length);
      res.writeHead(code, zh);
      return res.end(out);
    }
    const t0g = Date.now();
    gzipAsync(buf).then(function (out) {
      const ms = Date.now() - t0g;
      if (ms > 200 || DEBUG_REQ) console.log('[gzip] ' + (buf.length >> 10) + 'KB → ' + (out.length >> 10) + 'KB，' + ms + 'ms');
      if (res.writableEnded || res.destroyed) return;
      zh['content-length'] = String(out.length);
      res.writeHead(code, zh);
      res.end(out);
    }, function (e) {
      /* 还没写头，可以干净地退回明文 */
      console.warn('[gzip] 压缩失败，改发明文：' + (e && e.message));
      if (res.writableEnded || res.destroyed) return;
      if (h['content-length'] == null) h['content-length'] = String(buf.length);
      res.writeHead(code, h);
      res.end(buf);
    });
    return;
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
  /* 空的 data: 图标：登录页没有 favicon，浏览器会额外请求 /favicon.ico 换一个 404 */
  return '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>星海 FM</title><style>' + style + '</style>' +
    '<form method="post" action="/__auth">' +
      '<h1>星海 FM</h1>' +
      (err ? '<p class="err">' + escHtml(err) + '</p>' : '') +
      '<input type="hidden" name="next" value="' + escHtml(safeNext(next)) + '">' +
      '<input type="text" name="user" placeholder="用户名" autofocus autocomplete="username">' +
      '<input type="password" name="pw" placeholder="密码" autocomplete="current-password">' +
      '<button type="submit">进入媒体库</button>' +
    '</form>';
}

/* ── 扫描结果缓存 ──
 * 整库扫描要递归 readdir + 每个文件 stat（实测 2~3 秒，NAS 上几十秒）。以前只有 5 秒内存缓存，
 * 手机扫完、桌面进来、网页刷新、换个用户登录，每台设备每个账号都要各自重扫一遍。
 * 现在扫完就落到 fm.db 的 settings（键 scan:<库目录>，按目录共享，不区分用户），
 * 之后所有请求默认直接读缓存；只有前端点「重新扫描」才带 refresh=1 真的走盘。 */
const scanCache = new Map();   // settings 的反序列化结果，省掉每次请求的 JSON.parse

function scanKey(root) { return 'scan:' + DB.libRootKey(root); }

/* 内存层用 settings 里的小时间戳（scan:<库>:at）校验：桌面主进程和这里共用同一个 fm.db，
   一端重新扫描后，另一端的常驻内存缓存也要能跟上，否则会一直返回旧结果直到重启进程 */
function readScanCache(root) {
  const k = scanKey(root);
  let stamp = '';
  try { stamp = DB.getSetting(db, k + ':at', ''); } catch (e) { return null; }
  const mem = scanCache.get(k);
  if (mem && stamp && String(mem.scannedAt) === stamp) return mem;
  let raw = '';
  try { raw = DB.getSetting(db, k, ''); } catch (e) { return null; }
  if (!raw) { scanCache.delete(k); return null; }
  try {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.files)) return null;
    scanCache.set(k, data);
    return data;
  } catch (e) { return null; }
}

function writeScanCache(root, data) {
  const k = scanKey(root);
  const at = data.scannedAt || Date.now();
  try {
    /* 新旧守卫：两次扫描交错时（A 先开始、B 后开始但先扫完），别让 A 的旧快照把 B 的新快照盖回去 */
    const prev = Number(DB.getSetting(db, k + ':at', '0')) || 0;
    if (prev > at) return;
    DB.setSetting(db, k, JSON.stringify(data));
    DB.setSetting(db, k + ':at', String(at));
  } catch (e) { console.log('[scan] 写缓存失败：' + e.message); }
  scanCache.set(k, data);
}

/* 同一库同一时刻只允许一个 walk 在跑：多人同时点「重新扫描」时，后来的请求挂到同一个 Promise 上，
   不会在主机上叠出好几路 readdir + stat */
const scanInflight = new Map();

/* 库里移除后把它的扫描缓存一起清掉，别在 settings 里留几 MB 的孤儿行 */
function dropScanCache(root) {
  if (!root) return;
  const k = scanKey(root);
  scanCache.delete(k);
  try { DB.setSetting(db, k, ''); DB.setSetting(db, k + ':at', ''); } catch (e) {}
}

async function walkAndCache(root) {
  const out = [];
  /* 同 main.js：先收集文件，再 8 路并发 stat，别一个文件一个 stat 串着等 */
  const pending = [];
  const STAT_CONC = 8;
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
        pending.push({ rel, name: ent.name, ext, depth, abs, size: 0, mtime: 0 });
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

/* 等别人那次 walk 最多等这么久：NAS 掉线、目录卡死时不能让后来的请求一起挂死。
   超时先把手里的旧缓存回给客户端，后台那次 walk 跑完仍然会落盘。
   120 秒：第一次扫大库（几万文件、外接盘）一分半未必够，超过就先用旧数据顶上 */
const SCAN_WAIT_MS = 120000;

function withTimeout(p, ms) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () {
      const e = new Error('扫描超时'); e.code = 'ETIMEDOUT'; reject(e);
    }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

/* 卡死的 walk（磁盘拔了、SMB 会话挂了）超过这个时间就放弃，重新起一次，
   否则手动「重新扫描」也会永远挂在那个永远不结束的 Promise 上 */
const SCAN_STALE_MS = 5 * 60 * 1000;

/* opts.refresh = true 时跳过缓存重新走盘（前端「重新扫描」） */
async function scanFolder(root, opts) {
  const o = opts || {};
  const cached = readScanCache(root);
  if (!o.refresh && cached) return cached;
  const k = scanKey(root);
  let rec = scanInflight.get(k);
  if (rec && Date.now() - rec.at > SCAN_STALE_MS) {
    console.log('[scan] 上一次扫描卡住超过 5 分钟，丢弃重来');
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
    /* 超时 / 这次 walk 失败：有旧缓存就先给旧的，别让请求一直挂着 */
    if (cached) {
      console.log('[scan] 扫描超过 ' + Math.round(SCAN_WAIT_MS / 1000) + ' 秒，先回上次结果；后台扫完会自动落盘');
      return Object.assign({}, cached, { stale: true });
    }
    if (err && err.code === 'ETIMEDOUT') {
      /* 连缓存都没有（第一次扫这么大的库）：不能说「扫描失败」，
         后台那次 walk 还在跑，扫完会落盘，再问一次就读到了 */
      const e2 = new Error('库太大，第一次扫描还没跑完；它会在后台继续，稍后再点「重新扫描」就能看到结果');
      e2.code = 'ESCANNING';
      throw e2;
    }
    throw err;
  }
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

  res.__media = true;
  sendRangeFile(req, res, file, st);
}

/* 媒体与转码缓存共用：Range 直读 + 禁浏览器磁盘缓存。
   之前试过 private, max-age=3600 想让 seek 复用已下载区间，结果 Chrome 会把缓冲到的
   每一段都写进自己的磁盘缓存（实测播 15 秒写 22MB），盘一慢或被杀软扫一遍，
   视频就「播几秒开始转圈」。局域网/本机重新拉一遍本来就是毫秒级，换来的风险不值当。 */
function sendRangeFile(req, res, file, st) {
  res.__media = true;
  const head = {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store'
  };
  const range = parseRange(req.headers.range, st.size);
  if (range === 'bad') return send(res, 416, null, Object.assign({}, head, { 'content-range': 'bytes */' + st.size }));
  if (!range) {
    res.writeHead(200, Object.assign({}, head, { 'content-length': st.size }));
    return pipeFile(file, res);
  }
  res.writeHead(206, Object.assign({}, head, {
    'content-length': range.end - range.start + 1,
    'content-range': 'bytes ' + range.start + '-' + range.end + '/' + st.size
  }));
  pipeFile(file, res, { start: range.start, end: range.end });
}

/* ── 转码缓存：flv 转出来的 mp4 放在数据库旁边 ── */
function tcDir() {
  return path.join(path.dirname(dataFilePath()), 'tc');
}

/* 只认 transcode.js 生成的 40 位 sha1 + 目标扩展名，再在缓存目录内二次确认 */
async function serveTc(req, res, name) {
  if (!TC.NAME_RE.test(name)) return send(res, 404, 'not found');
  const file = path.join(tcDir(), name);
  if (path.dirname(path.normalize(file)) !== path.normalize(tcDir())) return send(res, 403, 'forbidden');
  let st;
  try { st = await fsp.stat(file); } catch (e) { return send(res, 404, 'not found'); }
  if (!st.isFile()) return send(res, 404, 'not found');
  sendRangeFile(req, res, file, st);
}

/* 读文件并把内容写到响应里。
 * 关键点：浏览器（尤其拖进度条时）会中断前一个 Range 请求，pipe 不会自动停掉读流，
 * 于是那条流会一路读到文件尾——几次 seek 就叠出好几条全量读，磁盘/CPU 一满，播放就开始顿。 */
function pipeFile(file, res, opts) {
  const stream = opts ? fs.createReadStream(file, opts) : fs.createReadStream(file);
  const t0p = Date.now();
  let bytes = 0;
  stream.on('data', function (c) { bytes += c.length; });
  const kill = () => { try { stream.destroy(); } catch (e) {} };
  res.on('close', function () {
    kill();
    /* 媒体流的「总时长」就是一直传到浏览器不再要为止，所以记吞吐、不记耗时；
       0 字节说明请求一进来就断了（多半是客户端取消，不必紧张） */
    if (DEBUG_REQ) {
      const ms = Math.max(1, Date.now() - t0p);
      console.log('[media] 发 ' + (bytes / 1048576).toFixed(1) + 'MB / ' + ms + 'ms（' +
        (bytes / 1048576 / (ms / 1000)).toFixed(1) + 'MB/s，起 ' + (opts ? opts.start : 0) + '）');
    }
  });
  res.on('error', kill);
  stream.on('error', () => { try { res.destroy(); } catch (e) {} });
  stream.pipe(res);
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
      const uErr = DB.usernameError(CLI.name);
      if (uErr) { console.error(uErr); process.exit(1); }
      if (DB.findUser(db, CLI.name)) { console.error('用户已存在：' + CLI.name); process.exit(1); }
      let pw = CLI.pw;
      if (!pw) { pw = await ask('设置密码（会显示在屏幕上）：'); const again = await ask('再输入一次确认：'); if (pw !== again) { console.error('两次输入不一致'); process.exit(1); } }
      const pErr = DB.passwordError(CLI.name, pw);
      if (pErr) { console.error(pErr); process.exit(1); }
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
      const pErr = DB.passwordError(u.username, pw);
      if (pErr) { console.error(pErr); process.exit(1); }
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

/* css/js 的内容指纹：只有这些文件变了才变，用作 index.html 里 ?v= 的版本号，
   免得改完样式还要用户手动清 WebView 缓存才看得到 */
async function assetsVersion() {
  const h = crypto.createHash('sha1');
  for (const dir of ['css', 'js']) {
    const names = (await fsp.readdir(path.join(APP_ROOT, dir))).sort();
    for (const n of names) {
      if (!/\.(css|js)$/i.test(n)) continue;
      h.update(n).update(await fsp.readFile(path.join(APP_ROOT, dir, n)));
    }
  }
  return h.digest('hex').slice(0, 8);
}

/* ── 诊断：正常不吭声，出问题时能有据可查 ────────────────────────
 * 1) 事件循环停顿：Node 被同步操作卡住时，视频流也会跟着断，一眼能看出来
 * 2) 慢请求：超过 1 秒的请求打一行（含媒体 Range）
 * 3) FM_DEBUG=1：把媒体/进度这类关键请求逐条打出来，用来对时间线
 */
const DEBUG_REQ = /^(1|true|yes)$/i.test(String(process.env.FM_DEBUG || ''));
let lastTick = Date.now();
setInterval(function () {
  const now = Date.now();
  const lag = now - lastTick - 1000;
  lastTick = now;
  if (lag > 300) console.log('[lag] 事件循环停顿 ' + lag + 'ms');
}, 1000).unref();

const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  reqOf.set(res, req);
  const t0 = Date.now();
  res.on('close', function () {
    if (res.__media) return;                 /* 媒体流自己记（它的总时长=传输时长，不是耗时） */
    const ms = Date.now() - t0;
    const label = req.method + ' ' + u.pathname;
    if (ms > 1000) console.log('[slow] ' + label + ' ' + res.statusCode + ' ' + ms + 'ms');
    else if (DEBUG_REQ && /^\/api\/(media|progress|meta|scan|ticket|covers)/.test(u.pathname)) {
      console.log('[req] ' + label + ' ' + res.statusCode + ' ' + ms + 'ms' + (req.headers.range ? ' range=' + req.headers.range : ''));
    }
  });

  /* 跨源只放行桌面端（fm://app，靠 Bearer 不带 cookie）；同源请求本来就不需要 ACAO */
  const origin = String(req.headers.origin || '');
  if (origin === 'fm://app') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    /* 滑动续期的新 token 走响应头下发，跨源时得显式放行，否则桌面端读不到 */
    res.setHeader('Access-Control-Expose-Headers', 'x-fm-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  /* 桌面端登录：用户名 + 密码换长期 token */
  if (p === '/api/login' && req.method === 'POST') {
    const body = await readBody(req, MAX_LOGIN_BODY);
    if (body === null) { req.destroy(); return; }
    let username = '', pw = '';
    try { const j = JSON.parse(body || '{}'); username = j.username || j.user || ''; pw = j.password || ''; } catch (e) {}
    const key = failKey(username);
    const lock = lockedFor(key);
    if (lock) return send(res, 429, '尝试过多，请 ' + lock + ' 秒后再试');
    if (NO_AUTH) { const fu = DB.getUser(db, DB.firstUserId(db) || ''); const t0 = Math.floor(Date.now() / 1000); return json(res, { token: fu ? makeToken(t0, t0 + SESSION_ABS, fu.id, fu.token_version) : '' }); }
    const user = DB.findUser(db, username);
    if (!user || !DB.checkPassword(user, pw)) { noteFail(key); return send(res, 401, '用户名或密码不正确'); }
    /* 密码正确但账号被禁用：明确提示；提示放在密码校验之后，避免账号枚举 */
    if (user.disabled) return send(res, 403, '账号已被禁用');
    fails.delete(key);
    upgradeHash(user, pw);
    DB.touchLogin(db, user.id);
    res.appendHeader('set-cookie', uidCookie(user.id));
    const nowSec = Math.floor(Date.now() / 1000);
    return json(res, { token: makeToken(nowSec, nowSec + SESSION_ABS, user.id, user.token_version), uid: user.id, username: user.username });
  }

  if (!NO_AUTH && p === '/__auth') {
    if (req.method === 'POST') {
      const body = await readBody(req, MAX_LOGIN_BODY);
      if (body === null) { req.destroy(); return; }
      const form = new URLSearchParams(body);
      const username = form.get('user') || '';
      const pw = form.get('pw') || '';
      const next = safeNext(form.get('next'));
      const key = failKey(username);
      const lock = lockedFor(key);
      if (lock) return send(res, 429, loginPage('尝试过多，请 ' + lock + ' 秒后再试', next), { 'content-type': 'text/html; charset=utf-8' });
      const user = DB.findUser(db, username);
      if (!user || !DB.checkPassword(user, pw)) {
        noteFail(key);
        return send(res, 401, loginPage('用户名或密码不正确', next), { 'content-type': 'text/html; charset=utf-8' });
      }
      if (user.disabled) return send(res, 403, loginPage('账号已被禁用', next), { 'content-type': 'text/html; charset=utf-8' });
      fails.delete(key);
      upgradeHash(user, pw);
      DB.touchLogin(db, user.id);
      const nowSec = Math.floor(Date.now() / 1000);
      res.writeHead(302, {
        'set-cookie': [sessionCookie(makeToken(nowSec, nowSec + SESSION_ABS, user.id, user.token_version)), uidCookie(user.id)],
        'location': next
      });
      return res.end();
    }
    return send(res, 200, loginPage('', u.searchParams.get('next')), { 'content-type': 'text/html; charset=utf-8' });
  }
  /* 退出登录：清 cookie 后回登录页；--no-auth 时没有登录页，直接回首页 */
  if (p === '/__auth/logout') {
    res.writeHead(302, { 'set-cookie': [SESSION_COOKIE + '=; Path=/; Max-Age=0', 'fm_uid=; Path=/; Max-Age=0'], 'location': NO_AUTH ? '/' : '/__auth' });
    return res.end();
  }

  /* 会话来源：浏览器 cookie，或桌面端的 Authorization: Bearer；媒体/封面在没有会话时才用 ?t= 票据 */
  let sess = null, ticket = null, viaCookie = false;
  if (!NO_AUTH) {
    const ck = readSession(cookieOf(req, SESSION_COOKIE));
    sess = ck || readSession(bearerOf(req));
    viaCookie = !!ck;
    if (!sess) {
      /* 转码缓存也是媒体，用同一张 media 票据（<audio>/<video> 带不了 Authorization 头） */
      const scope = (p.indexOf('/api/media/') === 0 || p.indexOf('/api/tc/') === 0)
        ? 'media'
        : (p.indexOf('/api/cover/') === 0 ? 'cover' : '');
      if (scope) ticket = readTicket(u.searchParams.get('t'), scope);
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
  /* 滑动续期：活跃就往后推，但不超过首次登录算起的硬上限。
     cookie 用 Set-Cookie；桌面端走 Bearer 拿不到 cookie，得在响应头里下发新 token，
     否则 iat 永远停在登录那一刻，7 天后天天用也会被踢下线。 */
  if (sess) {
    const tick = Math.floor(Date.now() / 1000);
    if (tick - sess.iat > REISSUE_AFTER) {
      const fresh = makeToken(tick, sess.abs, sess.uid, sess.ver);
      if (viaCookie) res.appendHeader('set-cookie', sessionCookie(fresh));
      else {
        res.setHeader('x-fm-token', fresh);
        res.setHeader('access-control-expose-headers', 'x-fm-token');
      }
    }
  }

  const me = DB.getUser(db, uid);
  if (p === '/api/me') {
    return json(res, { uid: uid, username: me ? me.username : '', role: me ? me.role : '' });
  }
  if (p === '/api/ticket') {
    /* 浏览器/APK 有会话 cookie：<audio>/<img> 同源请求会自带 cookie，URL 里不必挂票据；
       只有桌面端（fm://app + Bearer，没有 cookie）才需要换票据 */
    if (NO_AUTH || viaCookie) return json(res, { t: '', exp: 0, cookie: true });
    const scope = u.searchParams.get('scope') === 'cover' ? 'cover' : 'media';
    return json(res, { t: makeTicket(uid, scope, me ? me.token_version : 0), exp: Math.floor(Date.now() / 1000) + TICKET_TTL[scope], scope: scope });
  }
  if (p === '/api/users') {
    /* 用户管理：仅管理员可见 / 可改；--no-auth 免密模式下没有真实身份，直接关掉 */
    if (NO_AUTH) return send(res, 403, '--no-auth 免密模式不支持用户管理');
    if (!me || me.role !== 'admin') return send(res, 403, '只有管理员可以管理用户');
    if (req.method === 'GET') return json(res, usersView());
    if (req.method !== 'POST') return send(res, 405, 'GET/POST only');
    if (!writeAllowed(ip)) return send(res, 429, 'too many writes');
    const body = await readBody(req, 8192);
    if (body === null) { req.destroy(); return; }
    let payload = null;
    try { payload = JSON.parse(body); } catch (e) { return send(res, 400, 'bad json'); }
    const act = String((payload && payload.action) || '');

    /* 新增用户：role 固定为普通用户（admin 只由初始化创建，避免界面上提权） */
    if (act === 'create') {
      const username = String((payload && payload.username) || '').trim();
      const password = String((payload && payload.password) || '');
      const libIds = Array.isArray(payload && payload.libIds) ? payload.libIds : [];
      const uErr = DB.usernameError(username);
      if (uErr) return send(res, 400, uErr);
      const pErr = DB.passwordError(username, password);
      if (pErr) return send(res, 400, pErr);
      if (DB.findUser(db, username)) return send(res, 409, '用户名已存在');
      let user = null;
      try { user = DB.addUser(db, { username: username, role: 'user', password: password }); }
      catch (e) {
        const msg = String((e && e.message) || '');
        /* findUser 与 addUser 之间不是原子的：并发建号会命中唯一约束，按重名处理 */
        if (/UNIQUE|constraint/i.test(msg)) return send(res, 409, '用户名已存在');
        return send(res, 400, '新增用户失败：' + (msg || '未知错误'));
      }
      /* 新建时可直接指定可访问的资源库：复用共享机制，给新用户物化只读副本。
         指派失败时把刚建的用户回滚，避免只建了半个账号。 */
      try {
        libIds.forEach(function (libId) {
          const lib = DB.getLib(db, uid, String(libId || ''));
          if (!lib || lib.shared_id) return;      /* 只允许指派当前管理员名下可编辑的库 */
          DB.addLibShareTarget(db, lib.id, user.id);
        });
        DB.syncUserSharedLibs(db, user.id);
      } catch (e) {
        console.log('[user] 建号后指派资源库失败，回滚用户「' + username + '」：' + ((e && e.message) || e));
        try { DB.removeUser(db, user.id); } catch (e2) { console.log('[user] 回滚失败：' + ((e2 && e2.message) || e2)); }
        return send(res, 500, '新增用户失败：指派资源库时出错');
      }
      console.log('[user] 新增「' + username + '」' + (libIds.length ? '，指派 ' + libIds.length + ' 个库' : ''));
      return json(res, { ok: true, users: usersView() });
    }

    /* 重置密码：走 DB.setUserPassword，token_version 自增，该用户所有旧会话/票据立即失效 */
    if (act === 'resetPassword') {
      const id = String((payload && payload.id) || '');
      const password = String((payload && payload.password) || '');
      const target = DB.getUser(db, id);
      if (!target) return send(res, 404, '用户不存在');
      const pErr = DB.passwordError(target.username, password);
      if (pErr) return send(res, 400, pErr);
      DB.setUserPassword(db, id, password);
      console.log('[user] 重置密码「' + target.username + '」');
      return json(res, { ok: true, users: usersView() });
    }

    /* 启用 / 禁用：禁用后 token_version 自增，已登录会话与票据立即失效 */
    if (act === 'setDisabled') {
      const id = String((payload && payload.id) || '');
      const disabled = !!(payload && payload.disabled);
      const target = DB.getUser(db, id);
      if (!target) return send(res, 404, '用户不存在');
      if (id === uid) return send(res, 400, '不能修改当前登录管理员自己的状态');
      if (disabled && !target.disabled && target.role === 'admin' && DB.countEnabledAdmins(db) <= 1) {
        return send(res, 400, '不能禁用最后一个可用管理员');
      }
      DB.setUserDisabled(db, id, disabled);
      console.log('[user] ' + (disabled ? '禁用' : '启用') + '「' + target.username + '」');
      return json(res, { ok: true, users: usersView() });
    }

    /* 删除：级联清理该用户的资源库、收藏与共享关系 */
    if (act === 'delete') {
      const id = String((payload && payload.id) || '');
      const target = DB.getUser(db, id);
      if (!target) return send(res, 404, '用户不存在');
      if (id === uid) return send(res, 400, '不能删除当前登录管理员自己');
      if (!target.disabled && target.role === 'admin' && DB.countEnabledAdmins(db) <= 1) {
        return send(res, 400, '不能删除最后一个可用管理员');
      }
      DB.removeUser(db, id);
      console.log('[user] 删除「' + target.username + '」');
      return json(res, { ok: true, users: usersView() });
    }

    return send(res, 400, 'unknown action');
  }
  if (p === '/api/config') {
    const libs = userLibs(uid);
    const lib = userActiveLib(uid);
    return json(res, {
      server: libs.length > 0, rootName: lib ? lib.name : '', multi: MULTI, libEdit: ALLOW_LIB_EDIT,
      /* auth=false 表示服务端跑在 --no-auth 免密模式：前端据此隐藏用户管理等需要真身份的功能 */
      auth: !NO_AUTH,
      version: APP_VERSION, dirMode: lib ? DB.libDirMode(db, lib.path) : 'flat',
      dirGroup: lib ? DB.libDirGroup(db, lib.path) : false
    });
  }
  if (p === '/api/libs') {
    const a = userActiveLib(uid);
    return json(res, { active: a ? a.id : null, multi: MULTI, libs: libsView(uid, me && me.role === 'admin') });
  }
  if (p === '/api/activate') {
    const id = u.searchParams.get('id') || '';
    if (!DB.setActiveLib(db, uid, id)) return send(res, 400, 'unknown lib');
    const a = userActiveLib(uid);
    return json(res, { active: a ? a.id : null, libs: libsView(uid, me && me.role === 'admin') });
  }
  if (p === '/api/meta') {
    const lib = userActiveLib(uid);
    /* GET：整份快照（分类 / 专辑整理 / 进度 / 时长），字段和老的 .fm-meta.json 对齐 */
    if (req.method === 'GET') {
      if (!lib) return json(res, { empty: true });
      ensureMetaMigrated(lib);
      /* lastTrack 是「这个用户在这个库」的最后收听，不算库属性：
         新用户登录时它是空的，前端就不会凭空显示底栏 */
      return json(res, Object.assign(DB.metaSnapshot(db, lib.path), {
        lastTrack: DB.userLastTrack(db, uid, lib.id)
      }));
    }
    if (req.method !== 'POST') return send(res, 405, 'GET or POST only');
    /* 单独一档额度：拖拽归类 + 进度上报同时来的时候，别互相把额度吃掉 */
    if (!writeAllowed(ip, 20, 'meta')) return send(res, 429, 'too many writes');
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 512 * 1024) return send(res, 413, 'too large');
    }
    let patch = null;
    try { patch = JSON.parse(body); } catch (e) { return send(res, 400, 'bad json'); }
    if (!patch || typeof patch !== 'object') return send(res, 400, 'bad json');
    /* 分类与专辑整理是整库共享的编辑操作：普通用户只能写自己的进度/时长，不能改归类 */
    if (!me || me.role !== 'admin') {
      if (patch.cats !== undefined || patch.catsDeleted !== undefined || patch.albumMeta !== undefined ||
          patch.dirCatDropped !== undefined) {
        return send(res, 403, '只有管理员可以编辑分类与整理');
      }
    }
    /* 只认自己名下的库；没带 libId 就落到当前库 */
    const target = userLibs(uid).find(function (l) { return l.id === patch.libId; }) || lib;
    if (!target) return send(res, 404, 'no library');
    ensureMetaMigrated(target);
    try {
      const counts = DB.metaApply(db, target.path, patch);
      /* 「上次收听」按用户存（不是库属性），普通用户也能写自己的 */
      if (typeof patch.lastTrack === 'string' && patch.lastTrack) {
        DB.setUserLastTrack(db, uid, target.id, patch.lastTrack);
      }
      return json(res, { ok: true, counts: counts });
    }
    catch (e) { console.log('[meta] 写入失败：' + e.message); return send(res, 500, 'write failed'); }
  }
  if (p === '/api/progress') {
    if (req.method !== 'POST') return send(res, 405, 'POST only');
    if (!writeAllowed(ip, 10, 'progress')) return send(res, 429, 'too many writes');
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
    if (!lib) return send(res, 404, 'no library');
    /* 只是往库里 upsert 一行，几毫秒就完事，不用再攒批写文件 */
    const one = {};
    one[String(rec.id)] = {
      p: Math.round(p2 * 100) / 100,
      d: isFinite(d2) && d2 > 0 ? Math.round(d2 * 100) / 100 : 0,
      t: Number(rec.t) || Date.now(),
      done: !!rec.done
    };
    try {
      ensureMetaMigrated(lib);
      DB.metaApply(db, lib.path, { progress: one });
    } catch (e) {
      console.log('[progress] 写入失败：' + e.message);
      return send(res, 500, 'write failed');
    }
    return json(res, { ok: true });
  }
  if (p === '/api/favs') {
    const own = function (id) { return userLibs(uid).some(function (l) { return l.id === id; }); };
    if (req.method === 'GET') {
      const libId = u.searchParams.get('libId') || (userActiveLib(uid) || {}).id;
      if (!libId) return json(res, { ids: [] });
      const lib = userLibs(uid).find(function (l) { return l.id === libId; });
      if (!lib) return send(res, 403, 'unknown lib');
      return json(res, { libId: libId, ids: DB.listFavs(db, uid, libId), trackIds: DB.listFavTracks(db, uid, libId) });
    }
    if (req.method !== 'POST') return send(res, 405, 'GET/POST only');
    /* 连续收藏专辑是正常操作，给比进度上报更宽的额度 */
    if (!writeAllowed(ip, 20, 'fav')) return send(res, 429, 'too many writes');
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 1024) return send(res, 413, 'too large'); }
    let rec = null;
    try { rec = JSON.parse(body); } catch (e) { return send(res, 400, 'bad json'); }
    const libId = String((rec && rec.libId) || (userActiveLib(uid) || {}).id || '');
    const albumId = String((rec && rec.albumId) || '');
    const trackId = String((rec && rec.trackId) || '');
    if (!libId || (!albumId && !trackId) || albumId.length > 64 || trackId.length > 64) return send(res, 400, 'bad fav');
    if (!own(libId)) return send(res, 403, 'unknown lib');
    if (trackId) DB.setFavTrack(db, uid, libId, trackId, !!(rec && rec.fav));
    else DB.setFav(db, uid, libId, albumId, !!(rec && rec.fav));
    return json(res, { ok: true, fav: !!(rec && rec.fav) });
  }
  if (p === '/api/lib') {
    if (req.method !== 'POST') return send(res, 405, 'POST only');
    /* 多用户时只有管理员能改资源库：add 接受任意绝对路径，不能让普通用户随便挂服务器目录 */
    if (MULTI && (!me || me.role !== 'admin')) return send(res, 403, '只有管理员能修改资源库');
    if (!writeAllowed(ip)) return send(res, 429, 'too many writes');
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) return send(res, 413, 'too large');
    }
    let payload = null;
    try { payload = JSON.parse(body); } catch (e) { return send(res, 400, 'bad json'); }
    const act = String((payload && payload.action) || '');
    /* 共享：把自己名下可编辑的库指派给「所有人 / 指定用户」。
       只写共享关系、不碰主机目录，所以不受 --allow-lib-edit 限制。 */
    if (act === 'share') {
      const libId = String((payload && payload.id) || '');
      const lib = DB.getLib(db, uid, libId);
      if (!lib || lib.shared_id) return send(res, 400, '资源库不存在');
      const targetAll = !!(payload && payload.targetAll);
      /* 去掉自己（源库所有者不需要「共享给自己」）并去重 */
      const userIds = ((payload && Array.isArray(payload.userIds)) ? payload.userIds : [])
        .filter(function (x) { return typeof x === 'string' && x && x !== uid; })
        .filter(function (x, i, arr) { return arr.indexOf(x) === i; });
      DB.setLibShare(db, libId, targetAll, userIds);
      DB.syncUserSharedLibs(db, uid);
      console.log('[lib] 共享「' + lib.name + '」→ ' + (targetAll ? '所有人' : userIds.length + ' 位用户'));
      const a = userActiveLib(uid);
      return json(res, { active: a ? a.id : null, multi: MULTI, libs: libsView(uid, true) });
    }
    if (!ALLOW_LIB_EDIT) return send(res, 403, '服务端未开启资源库编辑（启动时加 --allow-lib-edit）');
    const r = mutateLibs(uid, payload || {});
    if (r.code !== 200) return send(res, r.code, r.msg);
    const a = userActiveLib(uid);
    return json(res, { active: a ? a.id : null, multi: MULTI, libs: libsView(uid, me && me.role === 'admin') });
  }
  /* 「目录结构」三档开关：只改 fm.db 里的一条元数据，不碰主机目录，
     所以不受 --allow-lib-edit 限制；登录用户只能改自己名下的库。
     body 用 mode（flat/cat/auto）；老客户端传 on 布尔，照旧按 二级/默认 处理 */
  if (p === '/api/libdirgroup') {
    if (req.method !== 'POST') return send(res, 405, 'POST only');
    if (!me || me.role !== 'admin') return send(res, 403, '只有管理员可以修改目录结构');
    if (!writeAllowed(ip)) return send(res, 429, 'too many writes');
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1024) return send(res, 413, 'too large');
    }
    let payload = null;
    try { payload = JSON.parse(body); } catch (e) { return send(res, 400, 'bad json'); }
    const id = String((payload && payload.id) || '');
    const lib = userLibs(uid).find(function (l) { return l.id === id; });
    if (!lib) return send(res, 403, 'unknown lib');
    const mode = payload && payload.mode !== undefined
      ? DB.setLibDirMode(db, lib.path, payload.mode)
      : DB.setLibDirMode(db, lib.path, (payload && payload.on) ? 'cat' : 'flat');
    return json(res, { ok: true, id: lib.id, dirMode: mode, dirGroup: mode !== 'flat' });
  }
  /* 只回扫描缓存的时间戳（一行 settings，几毫秒）：手机端没有扫描入口，
     靠它判断「主机上是不是有人扫过更新的」，有就静默重新读 /api/scan 的缓存 */
  if (p === '/api/scan/at') {
    const root = userActiveRoot(uid);
    if (!root) return json(res, { scannedAt: 0 });
    let at = 0;
    try { at = Number(DB.getSetting(db, scanKey(root) + ':at', '0')) || 0; } catch (e) {}
    return json(res, { scannedAt: at });
  }
  if (p === '/api/scan') {
    const root = userActiveRoot(uid);
    if (!root) return send(res, 404, 'server mode off');
    try {
      /* refresh=1 只有前端「重新扫描」会带；平时一律读缓存，别让每台设备每个用户各扫一遍 */
      const refresh = u.searchParams.get('refresh') === '1';
      /* 拷一份再往上加字段：缓存里的对象别被改动 */
      const data = Object.assign({}, await scanFolder(root, { refresh: refresh }));
      const a = userActiveLib(uid);
      data.libId = a ? a.id : null;
      /* 目录结构跟着扫描结果一起下发，前端不用再单独取一次 */
      data.dirMode = DB.libDirMode(db, root);
      data.dirGroup = DB.libDirGroup(db, root);
      /* 封面不再扫描时自动拉取：交给用户在网页「编辑封面」里手动上传/抓取/删除 */
      return json(res, data);
    } catch (e) {
      /* 别把 e.message 原样回给客户端：里面常带磁盘绝对路径 */
      console.log('[scan] 扫描失败：' + e.message);
      return send(res, 500, 'scan failed');
    }
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
  /* 手动编辑封面：搜索候选 / 保存 / 删除（前端编辑封面弹窗调用，点保存才落到磁盘） */
  if (p === '/api/covers/search') {
    const root = userActiveRoot(uid);
    if (!root) return send(res, 404, 'server mode off');
    if (!me || me.role !== 'admin') return send(res, 403, '只有管理员可以编辑封面');
    try { return json(res, await covers.searchCandidates(u.searchParams.get('q') || '', 4)); }
    catch (e) { return json(res, []); }
  }
  if (p === '/api/cover' && req.method === 'POST') {
    const root = userActiveRoot(uid);
    if (!root) return send(res, 404, 'server mode off');
    if (!me || me.role !== 'admin') return send(res, 403, '只有管理员可以编辑封面');
    if (!writeAllowed(ip, 10, 'cover')) return send(res, 429, 'too many writes');
    /* 上传的图片走 dataUrl，2MB 的图 base64 之后约 2.8MB，留点余量卡在 4MB */
    const MAX_COVER_BODY = 4 * 1024 * 1024;
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_COVER_BODY) return send(res, 413, 'too large');
    }
    let payload;
    try { payload = JSON.parse(body); } catch (e) { return send(res, 400, 'bad json'); }
    if (!payload || !payload.dirName) return send(res, 400, 'missing dirName');
    try {
      const entry = await covers.saveCoverForDir(root, payload.dirName, payload.payload || {});
      return json(res, { ok: true, entry: entry });
    } catch (e) {
      console.log('[cover] 保存失败：' + e.message);
      return send(res, 500, 'save failed');
    }
  }
  if (p === '/api/cover' && req.method === 'DELETE') {
    const root = userActiveRoot(uid);
    if (!root) return send(res, 404, 'server mode off');
    if (!me || me.role !== 'admin') return send(res, 403, '只有管理员可以编辑封面');
    let dir = u.searchParams.get('dir') || '';
    if (!dir && req.method === 'POST') {
      let b2 = '';
      for await (const chunk of req) {
        b2 += chunk;
        if (b2.length > 4096) return send(res, 413, 'too large');
      }
      try { dir = (JSON.parse(b2) || {}).dirName || ''; } catch (e) {}
    }
    if (!dir) return send(res, 400, 'missing dir');
    await covers.removeCover(root, dir);
    return json(res, { ok: true });
  }

  if (p.indexOf('/api/media/') === 0) {
    const root = userActiveRoot(uid);
    if (!root) return send(res, 404, 'server mode off');
    return serveMedia(req, res, p.slice('/api/media/'.length), root);
  }

  /* ── 转码：Chromium 认不全的 flv 容器先重封装成 mp4 再播 ──
     转换是 CPU 活，长视频可能要几十秒，所以先让前端拿一个「准备好了」的应答，
     再自己去 /api/tc/<name> 拉流；请求期间保持连接，前端只显示「正在转换」。 */
  if (p === '/api/prepare') {
    if (req.method !== 'POST') return send(res, 405, 'POST only');
    const root = userActiveRoot(uid);
    if (!root) return send(res, 404, 'server mode off');
    if (!writeAllowed(ip, 5, 'tc')) return send(res, 429, 'too many requests');
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) return send(res, 413, 'too large');
    }
    let rel = '';
    try { rel = String((JSON.parse(body) || {}).rel || ''); } catch (e) { return send(res, 400, 'bad json'); }
    if (!rel) return send(res, 400, 'missing rel');
    const ext = path.extname(rel).slice(1).toLowerCase();
    if (!TC.needs(ext) || !MEDIA_EXT.has(ext)) return send(res, 400, 'bad format');
    let file;
    try { file = inside(root, rel); } catch (e) { return send(res, 403, 'forbidden'); }
    let st;
    try { st = await fsp.stat(file); } catch (e) { return send(res, 404, 'not found'); }
    if (!st.isFile()) return send(res, 404, 'not found');
    /* 客户端切走了就没人要这个文件：连接一断就把请求当成取消信号，转码内核会把
       排队中/正在跑的任务一起停掉。不这么做的话，一个 40 集的 flv 专辑连点几集，
       会排出一长串没人要的转码任务，还白占 HTTP 连接（同域只有 6 条）。 */
    const ctrl = new AbortController();
    /* 盯 res 的 close：req 的 'close' 在请求体读完时就会触发一次（Node 16 起语义变了），
       而那时我们才刚开始 await，注册上去已经错过；res 在响应结束前不会 close，
       客户端中途断开必然触发它。 */
    const onGone = function () { if (!res.writableEnded) ctrl.abort(); };
    res.on('close', onGone);
    try {
      const r = await TC.prepare({ file: file, rel: rel, stat: st, cacheDir: tcDir(), signal: ctrl.signal });
      return json(res, { url: '/api/tc/' + path.basename(r.file), ext: r.ext, cached: r.cached });
    } catch (err) {
      /* 连接已经断了（或者就是被我们取消的）：没人在等这个响应 */
      if (!err || err.code === 'aborted' || res.destroyed || res.writableEnded) return;
      console.log('[tc] 准备失败 ' + rel + '：' + err.message);
      /* 501 让前端能一眼区分「服务器没装 ffmpeg」和「文件转不动」 */
      return send(res, err.code === 'no-ffmpeg' ? 501 : 500, err.code || 'ffmpeg-failed');
    } finally {
      res.off('close', onGone);
    }
  }

  if (p.indexOf('/api/tc/') === 0) return serveTc(req, res, p.slice('/api/tc/'.length));

  /* 时长探测：只读文件头不转码，前端给 wma/flv 这类曲目算时长用 */
  if (p === '/api/duration') {
    const root = userActiveRoot(uid);
    if (!root) return send(res, 404, 'server mode off');
    const rel = u.searchParams.get('rel') || '';
    if (!rel) return send(res, 400, 'missing rel');
    let file;
    try { file = inside(root, rel); } catch (e) { return send(res, 403, 'forbidden'); }
    return json(res, { d: await TC.probeDuration(file) });
  }

  const rel = p === '/' ? 'index.html' : p.replace(/^[/]+/, '');
  if (!/^(index[.]html|css[/]|js[/]|build[/])/.test(rel)) return send(res, 404, 'not found');
  let file;
  try { file = inside(APP_ROOT, rel); } catch (e) { return send(res, 403, 'forbidden'); }
  try {
    const st = await fsp.stat(file);
    /* index.html 决定 css/js 的版本号：可以缓存，但每次都要回源校验。
       etag 里已经带了资源指纹，HTML 和资源都没变就是 304，手机端每次启动只多一个 RTT，不重下整页 */
    const ver = rel === 'index.html' ? await assetsVersion() : '';
    const cc = 'no-cache';
    /* 内容没变就别重发：ETag 用 size+mtime，比每次算哈希便宜；no-cache 让浏览器每次回来问一句 */
    const tag = st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + (ver ? '-' + ver : '');
    const etag = 'W/"' + tag + '"';
    const inm = String(req.headers['if-none-match'] || '');
    if (inm && (inm === etag || inm === '*')) {
      res.writeHead(304, { 'etag': etag, 'cache-control': cc });
      return res.end();
    }
    let buf = await fsp.readFile(file);
    /* 把 index.html 里 css/js 的 ?v= 换成内容指纹：文件一改 URL 就变，安卓 WebView 不会再拿旧样式 */
    if (ver) buf = Buffer.from(buf.toString('utf8').replace(/(\.(?:css|js))\?v=[\w.-]*/g, '$1?v=' + ver));
    return send(res, 200, buf, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'etag': etag,
      'cache-control': cc,
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

/* 进度现在是同步写库（一次事务），退出不用再补落盘；关掉数据库连接即可 */
function shutdown() {
  try { db.close(); } catch (e) {}
  process.exit(0);
}
['SIGINT', 'SIGTERM'].forEach(function (sig) { process.on(sig, shutdown); });

/* 兜底：http handler 是 async 的，单条请求里漏网的异常会变成 unhandledRejection，
   Node 默认会直接退出进程。家用媒体服务宁可记日志也不要被一个坏请求带崩。 */
process.on('unhandledRejection', function (e) {
  console.log('[unhandledRejection] ' + ((e && e.stack) || e));
});

server.listen(port, host, function () {
  const users = DB.listUsers(db);
  console.log('星海 FM · http://' + host + ':' + port + '/');
  console.log('数据库 · ' + dataFilePath() + '（用户 ' + users.length + ' 个' + (NO_AUTH ? '，--no-auth 免密' : '') + '）');
  users.forEach(function (u) {
    const libs = DB.listLibs(db, u.id);
    console.log('  ' + (u.role === 'admin' ? '*' : ' ') + ' ' + u.username + '  资源库 ' + libs.length + ' 个');
  });
  if (DEBUG_REQ) console.log('调试日志已开（FM_DEBUG=1）：/api/media、/api/progress 等逐个记一行');
  const ff = TC.findFfmpeg();
  if (ff) console.log('ffmpeg · ' + ff);
  else {
    console.log('ffmpeg · 未找到，flv 将无法播放');
    console.log('  安装：macOS「brew install ffmpeg」｜Debian/Ubuntu「sudo apt install ffmpeg」');
    console.log('  装过仍报这个（常见于 launchd / GUI 启动，PATH 里没有 brew 目录）：');
    console.log('    FM_FFMPEG=/opt/homebrew/bin/ffmpeg node tools/serve.js');
    console.log(TC.explain());
  }
  /* 转码缓存清理：翻目录和首屏不抢 IO，延后几秒再做 */
  setTimeout(function () {
    TC.sweep(tcDir(), TC.DEFAULT_MAX).catch(function () {});
  }, 8000);
});
