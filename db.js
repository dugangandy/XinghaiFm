/* ── db.js · SQLite 数据层（node:sqlite） ─────────────────
 * 单一 fm.db 存 users / libs / remote / settings。
 * Electron 主进程与 serve.js 共用本模块（各自独立连接，WAL + busy_timeout 保证并发）。
 * 注意：node:sqlite 是 Node 内置实验 API，首次 require 会打印 ExperimentalWarning，可忽略。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 4;
const ITERATIONS = 600000;
const ADMIN_ID = 'u_admin';

function open(file) {
  if (file && file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file || ':memory:');
  try { db.exec('PRAGMA journal_mode = WAL'); } catch (e) {}
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch (e) {}
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function ensureSchema(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS users (',
    '  id TEXT PRIMARY KEY,',
    '  username TEXT UNIQUE NOT NULL,',
    "  role TEXT NOT NULL DEFAULT 'user',",
    "  algo TEXT NOT NULL DEFAULT 'pbkdf2_sha256',",
    '  iterations INTEGER NOT NULL,',
    '  salt TEXT NOT NULL,',
    '  hash TEXT NOT NULL,',
    '  token_version INTEGER NOT NULL DEFAULT 0,',
    '  created_at TEXT NOT NULL,',
    '  last_login_at TEXT',
    ');',
    'CREATE TABLE IF NOT EXISTS libs (',
    '  id TEXT PRIMARY KEY,',
    '  user_id TEXT NOT NULL,',
    '  name TEXT NOT NULL,',
    '  path TEXT NOT NULL,',
    '  added_at INTEGER NOT NULL,',
    '  active INTEGER NOT NULL DEFAULT 0,',
    '  position INTEGER NOT NULL DEFAULT 0,',
    '  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_libs_user ON libs(user_id, position);',
    'CREATE TABLE IF NOT EXISTS remote (',
    '  id INTEGER PRIMARY KEY CHECK (id = 1),',
    '  base TEXT, token TEXT, uid TEXT',
    ');',
    'CREATE TABLE IF NOT EXISTS settings (',
    '  key TEXT PRIMARY KEY, value TEXT',
    ');',
    'CREATE TABLE IF NOT EXISTS favs (',
    '  user_id TEXT NOT NULL,',
    '  lib_id TEXT NOT NULL,',
    '  album_id TEXT NOT NULL,',
    '  created_at INTEGER NOT NULL,',
    '  PRIMARY KEY (user_id, lib_id, album_id),',
    '  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
    ');'
  ].join('\n'));
  /* 旧库补列：token_version（改密码后让该用户旧 token 立即失效） */
  const cols = db.prepare('PRAGMA table_info(users)').all();
  if (!cols.some(function (c) { return c.name === 'token_version'; })) {
    db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
  }
  if (!getSetting(db, 'secret')) setSetting(db, 'secret', crypto.randomBytes(32).toString('base64'));
  /* v4：favs 的主键已经覆盖 (user_id, lib_id)，早期的冗余索引清掉 */
  const uv = (db.prepare('PRAGMA user_version').get() || {}).user_version || 0;
  if (uv < 4) { try { db.exec('DROP INDEX IF EXISTS idx_favs_user'); } catch (e) {} }
  db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
}

/* ── settings ── */
function getSetting(db, key, def) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : (def === undefined ? null : def);
}
function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
function secret(db) { return getSetting(db, 'secret') || ''; }

/* ── 密码：PBKDF2-HMAC-SHA256 ── */
function derive(password, saltB64, iterations) {
  return crypto.pbkdf2Sync(String(password), Buffer.from(saltB64, 'base64'), Number(iterations) || ITERATIONS, 32, 'sha256');
}
function makePassword(password, iterations) {
  const rounds = Number(iterations) || ITERATIONS;
  const salt = crypto.randomBytes(16).toString('base64');
  return { algo: 'pbkdf2_sha256', iterations: rounds, salt: salt, hash: derive(password, salt, rounds).toString('base64') };
}
function checkPassword(user, password) {
  if (!user || !user.salt || !user.hash) return false;
  const got = derive(password, user.salt, user.iterations);
  const want = Buffer.from(user.hash, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* ── users ── */
function listUsers(db) {
  return db.prepare('SELECT id, username, role, created_at AS createdAt, last_login_at AS lastLoginAt FROM users ORDER BY created_at').all();
}
function countUsers(db) { return db.prepare('SELECT COUNT(*) AS n FROM users').get().n; }
function findUser(db, username) { return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '')) || null; }
function getUser(db, id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(String(id || '')) || null; }
function adminUser(db) {
  return db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get()
    || db.prepare('SELECT * FROM users ORDER BY created_at LIMIT 1').get() || null;
}
function firstUserId(db) { const u = db.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get(); return u ? u.id : null; }
function newUserId(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'user';
  return 'u_' + base + '_' + Math.random().toString(36).slice(2, 6);
}
function addUser(db, opts) {
  const o = opts || {};
  const pw = (o.salt && o.hash)
    ? { algo: o.algo || 'pbkdf2_sha256', iterations: o.iterations || ITERATIONS, salt: o.salt, hash: o.hash }
    : makePassword(o.password);
  const uid = o.id || newUserId(o.username);
  db.prepare('INSERT INTO users(id, username, role, algo, iterations, salt, hash, created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(uid, o.username, o.role || 'user', pw.algo, pw.iterations, pw.salt, pw.hash, o.createdAt || new Date().toISOString());
  return getUser(db, uid);
}
function setUserPassword(db, id, password) {
  const pw = makePassword(password);
  /* token_version 自增：该用户此前签发的 token 立即失效（其它用户不受影响） */
  db.prepare('UPDATE users SET algo=?, iterations=?, salt=?, hash=?, token_version = token_version + 1 WHERE id=?').run(pw.algo, pw.iterations, pw.salt, pw.hash, id);
}
function removeUser(db, id) { db.prepare('DELETE FROM users WHERE id = ?').run(id); }
function touchLogin(db, id) { db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), id); }

/* ── libs（按用户） ── */
function listLibs(db, uid) {
  return db.prepare('SELECT id, name, path, added_at AS addedAt, active FROM libs WHERE user_id = ? ORDER BY position, added_at').all(uid);
}
function activeLib(db, uid) {
  return db.prepare('SELECT id, name, path, added_at AS addedAt FROM libs WHERE user_id = ? AND active = 1 LIMIT 1').get(uid)
    || db.prepare('SELECT id, name, path, added_at AS addedAt FROM libs WHERE user_id = ? ORDER BY position, added_at LIMIT 1').get(uid)
    || null;
}
function replaceLibs(db, uid, libs, activeId) {
  const list = (libs || []).filter(function (l) { return l && typeof l.path === 'string' && l.path; });
  let active = activeId;
  if (!list.some(function (l) { return l.id === active; })) active = list[0] ? list[0].id : null;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM libs WHERE user_id = ?').run(uid);
    const ins = db.prepare('INSERT INTO libs(id, user_id, name, path, added_at, active, position) VALUES(?,?,?,?,?,?,?)');
    list.forEach(function (l, i) {
      ins.run(l.id || ('l' + Date.now().toString(36) + i), uid, l.name || path.basename(l.path) || '资源库', l.path, l.addedAt || Date.now(), l.id === active ? 1 : 0, i);
    });
    db.exec('COMMIT');
    return { active: active };
  } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) {} throw e; }
}
function setActiveLib(db, uid, id) {
  const has = db.prepare('SELECT 1 FROM libs WHERE user_id=? AND id=?').get(uid, id);
  if (!has) return false;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE libs SET active = 0 WHERE user_id = ?').run(uid);
    db.prepare('UPDATE libs SET active = 1 WHERE user_id = ? AND id = ?').run(uid, id);
    db.exec('COMMIT');
    return true;
  } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) {} return false; }
}

/* ── 收藏（按用户 + 资源库） ──
   桌面端固定 admin、服务端按登录用户；同一个专辑在不同用户/库里互不影响。 */
function listFavs(db, uid, libId) {
  return db.prepare('SELECT album_id FROM favs WHERE user_id = ? AND lib_id = ? ORDER BY created_at')
    .all(String(uid || ''), String(libId || '')).map(function (r) { return r.album_id; });
}
function setFav(db, uid, libId, albumId, on) {
  const u = String(uid || ''), l = String(libId || ''), a = String(albumId || '');
  if (!u || !l || !a) return false;
  if (on) {
    db.prepare('INSERT INTO favs(user_id, lib_id, album_id, created_at) VALUES(?,?,?,?) ON CONFLICT(user_id, lib_id, album_id) DO NOTHING')
      .run(u, l, a, Date.now());
  } else {
    db.prepare('DELETE FROM favs WHERE user_id = ? AND lib_id = ? AND album_id = ?').run(u, l, a);
  }
  /* 返回写入是否成功，而不是写入后的状态：调用方要能区分“失败”和“取消收藏” */
  return true;
}

/* 旧版收藏存在库目录 .fm-meta.json 的 albumMeta[*].fav 里：每个用户/库只搬一次。
   文件还没生成时返回 0 且不打标记，下次调用再试。 */
function favsMigrated(db, uid, libId) {
  return getSetting(db, 'favMig:' + uid + ':' + libId) === '1';
}
function markFavsMigrated(db, uid, libId) {
  setSetting(db, 'favMig:' + uid + ':' + libId, '1');
}
/* 资源库被移除时顺手清掉它的收藏，避免残留孤儿行 */
function clearFavs(db, uid, libId) {
  if (!uid || !libId) return 0;
  return db.prepare('DELETE FROM favs WHERE user_id = ? AND lib_id = ?').run(String(uid), String(libId)).changes || 0;
}
function migrateLegacyFavs(db, uid, libId, dir) {
  if (!uid || !libId || !dir) return 0;
  if (favsMigrated(db, uid, libId)) return 0;
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, '.fm-meta.json'), 'utf8')); } catch (e) { return 0; }
  if (!meta) return 0;
  const am = meta.albumMeta || {};
  const prefix = String(meta.root || dir) + '|';
  let n = 0;
  Object.keys(am).forEach(function (k) {
    if (k.indexOf(prefix) !== 0) return;
    const m = am[k];
    if (!m || !m.fav) return;
    setFav(db, uid, libId, k.slice(prefix.length), true);
    n++;
  });
  markFavsMigrated(db, uid, libId);
  return n;
}

/* ── remote（设备级） ── */
function getRemote(db) {
  const r = db.prepare('SELECT base, token, uid FROM remote WHERE id = 1').get();
  return r && r.base ? { base: r.base, token: r.token || '', uid: r.uid || null } : null;
}
function setRemote(db, cfg) {
  if (!cfg || !cfg.base) { db.prepare('DELETE FROM remote WHERE id = 1').run(); return null; }
  const data = { base: String(cfg.base).replace(/\/+$/, ''), token: String(cfg.token || ''), uid: cfg.uid || null };
  db.prepare('INSERT INTO remote(id, base, token, uid) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET base=excluded.base, token=excluded.token, uid=excluded.uid')
    .run(data.base, data.token, data.uid);
  return data;
}

/* ── 迁移：.auth.json / config.json / remote.json → db ── */
function migrate(db, opts) {
  const o = opts || {};
  const summary = { user: null, libs: 0, remote: false, skipped: false, generatedPassword: null };
  if (countUsers(db) > 0) { summary.skipped = true; return summary; }

  let auth = null;
  try { if (o.authFile && fs.existsSync(o.authFile)) auth = JSON.parse(fs.readFileSync(o.authFile, 'utf8')); } catch (e) {}
  if (auth && auth.salt && auth.hash) {
    addUser(db, { id: ADMIN_ID, username: 'admin', role: 'admin', algo: auth.algo, iterations: auth.iterations, salt: auth.salt, hash: auth.hash, createdAt: auth.createdAt });
    summary.user = 'admin';
  } else {
    const pw = crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'admin12345';
    addUser(db, { id: ADMIN_ID, username: 'admin', role: 'admin', password: pw });
    summary.user = 'admin';
    summary.generatedPassword = pw;
  }

  let cfg = null;
  try { if (o.configFile && fs.existsSync(o.configFile)) cfg = JSON.parse(fs.readFileSync(o.configFile, 'utf8')); } catch (e) {}
  let libs = [];
  if (cfg && Array.isArray(cfg.libs)) libs = cfg.libs;
  else if (cfg && cfg.root) libs = [{ name: path.basename(cfg.root), path: cfg.root }];
  libs = libs.filter(function (l) { return l && typeof l.path === 'string' && l.path; })
    .map(function (l) { return { id: l.id || ('l' + Math.random().toString(36).slice(2, 10)), name: l.name || path.basename(l.path) || '资源库', path: l.path, addedAt: l.addedAt || Date.now() }; });
  if (libs.length) { replaceLibs(db, ADMIN_ID, libs, cfg && cfg.active); summary.libs = libs.length; }

  try {
    if (o.remoteFile && fs.existsSync(o.remoteFile)) {
      const r = JSON.parse(fs.readFileSync(o.remoteFile, 'utf8'));
      if (r && r.base) { setRemote(db, { base: r.base, token: r.token || '', uid: ADMIN_ID }); summary.remote = true; }
    }
  } catch (e) {}

  return summary;
}

module.exports = {
  SCHEMA_VERSION, ITERATIONS, ADMIN_ID,
  open, ensureSchema, secret, getSetting, setSetting,
  derive, makePassword, checkPassword,
  listUsers, countUsers, findUser, getUser, adminUser, firstUserId, newUserId,
  addUser, setUserPassword, removeUser, touchLogin,
  listLibs, activeLib, replaceLibs, setActiveLib,
  listFavs, setFav, clearFavs, favsMigrated, markFavsMigrated, migrateLegacyFavs,
  getRemote, setRemote, migrate
};
