/* ── db.js · SQLite 数据层（node:sqlite） ─────────────────
 * 单一 fm.db 存 users / libs / remote / settings / favs，以及「库元数据」
 * （分类 cats、专辑整理 album_meta、播放进度 progress、时长 durations）。
 * Electron 主进程与 serve.js 共用本模块（各自独立连接，WAL + busy_timeout 保证并发）。
 * 注意：node:sqlite 是 Node 内置实验 API，首次 require 会打印 ExperimentalWarning，可忽略。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 5;
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
    /* 共享：NULL = 用户自己的库；非 NULL = 由别人共享来的只读副本，值是源库 id */
    '  shared_id TEXT,',
    '  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_libs_user ON libs(user_id, position);',
    /* 共享配置挂在「源库」上：target_all=1 表示所有人，否则看 lib_share_targets */
    'CREATE TABLE IF NOT EXISTS lib_shares (',
    '  lib_id TEXT PRIMARY KEY,',
    '  target_all INTEGER NOT NULL DEFAULT 0',
    ');',
    'CREATE TABLE IF NOT EXISTS lib_share_targets (',
    '  lib_id TEXT NOT NULL,',
    '  user_id TEXT NOT NULL,',
    '  PRIMARY KEY (lib_id, user_id)',
    ');',
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
    ');',
    'CREATE TABLE IF NOT EXISTS fav_tracks (',
    '  user_id TEXT NOT NULL,',
    '  lib_id TEXT NOT NULL,',
    '  track_id TEXT NOT NULL,',
    '  created_at INTEGER NOT NULL,',
    '  PRIMARY KEY (user_id, lib_id, track_id),',
    '  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
    ');',
    /* v5：库元数据（分类 / 专辑整理 / 进度 / 时长）。
       键是「库目录路径」而不是 lib_id —— 同一个目录可能被不同用户登记成不同 lib_id，
       而分类、置顶、进度是这个资源库的属性，按路径共享才符合预期。 */
    'CREATE TABLE IF NOT EXISTS cats (',
    '  lib_root TEXT NOT NULL,',
    '  id TEXT NOT NULL,',
    "  name TEXT NOT NULL DEFAULT '',",
    "  color TEXT NOT NULL DEFAULT '',",
    '  position INTEGER NOT NULL DEFAULT 0,',
    '  created_at INTEGER NOT NULL,',
    '  PRIMARY KEY (lib_root, id)',
    ');',
    'CREATE TABLE IF NOT EXISTS album_meta (',
    '  lib_root TEXT NOT NULL,',
    '  album_key TEXT NOT NULL,',
    "  cats TEXT NOT NULL DEFAULT '[]',",
    "  title TEXT NOT NULL DEFAULT '',",
    '  pinned INTEGER NOT NULL DEFAULT 0,',
    '  hidden INTEGER NOT NULL DEFAULT 0,',
    '  updated_at INTEGER NOT NULL,',
    '  PRIMARY KEY (lib_root, album_key)',
    ');',
    'CREATE TABLE IF NOT EXISTS progress (',
    '  lib_root TEXT NOT NULL,',
    '  track_id TEXT NOT NULL,',
    '  p REAL NOT NULL DEFAULT 0,',
    '  d REAL NOT NULL DEFAULT 0,',
    '  done INTEGER NOT NULL DEFAULT 0,',
    '  t INTEGER NOT NULL DEFAULT 0,',
    '  PRIMARY KEY (lib_root, track_id)',
    ');',
    'CREATE TABLE IF NOT EXISTS durations (',
    '  lib_root TEXT NOT NULL,',
    '  track_id TEXT NOT NULL,',
    '  dur REAL NOT NULL DEFAULT 0,',
    '  PRIMARY KEY (lib_root, track_id)',
    ');'
  ].join('\n'));
  /* 旧库补列：token_version（改密码后让该用户旧 token 立即失效） */
  const cols = db.prepare('PRAGMA table_info(users)').all();
  if (!cols.some(function (c) { return c.name === 'token_version'; })) {
    db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
  }
  /* 旧库补列：libs.shared_id（共享来的只读库副本；老行为 NULL = 私有） */
  const libCols = db.prepare('PRAGMA table_info(libs)').all();
  if (!libCols.some(function (c) { return c.name === 'shared_id'; })) {
    db.exec('ALTER TABLE libs ADD COLUMN shared_id TEXT');
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
function removeUser(db, id) {
  const u = String(id || '');
  /* 先清与该用户相关的共享关系：他名下源库的指派、别人派给他的物化行，别留孤儿 */
  const owned = db.prepare('SELECT id FROM libs WHERE user_id = ? AND shared_id IS NULL').all(u);
  owned.forEach(function (r) {
    db.prepare('DELETE FROM lib_shares WHERE lib_id = ?').run(r.id);
    db.prepare('DELETE FROM lib_share_targets WHERE lib_id = ?').run(r.id);
    db.prepare('DELETE FROM libs WHERE shared_id = ?').run(r.id);
  });
  db.prepare('DELETE FROM lib_share_targets WHERE user_id = ?').run(u);
  db.prepare('DELETE FROM libs WHERE user_id = ?').run(u);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}
function touchLogin(db, id) { db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), id); }

/* ── libs（按用户） ── */
function listLibs(db, uid) {
  return db.prepare('SELECT id, name, path, added_at AS addedAt, active, shared_id FROM libs WHERE user_id = ? ORDER BY position, added_at').all(uid);
}
function activeLib(db, uid) {
  return db.prepare('SELECT id, name, path, added_at AS addedAt, shared_id FROM libs WHERE user_id = ? AND active = 1 LIMIT 1').get(uid)
    || db.prepare('SELECT id, name, path, added_at AS addedAt, shared_id FROM libs WHERE user_id = ? ORDER BY position, added_at LIMIT 1').get(uid)
    || null;
}
function replaceLibs(db, uid, libs, activeId) {
  const list = (libs || []).filter(function (l) { return l && typeof l.path === 'string' && l.path; });
  let active = activeId;
  if (!list.some(function (l) { return l.id === active; })) active = list[0] ? list[0].id : null;
  db.exec('BEGIN');
  try {
    /* 只替换用户自己的库；共享来的只读副本（shared_id 非空）不归这里的增删逻辑管 */
    db.prepare('DELETE FROM libs WHERE user_id = ? AND shared_id IS NULL').run(uid);
    const ins = db.prepare('INSERT INTO libs(id, user_id, name, path, added_at, active, position) VALUES(?,?,?,?,?,?,?)');
    list.forEach(function (l, i) {
      ins.run(l.id || ('l' + Date.now().toString(36) + i), uid, l.name || path.basename(l.path) || '资源库', l.path, l.addedAt || Date.now(), l.id === active ? 1 : 0, i);
    });
    db.exec('COMMIT');
    return { active: active };
  } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) {} throw e; }
}
function getLib(db, uid, id) {
  return db.prepare('SELECT id, name, path, added_at AS addedAt, active, shared_id FROM libs WHERE user_id = ? AND id = ?')
    .get(String(uid || ''), String(id || '')) || null;
}
/* 元数据是按库目录共享的：只要这个用户登记过同一个目录，就认同一个库
   （换账号/换设备登记同一目录时，分类与进度不至于各存一份） */
function libPath(db, id) {
  const r = db.prepare('SELECT path FROM libs WHERE id = ? ORDER BY added_at LIMIT 1').get(String(id || ''));
  return r && r.path ? r.path : null;
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

/* ── 共享：把某个库指派给其它用户（配置挂在源库上） ──
   目标用户看到的是本表里一条 shared_id=源库id 的只读副本，由 syncUserSharedLibs 物化。 */
function listShares(db, libId) {
  const id = String(libId || '');
  if (!id) return null;
  const row = db.prepare('SELECT target_all FROM lib_shares WHERE lib_id = ?').get(id);
  if (!row) return null;
  const targets = db.prepare('SELECT user_id FROM lib_share_targets WHERE lib_id = ?').all(id)
    .map(function (r) { return r.user_id; });
  return { targetAll: !!row.target_all, targets: targets };
}
function setLibShare(db, libId, targetAll, userIds) {
  const id = String(libId || '');
  if (!id) return false;
  const all = !!targetAll;
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO lib_shares(lib_id, target_all) VALUES(?,?) ON CONFLICT(lib_id) DO UPDATE SET target_all = excluded.target_all')
      .run(id, all ? 1 : 0);
    db.prepare('DELETE FROM lib_share_targets WHERE lib_id = ?').run(id);
    if (!all) {
      const ins = db.prepare('INSERT OR IGNORE INTO lib_share_targets(lib_id, user_id) VALUES(?,?)');
      (userIds || []).forEach(function (u) { if (u && String(u) !== '') ins.run(id, String(u)); });
    }
    db.exec('COMMIT');
    return true;
  } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) {} throw e; }
}
/* 取消共享 / 源库被删：连带清掉所有目标用户手里的只读副本 */
function removeLibShare(db, libId) {
  const id = String(libId || '');
  if (!id) return 0;
  db.prepare('DELETE FROM lib_shares WHERE lib_id = ?').run(id);
  db.prepare('DELETE FROM lib_share_targets WHERE lib_id = ?').run(id);
  return db.prepare('DELETE FROM libs WHERE shared_id = ?').run(id).changes || 0;
}
/* 把「指派给该用户」的源库物化进他的 libs（只读副本），并清理已撤销的副本。
   幂等；O(共享库数)，每个请求跑一次开销可忽略。 */
function syncUserSharedLibs(db, uid) {
  const u = String(uid || '');
  if (!u) return;
  const shared = db.prepare(
    'SELECT lib_id FROM lib_shares WHERE target_all = 1 ' +
    'UNION SELECT lib_id FROM lib_share_targets WHERE user_id = ?'
  ).all(u).map(function (r) { return r.lib_id; });

  const keep = {};
  shared.forEach(function (libId) {
    const src = db.prepare('SELECT id, user_id, name, path FROM libs WHERE id = ? AND shared_id IS NULL').get(libId);
    if (!src) return;
    if (src.user_id === u) return;            /* 源库所有者本人：已有可编辑行，不再复制一份 */
    keep[libId] = true;
    const row = db.prepare('SELECT id, name, path FROM libs WHERE user_id = ? AND shared_id = ? LIMIT 1').get(u, libId);
    if (row) {
      if (row.name !== src.name || row.path !== src.path) {
        db.prepare('UPDATE libs SET name = ?, path = ? WHERE id = ?').run(src.name, src.path, row.id);
      }
      return;
    }
    const anyActive = db.prepare('SELECT 1 FROM libs WHERE user_id = ? AND active = 1 LIMIT 1').get(u);
    const pos = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM libs WHERE user_id = ?').get(u) || {}).p || 0;
    const rid = 'sh' + libId + u;
    /* OR IGNORE：同一用户并发请求可能同时物化同一条，id 是确定的，靠主键去重即可 */
    db.prepare('INSERT OR IGNORE INTO libs(id, user_id, name, path, added_at, active, position, shared_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(rid, u, src.name, src.path, Date.now(), anyActive ? 0 : 1, pos, libId);
  });

  /* 撤销指派：删掉不再被指派、且非当前激活的副本（正在听的那条留到切走再清，别中途抽走） */
  db.prepare('SELECT id, shared_id, active FROM libs WHERE user_id = ? AND shared_id IS NOT NULL').all(u).forEach(function (r) {
    if (keep[r.shared_id]) return;
    if (r.active) return;
    db.prepare('DELETE FROM libs WHERE id = ?').run(r.id);
  });
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

/* ── 曲目收藏（按用户 + 资源库 + 曲目 id） ── */
function listFavTracks(db, uid, libId) {
  return db.prepare('SELECT track_id FROM fav_tracks WHERE user_id = ? AND lib_id = ? ORDER BY created_at')
    .all(String(uid || ''), String(libId || '')).map(function (r) { return r.track_id; });
}
function setFavTrack(db, uid, libId, trackId, on) {
  const u = String(uid || ''), l = String(libId || ''), t = String(trackId || '');
  if (!u || !l || !t) return false;
  if (on) {
    db.prepare('INSERT INTO fav_tracks(user_id, lib_id, track_id, created_at) VALUES(?,?,?,?) ON CONFLICT(user_id, lib_id, track_id) DO NOTHING')
      .run(u, l, t, Date.now());
  } else {
    db.prepare('DELETE FROM fav_tracks WHERE user_id = ? AND lib_id = ? AND track_id = ?').run(u, l, t);
  }
  return true;
}
function clearFavTracks(db, uid, libId) {
  if (!uid || !libId) return 0;
  return db.prepare('DELETE FROM fav_tracks WHERE user_id = ? AND lib_id = ?').run(String(uid), String(libId)).changes || 0;
}

/* 资源库被移除时顺手清掉它的收藏，避免残留孤儿行 */
function clearFavs(db, uid, libId) {
  if (!uid || !libId) return 0;
  const n = db.prepare('DELETE FROM favs WHERE user_id = ? AND lib_id = ?').run(String(uid), String(libId)).changes || 0;
  clearFavTracks(db, uid, libId);
  return n;
}

/* ── 库元数据：分类 / 专辑整理 / 进度 / 时长 ──
   以前存在库目录的 .fm-meta.json 里，两端各写整份快照、靠 mtime+size 乐观并发避免互相覆盖；
   现在统一进 fm.db，一次事务只写变化的那部分，桌面端 / 网页端 / 手机端看到的是同一份。
   .fm-meta.json 降级为「导出快照」（只写不读），方便排查和回滚。 */
const META_VERSION = 3;
const META_LIMIT = { cats: 200, albumMeta: 500, progress: 500, durations: 500 };

/* 库目录规范化：Windows / macOS 默认都大小写不敏感，反斜杠/正斜杠混用；
   不统一的话同一目录换个大小写写法就会存成两条库（分类、进度各看各的）。 */
function libRootKey(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  let out = s;
  if (path.isAbsolute(s)) { try { out = path.resolve(s); } catch (e) {} }
  out = out.replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32' || process.platform === 'darwin') out = out.toLowerCase();
  return out;
}

/* ── 库级开关：目录结构 ──
   和分类/整理元数据一样按库根路径共享，桌面端、服务端、手机端读到的是同一份。
   三档（存 settings.dirgroup:<root>）：
     '0'    默认：每个文件夹 = 一张专辑（历史值，等同于 flat）
     '1'    二级目录：一级文件夹 = 分类，二级 = 专辑（历史布尔值，等同于 cat）
     'auto' 自动检测：一级文件夹当分类，专辑层按目录内容判断
   老版本写进去的是 '0'/'1'，这里原样识别，不需要迁移脚本。 */
const DIR_MODES = ['flat', 'cat', 'auto'];
function normDirMode(v) {
  if (v === 'cat' || v === 'auto' || v === 'flat') return v;
  return 'flat';
}
function libDirMode(db, root) {
  const key = libRootKey(root);
  if (!key) return 'flat';
  const raw = String(getSetting(db, 'dirgroup:' + key, '0'));
  if (raw === 'auto') return 'auto';
  if (raw === '1' || raw === 'cat') return 'cat';
  return 'flat';
}
function setLibDirMode(db, root, mode) {
  const key = libRootKey(root);
  if (!key) return 'flat';
  const m = normDirMode(mode);
  setSetting(db, 'dirgroup:' + key, m === 'flat' ? '0' : (m === 'cat' ? '1' : 'auto'));
  return m;
}
/* 老接口：只区分「是否按分类分组」。auto 也算「不是平铺」，老调用方据此走分类分支 */
function libDirGroup(db, root) { return libDirMode(db, root) !== 'flat'; }
function setLibDirGroup(db, root, on) { return setLibDirMode(db, root, on ? 'cat' : 'flat') !== 'flat'; }

function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (e2) {} throw e; }
}

/* ── 分类 ── */
function catsList(db, root) {
  const key = libRootKey(root);
  if (!key) return [];
  return db.prepare('SELECT id, name, color, position, created_at FROM cats WHERE lib_root = ? ORDER BY position, created_at')
    .all(key).map(function (r) {
      return { id: r.id, name: r.name, color: r.color || '', order: r.position };
    });
}
function catsWrite(db, key, list) {
  /* 按 id upsert，不做整份 DELETE：多端并发加分类时，后进的批次只会补上自己新增的，
     不会把别端刚加的分类整份覆盖掉（albumMeta/progress 本来就是 key 级合并，这里对齐）。
     代价：某一端主动删掉的分类不会跨端传播——对个人单用户多端「一次只在一端改」可接受，
     需要的全量覆盖走 catsReplace。 */
  const up = db.prepare('INSERT INTO cats(lib_root, id, name, color, position, created_at) VALUES(?,?,?,?,?,?) ' +
    'ON CONFLICT(lib_root, id) DO UPDATE SET name=excluded.name, color=excluded.color, position=excluded.position, created_at=excluded.created_at');
  const arr = (Array.isArray(list) ? list : []).filter(function (c) { return c && c.id; }).slice(0, META_LIMIT.cats);
  arr.forEach(function (c, i) {
    /* order 可能是 0（第一个分类），不能用 || 兜底 */
    const ord = c.order === undefined || c.order === null || c.order === '' ? i : (Number(c.order) || 0);
    up.run(key, String(c.id), String(c.name || ''), String(c.color || ''), ord, Number(c.createdAt) || Date.now());
  });
  return arr.length;
}
/* 分类整份替换：先清掉该库现有行再 upsert，用于迁移/显式全量覆盖场景 */
function catsReplace(db, root, list) {
  const key = libRootKey(root);
  if (!key) return 0;
  return tx(db, function () {
    db.prepare('DELETE FROM cats WHERE lib_root = ?').run(key);
    return catsWrite(db, key, list);
  });
}

/* ── 专辑整理（归类 / 重命名 / 置顶 / 隐藏） ──
   键沿用客户端的 "<库路径>|<专辑目录>"，入库只留 '|' 后面的专辑目录，
   返回时再拼回同一个前缀，客户端的键规则不用改。 */
function albumKeyOf(k) {
  const s = String(k || '');
  const i = s.indexOf('|');
  return i >= 0 ? s.slice(i + 1) : s;
}
function albumMetaMap(db, root) {
  const key = libRootKey(root);
  const out = {};
  if (!key) return out;
  const prefix = String(root || '') + '|';
  db.prepare('SELECT album_key, cats, title, pinned, hidden FROM album_meta WHERE lib_root = ?').all(key).forEach(function (r) {
    let cats = [];
    try { cats = JSON.parse(r.cats || '[]'); } catch (e) { cats = []; }
    const m = { cats: Array.isArray(cats) ? cats : [] };
    if (r.title) m.title = r.title;
    if (r.pinned) m.pinned = 1;
    if (r.hidden) m.hidden = 1;
    out[prefix + r.album_key] = m;
  });
  return out;
}
function albumMetaWrite(db, key, patch) {
  if (!patch || typeof patch !== 'object') return 0;
  const del = db.prepare('DELETE FROM album_meta WHERE lib_root = ? AND album_key = ?');
  const up = db.prepare('INSERT INTO album_meta(lib_root, album_key, cats, title, pinned, hidden, updated_at) VALUES(?,?,?,?,?,?,?) ' +
    'ON CONFLICT(lib_root, album_key) DO UPDATE SET cats=excluded.cats, title=excluded.title, pinned=excluded.pinned, hidden=excluded.hidden, updated_at=excluded.updated_at');
  let n = 0;
  Object.keys(patch).slice(0, META_LIMIT.albumMeta).forEach(function (k) {
    const albumKey = albumKeyOf(k);
    if (!albumKey) return;
    const m = patch[k];
    if (!m) { del.run(key, albumKey); n++; return; }   /* null = 删掉这一行（取消归类/取消重命名） */
    const cats = Array.isArray(m.cats) ? m.cats.slice(0, 20) : [];
    up.run(key, albumKey, JSON.stringify(cats), String(m.title || ''), m.pinned ? 1 : 0, m.hidden ? 1 : 0, Date.now());
    n++;
  });
  return n;
}
function albumMetaUpsert(db, root, patch) {
  const key = libRootKey(root);
  if (!key) return 0;
  return tx(db, function () { return albumMetaWrite(db, key, patch); });
}

/* ── 播放进度：按 t 合并，晚到的旧上报不会把进度往回拨 ── */
function progressMap(db, root) {
  const key = libRootKey(root);
  const out = {};
  if (!key) return out;
  db.prepare('SELECT track_id, p, d, done, t FROM progress WHERE lib_root = ?').all(key).forEach(function (r) {
    out[r.track_id] = { p: r.p, d: r.d, done: !!r.done, t: r.t };
  });
  return out;
}
function progressWrite(db, key, patch) {
  if (!patch || typeof patch !== 'object') return 0;
  const up = db.prepare('INSERT INTO progress(lib_root, track_id, p, d, done, t) VALUES(?,?,?,?,?,?) ' +
    'ON CONFLICT(lib_root, track_id) DO UPDATE SET p=excluded.p, d=excluded.d, done=excluded.done, t=excluded.t ' +
    'WHERE excluded.t >= progress.t');
  let n = 0;
  Object.keys(patch).slice(0, META_LIMIT.progress).forEach(function (id) {
    const b = patch[id];
    if (!id || !b) return;
    up.run(key, String(id), Number(b.p) || 0, Number(b.d) || 0, b.done ? 1 : 0, Number(b.t) || 0);
    n++;
  });
  return n;
}
function progressUpsert(db, root, patch) {
  const key = libRootKey(root);
  if (!key) return 0;
  return tx(db, function () { return progressWrite(db, key, patch); });
}

/* ── 时长 ── */
function durationMap(db, root) {
  const key = libRootKey(root);
  const out = {};
  if (!key) return out;
  db.prepare('SELECT track_id, dur FROM durations WHERE lib_root = ?').all(key).forEach(function (r) {
    if (r.dur > 0) out[r.track_id] = r.dur;
  });
  return out;
}
function durationWrite(db, key, patch) {
  if (!patch || typeof patch !== 'object') return 0;
  const up = db.prepare('INSERT INTO durations(lib_root, track_id, dur) VALUES(?,?,?) ' +
    'ON CONFLICT(lib_root, track_id) DO UPDATE SET dur=excluded.dur');
  let n = 0;
  Object.keys(patch).slice(0, META_LIMIT.durations).forEach(function (id) {
    const v = Number(patch[id]) || 0;
    if (!id || v <= 0) return;
    up.run(key, String(id), v);
    n++;
  });
  return n;
}
function durationUpsert(db, root, patch) {
  const key = libRootKey(root);
  if (!key) return 0;
  return tx(db, function () { return durationWrite(db, key, patch); });
}

/* ── 整份读取 / 增量写入（HTTP 与 IPC 都走这两个，保证口径一致） ── */
function metaSnapshot(db, root) {
  const r = String(root || '');
  const key = libRootKey(r);
  if (!key) return { v: META_VERSION, root: r, cats: [], albumMeta: {}, progress: {}, durations: {} };
  return {
    v: META_VERSION,
    root: r,
    cats: catsList(db, r),
    albumMeta: albumMetaMap(db, r),
    progress: progressMap(db, r),
    durations: durationMap(db, r)
  };
}
function metaApply(db, root, patch) {
  const key = libRootKey(root);
  const counts = { cats: 0, albumMeta: 0, progress: 0, durations: 0 };
  if (!key || !patch || typeof patch !== 'object') return counts;
  return tx(db, function () {
    if (Array.isArray(patch.cats)) counts.cats = catsWrite(db, key, patch.cats);
    if (patch.albumMeta && typeof patch.albumMeta === 'object') counts.albumMeta = albumMetaWrite(db, key, patch.albumMeta);
    if (patch.progress && typeof patch.progress === 'object') counts.progress = progressWrite(db, key, patch.progress);
    if (patch.durations && typeof patch.durations === 'object') counts.durations = durationWrite(db, key, patch.durations);
    return counts;
  });
}

/* ── 一次性迁移：把 .fm-meta.json 导入数据库（幂等，文件还没生成时不打标记，下次再试） ── */
function metaMigrated(db, root) { return getSetting(db, 'metaMig:' + libRootKey(root)) === '1'; }
function markMetaMigrated(db, root) { setSetting(db, 'metaMig:' + libRootKey(root), '1'); }
function migrateLegacyMeta(db, root, dir) {
  const key = libRootKey(root);
  if (!key || !dir) return 0;
  if (metaMigrated(db, root)) return 0;
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(String(dir), '.fm-meta.json'), 'utf8')); } catch (e) { return 0; }
  if (!meta) return 0;
  /* 库里已经有数据（别的端已经写过）就不再导入，避免把新数据盖回旧快照 */
  const has = db.prepare('SELECT (SELECT COUNT(*) FROM cats WHERE lib_root = ?1) + (SELECT COUNT(*) FROM album_meta WHERE lib_root = ?1) + (SELECT COUNT(*) FROM progress WHERE lib_root = ?1) AS n')
    .get(key).n || 0;
  if (has > 0) { markMetaMigrated(db, root); return 0; }
  const patch = {};
  if (Array.isArray(meta.cats)) patch.cats = meta.cats;
  const am = meta.albumMeta && typeof meta.albumMeta === 'object' ? meta.albumMeta : null;
  if (am) {
    const pick = {};
    Object.keys(am).forEach(function (k) {
      const i = k.indexOf('|');
      if (i < 0) return;                                  /* 老格式没有库前缀，认不出归属就跳过 */
      if (libRootKey(k.slice(0, i)) !== key) return;       /* 不是这个库的快照 */
      pick[k] = am[k];
    });
    if (Object.keys(pick).length) patch.albumMeta = pick;
  }
  if (meta.progress && typeof meta.progress === 'object') patch.progress = meta.progress;
  if (meta.durations && typeof meta.durations === 'object') patch.durations = meta.durations;
  const counts = metaApply(db, root, patch);
  markMetaMigrated(db, root);
  return counts;
}

/* 资源库被移除时清掉它的元数据，避免留下孤儿行 */
function clearLibMeta(db, root) {
  const key = libRootKey(root);
  if (!key) return 0;
  return tx(db, function () {
    let n = 0;
    ['cats', 'album_meta', 'progress', 'durations'].forEach(function (t) {
      n += db.prepare('DELETE FROM ' + t + ' WHERE lib_root = ?').run(key).changes || 0;
    });
    db.prepare('DELETE FROM settings WHERE key = ?').run('metaMig:' + key);
    return n;
  });
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
  listLibs, activeLib, replaceLibs, setActiveLib, getLib, libPath,
  listShares, setLibShare, removeLibShare, syncUserSharedLibs,
  listFavs, setFav, clearFavs,
  listFavTracks, setFavTrack, clearFavTracks,
  META_VERSION, META_LIMIT, libRootKey,
  libDirGroup, setLibDirGroup, libDirMode, setLibDirMode, normDirMode, DIR_MODES,
  catsList, catsReplace,
  albumMetaMap, albumMetaUpsert,
  progressMap, progressUpsert,
  durationMap, durationUpsert,
  metaSnapshot, metaApply,
  metaMigrated, markMetaMigrated, migrateLegacyMeta, clearLibMeta,
  getRemote, setRemote, migrate
};
