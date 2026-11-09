#!/usr/bin/env node
/* ── recalc-album-top.js · 按「已听完」节目回填专辑 Top5 ─────────────
 * 背景：album_listen 是 schema v9 新增的预聚合表，只做增量累加；v9 之前的
 * 「已听完」节目没有计入榜单，也没有回填通道。本脚本一次性把 user_progress
 * 里 done=1 的集数按单集时长 d 折算回所属专辑，按 max(现有, 重算) 只补差额。
 *
 * 口径（已与用户确认）：
 *   - 只看 done = 1；未听完的 p 不参与
 *   - 每集按其时长 d 计入；d 缺失时用 durations.dur 兜底
 *   - 仅处理指定用户（默认 admin）
 *   - 与 album_listen 现有秒数取较大值，重复执行结果一致
 *   - 不改 UI / 不改 schema / 不改在线统计链路
 *
 * 用量：F=扫描缓存文件数，P=该用户的已完成行数，A=专辑数；O(F + P + A)，
 * 不重新走盘、不访问媒体文件，所有查询都是批量 + 主键点查。
 *
 * 用法：
 *   node tools/recalc-album-top.js                    # 预览（默认 dry-run）
 *   node tools/recalc-album-top.js --apply            # 先备份，再写入
 *   node tools/recalc-album-top.js --db <路径>        # 指定 fm.db
 *   node tools/recalc-album-top.js --user <用户名|id> # 默认取 admin
 *   node tools/recalc-album-top.js --lib <libId|路径> # 只处理一个库
 *   node tools/recalc-album-top.js --mode auto        # 覆盖分组模式（flat|cat|auto）
 *   node tools/recalc-album-top.js --scan scan.json   # 补充 /api/scan 导出（可多次）
 *   node tools/recalc-album-top.js --limit 50         # 报告最多列多少张专辑
 */
'use strict';
/* 静音 node:sqlite 的 ExperimentalWarning（必须在 require 之前） */
(function () {
  const orig = process.emitWarning;
  process.emitWarning = function (w, type) {
    const t = typeof type === 'string' ? type : (type && type.type);
    if (t === 'ExperimentalWarning' || /SQLite/i.test(String(w))) return;
    return orig.apply(process, arguments);
  };
})();

const fs = require('node:fs');
const path = require('node:path');
const DB = require('../db');
const MAP = require('./album-map');

/* 单集时长上限：超过一天基本是脏数据，宁可跳过也不写进榜单 */
const MAX_D = 86400;
/* 补差阈值：不足半秒不算变化，避免浮点噪声产生无意义写入 */
const EPS = 0.5;

function defaultDb() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '星海FM', 'fm.db');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', '星海FM', 'fm.db');
  return path.join(home, '.config', '星海FM', 'fm.db');
}

function usage() {
  return [
    '用法: node tools/recalc-album-top.js [--db <路径>] [--apply] [--user <用户名|id>]',
    '                                     [--lib <libId|路径>] [--mode flat|cat|auto]',
    '                                     [--scan <json>]... [--limit <n>]',
    '',
    '默认 dry-run，只打印将要补差的专辑；确认后加 --apply 才会写库（写前自动 VACUUM INTO 备份）。'
  ].join('\n');
}

function parse(argv) {
  const a = argv || process.argv.slice(2);
  const o = { db: '', apply: false, user: '', lib: '', mode: '', scans: [], limit: 20, help: false };
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === '--db') o.db = a[++i] || '';
    else if (x === '--apply') o.apply = true;
    else if (x === '--dry-run') o.apply = false;
    else if (x === '--user') o.user = a[++i] || '';
    else if (x === '--lib') o.lib = a[++i] || '';
    else if (x === '--mode') o.mode = a[++i] || '';
    else if (x === '--scan') o.scans.push(a[++i] || '');
    else if (x === '--limit') o.limit = Math.max(1, Number(a[++i]) || 20);
    else if (x === '--help' || x === '-h') o.help = true;
    else throw new Error('未知参数：' + x);
  }
  return o;
}

/* 只读打开并确认是 fm.db：不调 ensureSchema，避免误传路径时凭空建出空库 */
function openDb(file) {
  const db = DB.open(file);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('album_listen','user_progress','album_meta','durations')")
    .all().map(function (r) { return r.name; });
  if (names.indexOf('album_listen') < 0 || names.indexOf('user_progress') < 0) {
    db.close();
    throw new Error('不是有效的 fm.db（缺 album_listen / user_progress）：' + file);
  }
  return db;
}

function resolveUid(db, spec) {
  const s = String(spec || '').trim();
  if (!s) {
    const u = DB.adminUser(db);
    return u ? u.id : DB.ADMIN_ID;
  }
  const byName = DB.findUser(db, s);
  if (byName) return byName.id;
  const byId = DB.getUser(db, s);
  return byId ? byId.id : '';
}

function isScanObj(v) { return v && typeof v === 'object' && Array.isArray(v.files); }

/* 支持三种导出：单个 /api/scan 响应、数组、{ libraries: [...] } */
function loadScans(files) {
  const out = [];
  (files || []).forEach(function (f) {
    if (!f) return;
    let data;
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { throw new Error('读不了 --scan 文件：' + f + '（' + e.message + '）'); }
    if (isScanObj(data)) out.push(data);
    else if (Array.isArray(data)) data.filter(isScanObj).forEach(function (d) { out.push(d); });
    else if (data && Array.isArray(data.libraries)) data.libraries.filter(isScanObj).forEach(function (d) { out.push(d); });
    else throw new Error('--scan 文件格式不对（需要 /api/scan 响应或 { files: [...] }）：' + f);
  });
  return out;
}

/* 只读计算：返回待补差行与统计，不写库。测试直接调用这个函数。 */
function buildPlan(db, opts) {
  const o = opts || {};
  const uid = o.uid || resolveUid(db, o.user);
  if (!uid) throw new Error('找不到用户：' + (o.user || '(admin)'));

  /* 库表按归一化路径索引：元数据按目录共享，同一个目录可能被多个用户登记 */
  const libsByKey = new Map();
  db.prepare('SELECT id, name, path FROM libs').all().forEach(function (r) {
    const key = DB.libRootKey(r.path);
    if (!key) return;
    const hit = libsByKey.get(key);
    if (hit) { hit.ids.push(r.id); return; }
    libsByKey.set(key, { key: key, name: r.name || '', path: r.path || '', ids: [r.id] });
  });

  const libFilter = String(o.lib || '').trim();
  let onlyKey = '';
  if (libFilter) {
    const fk = DB.libRootKey(libFilter);
    libsByKey.forEach(function (l, key) {
      if (!onlyKey && (l.ids.indexOf(libFilter) >= 0 || key === fk)) onlyKey = key;
    });
    if (!onlyKey) throw new Error('--lib 找不到对应的库：' + libFilter);
  }

  const scans = Array.isArray(o.scans) ? o.scans : [];
  const stats = {
    libs: 0, noCache: 0, doneRows: 0, mapped: 0, unmapped: 0,
    badDuration: 0, fallback: 0, albums: 0, albumsToUpdate: 0, deltaSecs: 0
  };
  const rows = [];
  const libReports = [];

  const keys = db.prepare('SELECT DISTINCT lib_root FROM user_progress WHERE user_id = ? AND done = 1')
    .all(uid).map(function (r) { return String(r.lib_root || ''); })
    .filter(Boolean).sort();

  keys.forEach(function (key) {
    if (onlyKey && key !== onlyKey) return;
    stats.libs++;
    const lib = libsByKey.get(key);
    const report = {
      libRoot: key, name: lib ? lib.name : '', path: lib ? lib.path : '', mode: '',
      doneRows: 0, mapped: 0, unmapped: 0, badDuration: 0, fallback: 0,
      albums: 0, albumsToUpdate: 0, deltaSecs: 0, noCache: false
    };
    libReports.push(report);

    /* 扫描缓存来源：--scan 覆盖 > settings 里 serve.js / main.js 写的那份 */
    let scan = null;
    for (let i = 0; i < scans.length; i++) {
      const s = scans[i];
      const sk = s.root ? DB.libRootKey(s.root)
        : (s.libId && lib && lib.ids.indexOf(String(s.libId)) >= 0 ? key : '');
      if (sk === key) { scan = s; break; }
    }
    if (!scan) {
      const raw = DB.getSetting(db, 'scan:' + key, '');
      if (raw) {
        try {
          const d = JSON.parse(raw);
          if (d && Array.isArray(d.files)) scan = d;
        } catch (e) {}
      }
    }
    if (!scan) {
      report.noCache = true;
      stats.noCache++;
      return;
    }

    const mode = o.mode || scan.dirMode || DB.libDirMode(db, report.path || key);
    report.mode = mode;
    const trackMap = MAP.buildTrackAlbumMap(scan, mode, scan.rootName);

    const prog = db.prepare('SELECT track_id, d FROM user_progress WHERE user_id = ? AND lib_root = ? AND done = 1')
      .all(uid, key);
    report.doneRows = prog.length;
    stats.doneRows += prog.length;

    /* 批量加载，避免逐行查询 */
    const durMap = new Map();
    db.prepare('SELECT track_id, dur FROM durations WHERE lib_root = ?').all(key).forEach(function (r) {
      const v = Number(r.dur);
      if (isFinite(v) && v > 0 && v <= MAX_D) durMap.set(String(r.track_id), v);
    });
    const curMap = new Map();
    db.prepare('SELECT album_id, secs, title FROM album_listen WHERE user_id = ? AND lib_root = ?').all(uid, key).forEach(function (r) {
      curMap.set(String(r.album_id), { secs: Number(r.secs) || 0, title: r.title || '' });
    });
    const metaTitle = new Map();
    db.prepare('SELECT album_key, title FROM album_meta WHERE lib_root = ?').all(key).forEach(function (r) {
      if (r.title) metaTitle.set(String(r.album_key), String(r.title));
    });

    const agg = new Map();
    prog.forEach(function (r) {
      const tid = String(r.track_id || '');
      if (!tid) return;
      const hit = trackMap.get(tid);
      if (!hit) { report.unmapped++; stats.unmapped++; return; }
      let d = Number(r.d);
      if (!isFinite(d) || d <= 0 || d > MAX_D) {
        const alt = durMap.get(tid);
        if (!(isFinite(alt) && alt > 0 && alt <= MAX_D)) { report.badDuration++; stats.badDuration++; return; }
        d = alt;
        report.fallback++;
        stats.fallback++;
      }
      const a = agg.get(hit.albumId) || { albumId: hit.albumId, secs: 0, count: 0, fallbackTitle: hit.title || '' };
      a.secs += d;
      a.count++;
      if (!a.fallbackTitle && hit.title) a.fallbackTitle = hit.title;
      agg.set(hit.albumId, a);
    });

    agg.forEach(function (a) {
      const cur = curMap.get(a.albumId);
      const curSecs = cur ? cur.secs : 0;
      report.albums++;
      stats.albums++;
      report.mapped += a.count;
      stats.mapped += a.count;
      const delta = a.secs - curSecs;
      if (delta <= EPS) return;
      rows.push({
        libRoot: key,
        albumId: a.albumId,
        /* 标题优先级：用户重命名 > 已入库快照 > 扫描目录名 */
        title: metaTitle.get(a.albumId) || (cur && cur.title) || a.fallbackTitle || '',
        curSecs: curSecs,
        calcSecs: a.secs,
        deltaSecs: delta,
        count: a.count
      });
      report.albumsToUpdate++;
      report.deltaSecs += delta;
      stats.albumsToUpdate++;
      stats.deltaSecs += delta;
    });
  });

  rows.sort(function (a, b) { return b.deltaSecs - a.deltaSecs; });
  return { uid: uid, rows: rows, stats: stats, libs: libReports };
}

/* 条件 UPSERT：只有重算值更大才更新，title 只补空快照。单事务，幂等。 */
function applyPlan(db, plan) {
  if (!plan || !Array.isArray(plan.rows) || !plan.rows.length) return { changed: 0 };
  const now = Date.now();
  const up = db.prepare('INSERT INTO album_listen(user_id, lib_root, album_id, title, secs, updated_at) VALUES(?,?,?,?,?,?) ' +
    'ON CONFLICT(user_id, lib_root, album_id) DO UPDATE SET ' +
    '  secs = excluded.secs,' +
    "  title = CASE WHEN album_listen.title = '' AND excluded.title <> '' THEN excluded.title ELSE album_listen.title END," +
    '  updated_at = excluded.updated_at ' +
    'WHERE excluded.secs > album_listen.secs');
  db.exec('BEGIN IMMEDIATE');
  let changed = 0;
  try {
    plan.rows.forEach(function (r) {
      changed += up.run(plan.uid, r.libRoot, r.albumId, String(r.title || '').slice(0, 80), r.calcSecs, now).changes || 0;
    });
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    throw e;
  }
  return { changed: changed };
}

function stamp() {
  const d = new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/* VACUUM INTO 生成一致性快照：WAL 未 checkpoint 时直接 copy 主文件可能不完整 */
function backup(db, file) {
  if (!file || file === ':memory:') return '';
  const base = file + '.bak-' + stamp();
  let target = base;
  let i = 1;
  while (fs.existsSync(target)) target = base + '-' + (i++);
  db.exec('VACUUM INTO ' + "'" + String(target).replace(/'/g, "''") + "'");
  return target;
}

function fmtSecs(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return h + ' 小时 ' + m + ' 分';
  if (m) return m + ' 分 ' + r + ' 秒';
  return r + ' 秒';
}

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function printReport(plan, opts) {
  const o = opts || {};
  const st = plan.stats;
  console.log('用户：' + plan.uid);
  plan.libs.forEach(function (l) {
    const name = l.name || '(未登记库名的路径)';
    console.log('');
    console.log('库 ' + name + '  ' + l.libRoot);
    if (l.noCache) {
      console.log('  · 没有扫描缓存，无法还原曲目→专辑映射，已跳过。');
      console.log('  · 可先用 /api/scan 导出该库 JSON，再用 --scan <文件> 重跑。');
      return;
    }
    console.log('  · 模式 ' + l.mode + ' · 已听完 ' + l.doneRows + ' 集 · 计入 ' + l.mapped + ' 集' +
      ' · 未映射 ' + l.unmapped + ' · 时长异常 ' + l.badDuration + (l.fallback ? ' · durations 兜底 ' + l.fallback : ''));
    console.log('  · 涉及 ' + l.albums + ' 张专辑，待补差 ' + l.albumsToUpdate + ' 张，合计 ' + fmtSecs(l.deltaSecs));
  });

  const limit = Math.max(1, Number(o.limit) || 20);
  const show = plan.rows.slice(0, limit);
  if (show.length) {
    console.log('');
    console.log('待补差专辑（按补差时长降序）：');
    show.forEach(function (r, i) {
      const l = plan.libs.filter(function (x) { return x.libRoot === r.libRoot; })[0];
      console.log('  ' + (i + 1) + '. ' + (clip(r.title || r.albumId, 36)) + '  [' + (l && l.name || r.libRoot) + ']');
      console.log('     现有 ' + fmtSecs(r.curSecs) + ' → 重算 ' + fmtSecs(r.calcSecs) +
        '，补 ' + fmtSecs(r.deltaSecs) + '（' + r.count + ' 集）');
    });
    if (plan.rows.length > show.length) console.log('  … 还有 ' + (plan.rows.length - show.length) + ' 张未列出（用 --limit 调整）');
  }

  console.log('');
  console.log('合计：' + st.libs + ' 个库（无缓存 ' + st.noCache + '）· 已听完 ' + st.doneRows + ' 集 · 计入 ' + st.mapped +
    ' 集 · 未映射 ' + st.unmapped + ' · 时长异常 ' + st.badDuration);
  console.log('待补差 ' + st.albumsToUpdate + ' 张专辑，合计 ' + fmtSecs(st.deltaSecs) + '。');
  if (!o.apply) console.log('DRY-RUN：未写入。确认无误后加 --apply 执行。');
}

function main() {
  let o;
  try { o = parse(process.argv.slice(2)); }
  catch (e) { console.error(e.message); console.error(usage()); process.exit(2); }
  if (o.help) { console.log(usage()); return; }

  const file = o.db ? path.resolve(o.db) : defaultDb();
  if (!fs.existsSync(file)) {
    console.error('找不到数据库：' + file);
    process.exit(1);
  }

  let db;
  try { db = openDb(file); }
  catch (e) { console.error(e.message); process.exit(1); }

  try {
    let scans;
    try { scans = loadScans(o.scans); }
    catch (e) { console.error(e.message); process.exit(1); }

    const planOpts = { user: o.user, lib: o.lib, mode: o.mode, scans: scans };
    const plan = buildPlan(db, planOpts);
    printReport(plan, { apply: o.apply, limit: o.limit });

    if (o.apply) {
      if (!plan.rows.length) { console.log('没有需要补差的专辑，未做任何写入。'); return; }
      const bak = backup(db, file);
      console.log('');
      console.log('已备份：' + bak);
      const r = applyPlan(db, plan);
      console.log('已写入 ' + r.changed + ' 行。');
      const after = buildPlan(db, planOpts);
      console.log('复跑检查：待补差 ' + after.rows.length + ' 张（应为 0）。');
    }
  } finally {
    try { db.close(); } catch (e) {}
  }
}

if (require.main === module) main();

module.exports = {
  parse, defaultDb, openDb, resolveUid, loadScans,
  buildPlan, applyPlan, backup, fmtSecs
};
