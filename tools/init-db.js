#!/usr/bin/env node
/* ── init-db.js · 初始化 / 迁移数据库 ─────────────────────
 * 把旧的 .auth.json / config.json / remote.json 迁移进 fm.db（SQLite）。
 * .tunnel.json 不迁移（仍是本机配置文件）。
 *
 * 用法：
 *   node tools/init-db.js                 # 幂等初始化（已存在用户则跳过迁移）
 *   node tools/init-db.js --force         # 删除并重建数据库
 *   node tools/init-db.js --keep          # 迁移后保留旧文件原名（默认改名 *.migrated.bak）
 *   node tools/init-db.js --list-users
 *   node tools/init-db.js --add-user bob [口令]
 *   node tools/init-db.js --set-password bob [口令]
 *   node tools/init-db.js --check-password bob [口令]
 *   node tools/init-db.js --remove-user bob
 *   node tools/init-db.js --db <路径>      # 指定数据库文件（默认 userData/fm.db）
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
const readline = require('node:readline');
const DB = require('../db');

const ROOT = path.resolve(__dirname, '..');

function desktopDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '星海FM');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', '星海FM');
  return path.join(home, '.config', '星海FM');
}

function parse() {
  const a = process.argv.slice(2);
  const o = { action: 'init', name: '', pw: '', force: false, keep: false, db: '' };
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === '--force') o.force = true;
    else if (x === '--keep') o.keep = true;
    else if (x === '--db') o.db = a[++i] || '';
    else if (x === '--list-users') o.action = 'list';
    else if (x === '--add-user') { o.action = 'add'; o.name = a[++i] || ''; if (a[i + 1] && a[i + 1][0] !== '-') o.pw = a[++i]; }
    else if (x === '--set-password') { o.action = 'setpw'; o.name = a[++i] || ''; if (a[i + 1] && a[i + 1][0] !== '-') o.pw = a[++i]; }
    else if (x === '--check-password') { o.action = 'check'; o.name = a[++i] || ''; if (a[i + 1] && a[i + 1][0] !== '-') o.pw = a[++i]; }
    else if (x === '--remove-user') { o.action = 'remove'; o.name = a[++i] || ''; }
  }
  return o;
}

function ask(question) {
  return new Promise(function (resolve) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, function (ans) { rl.close(); resolve(ans); });
  });
}

async function getPassword(pw) {
  if (pw) return pw;
  const a = await ask('设置密码（会显示在屏幕上）：');
  const b = await ask('再输入一次确认：');
  if (a !== b) { console.error('两次输入不一致，未修改'); process.exit(1); }
  return a;
}

function dataDirOf(o) {
  if (o.db) return path.dirname(path.resolve(o.db));
  return desktopDir();
}
function dbFileOf(o) {
  if (o.db) return path.resolve(o.db);
  if (process.env.FM_DATA_FILE) return path.resolve(process.env.FM_DATA_FILE);
  return path.join(desktopDir(), 'fm.db');
}

function renameLegacy(files, keep) {
  if (keep) return;
  files.forEach(function (f) {
    try {
      if (f && fs.existsSync(f)) fs.renameSync(f, f + '.migrated.bak');
    } catch (e) {}
  });
}

(async function () {
  const o = parse();
  const file = dbFileOf(o);

  if (o.action !== 'init') {
    if (!fs.existsSync(file)) { console.error('数据库不存在：' + file + '\n先运行：node tools/init-db.js'); process.exit(1); }
  }
  if (o.force && fs.existsSync(file)) {
    try { fs.rmSync(file, { force: true }); fs.rmSync(file + '-wal', { force: true }); fs.rmSync(file + '-shm', { force: true }); } catch (e) {}
    console.log('已删除旧数据库：' + file);
  }

  const db = DB.open(file);
  DB.ensureSchema(db);

  if (o.action === 'list') {
    const us = DB.listUsers(db);
    if (!us.length) console.log('（没有用户）');
    us.forEach(function (u) { console.log('  ' + (u.role === 'admin' ? '*' : ' ') + ' ' + u.username + '  [' + u.role + ']  ' + (u.lastLoginAt || '从未登录')); });
    return;
  }
  if (o.action === 'add') {
    if (!o.name) { console.error('缺少用户名：--add-user <name> [口令]'); process.exit(1); }
    if (DB.findUser(db, o.name)) { console.error('用户已存在：' + o.name); process.exit(1); }
    const pw = await getPassword(o.pw);
    if (!pw) { console.error('密码不能为空'); process.exit(1); }
    const u = DB.addUser(db, { username: o.name, role: 'user', password: pw });
    console.log('✓ 已添加用户：' + u.username + '  (id=' + u.id + ')');
    return;
  }
  if (o.action === 'setpw') {
    const u = DB.findUser(db, o.name);
    if (!u) { console.error('用户不存在：' + o.name); process.exit(1); }
    const pw = await getPassword(o.pw);
    if (!pw) { console.error('密码不能为空'); process.exit(1); }
    DB.setUserPassword(db, u.id, pw);
    console.log('✓ 已修改密码：' + u.username);
    return;
  }
  if (o.action === 'check') {
    const u = DB.findUser(db, o.name);
    if (!u) { console.error('用户不存在：' + o.name); process.exit(1); }
    const pw = o.pw || await ask('输入要校验的密码：');
    const ok = DB.checkPassword(u, pw);
    console.log(ok ? '✓ 密码正确' : '✗ 密码不正确');
    process.exit(ok ? 0 : 1);
  }
  if (o.action === 'remove') {
    const u = DB.findUser(db, o.name);
    if (!u) { console.error('用户不存在：' + o.name); process.exit(1); }
    DB.removeUser(db, u.id);
    console.log('✓ 已删除用户：' + u.username + '（其资源库一并删除）');
    return;
  }

  /* 初始化 / 迁移 */
  const dir = dataDirOf(o);
  const authFile = process.env.FM_AUTH_FILE ? path.resolve(process.env.FM_AUTH_FILE) : path.join(ROOT, '.auth.json');
  const configFile = path.join(dir, 'config.json');
  const remoteFile = path.join(dir, 'remote.json');

  const summary = DB.migrate(db, { authFile: authFile, configFile: configFile, remoteFile: remoteFile });
  if (summary.skipped) {
    console.log('数据库已有用户，跳过迁移。');
    console.log('数据库：' + file);
    const us = DB.listUsers(db);
    us.forEach(function (u) { console.log('  ' + (u.role === 'admin' ? '*' : ' ') + ' ' + u.username); });
    return;
  }
  console.log('✓ 初始化完成：' + file);
  console.log('  管理员：admin' + (summary.user ? '' : '（未创建）'));
  console.log('  资源库：' + summary.libs + ' 个（归 admin）');
  console.log('  远程配置：' + (summary.remote ? '已迁移' : '无'));
  if (summary.generatedPassword) {
    console.log('');
    console.log('  ⚠ 没有找到旧口令文件，已为 admin 生成随机密码：');
    console.log('      ' + summary.generatedPassword);
    console.log('    请尽快修改：node tools/init-db.js --set-password admin');
  }
  console.log('  旧文件 -> *.migrated.bak：' + (o.keep ? '保留原名' : '已备份'));
  renameLegacy([authFile, configFile, remoteFile], o.keep);
})().catch(function (e) { console.error('初始化失败：' + (e && e.message || e)); process.exit(1); });
