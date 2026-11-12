/* /api/alist/test 的 HTTP 层回归：鉴权闸门、admin-only、参数与 SSRF 拦截。
   不访问真实网盘，全部用内网地址触发校验分支。跑法：node --test test/alist-route.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = require('../db');

function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function () {
      const p = s.address().port;
      s.close(function () { resolve(p); });
    });
  });
}

function waitReady(base, ms) {
  const deadline = Date.now() + (ms || 8000);
  return (async function loop() {
    try {
      const r = await fetch(base + '/__auth');
      if (r.status) return true;
    } catch (e) {}
    if (Date.now() > deadline) throw new Error('serve.js 未能在超时内启动');
    await new Promise(function (r) { setTimeout(r, 100); });
    return loop();
  })();
}

test('/api/alist/test：401 / 403 / 参数校验 / SSRF 拦截', async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-alist-route-'));
  const dbFile = path.join(dir, 'fm.db');
  const authFile = path.join(dir, '.auth.json');
  const db = DB.open(dbFile);
  DB.ensureSchema(db);
  const mk = function (name, role) {
    /* 用正常轮数：低轮数会被 /api/login 的 upgradeHash 重算并自增 token_version，
       刚签发的 token 立刻作废，测出来会误报 401 */
    const pw = DB.makePassword('pw-' + name);
    DB.addUser(db, { username: name, role: role, algo: pw.algo, iterations: pw.iterations, salt: pw.salt, hash: pw.hash });
  };
  mk('admin1', 'admin');
  mk('user1', 'user');
  db.close();

  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.js'), String(port), '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { FM_DATA_FILE: dbFile, FM_AUTH_FILE: authFile }),
    stdio: 'ignore'
  });
  const base = 'http://127.0.0.1:' + port;
  t.after(async function () {
    /* 按 PID 关掉自己启动的进程，不用 taskkill /IM 误杀用户服务 */
    if (proc && !proc.killed) proc.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  });

  try {
    await waitReady(base);
    async function login(name) {
      const r = await fetch(base + '/api/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, password: 'pw-' + name })
      });
      assert.equal(r.status, 200, '登录应成功：' + name);
      return (await r.json()).token;
    }
    const adminToken = await login('admin1');
    const userToken = await login('user1');
    assert.ok(adminToken && userToken);

    async function post(body, token) {
      const headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = 'Bearer ' + token;
      const r = await fetch(base + '/api/alist/test', { method: 'POST', headers: headers, body: JSON.stringify(body) });
      let out = null;
      try { out = await r.json(); } catch (e) { out = await r.text().catch(function () { return ''; }); }
      return { status: r.status, out: out };
    }

    assert.equal((await post({}, null)).status, 401, '未登录应 401');
    assert.equal((await post({}, userToken)).status, 403, '普通用户应 403');
    assert.equal((await post({}, adminToken)).status, 400, '缺少 host 应 400');

    for (const bad of ['http://127.0.0.1:1', 'http://169.254.169.254', 'http://localhost:5244']) {
      const r = await post({ host: bad, username: 'u', password: 'p' }, adminToken);
      assert.equal(r.status, 400, bad + ' 应被拒绝');
      assert.equal(r.out.error.code, 'BAD_HOST', bad + ' 应报 BAD_HOST');
    }
  } finally {
    if (proc && !proc.killed) proc.kill();
  }
});
