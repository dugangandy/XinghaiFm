/* P3：Alist 播放链路的 HTTP 层回归。
   票据绑定 libId+rel、/api/alist/raw 鉴权与错误码、/api/media 兼容分派、
   跨源直链所需的 CSP media-src 白名单。不访问真实网盘。
   跑法：node --test test/alist-raw.test.js */
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

test('票据 / 直链路由 / media 分派 / CSP 白名单', async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-alist-raw-'));
  const dbFile = path.join(dir, 'fm.db');
  const db = DB.open(dbFile);
  DB.ensureSchema(db);
  const pw = DB.makePassword('pw');
  const user = DB.addUser(db, { username: 'admin3', role: 'admin', algo: pw.algo, iterations: pw.iterations, salt: pw.salt, hash: pw.hash });
  const uid = user.id;
  const ins = db.prepare('INSERT INTO libs(id,user_id,name,path,added_at,active,position,watch,type,base_path) VALUES(?,?,?,?,?,?,?,?,?,?)');
  ins.run('l1', uid, '本地库', dir, Date.now(), 1, 0, 0, 'local', '/');
  ins.run('l2', uid, '网盘库', 'alist:l2', Date.now(), 0, 1, 0, 'alist', '/夸克网盘TV');
  /* 只写 host/cdn 用于 CSP 与路由定位；故意不写 cred，让取链停在 ALIST_UNCONFIGURED，
     测试不会发起任何外部网络请求 */
  DB.setSetting(db, 'alist:l2:host', 'http://139.198.0.1:5244');
  DB.setSetting(db, 'alist:l2:cdn', JSON.stringify(['*.drive.quark.cn']));
  db.close();

  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.js'), String(port), '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { FM_DATA_FILE: dbFile, FM_AUTH_FILE: path.join(dir, '.auth.json') }),
    stdio: 'ignore'
  });
  const base = 'http://127.0.0.1:' + port;
  t.after(function () {
    if (proc && !proc.killed) proc.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  });

  try {
    const deadline = Date.now() + 8000;
    for (;;) {
      try { const r = await fetch(base + '/__auth'); if (r.status) break; } catch (e) {}
      if (Date.now() > deadline) throw new Error('serve.js 启动超时');
      await new Promise(function (r) { setTimeout(r, 100); });
    }
    const lr = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin3', password: 'pw' })
    });
    const token = (await lr.json()).token;
    assert.ok(token);
    const H = { authorization: 'Bearer ' + token };

    /* 跨源直链必须出现在页面 CSP 的 media-src 里，否则浏览器会直接拦掉播放 */
    const page = await fetch(base + '/__auth');
    const csp = String(page.headers.get('content-security-policy') || '');
    assert.match(csp, /http:\/\/139\.198\.0\.1:5244/, 'CSP 应包含已配置的 host');
    assert.match(csp, /https:\/\/\*\.drive\.quark\.cn/, 'CSP 应包含 CDN 通配域');
    assert.match(csp, /media-src/);

    const rel = '音乐/单曲.flac';
    const ticketRes = await fetch(base + '/api/ticket?scope=alist&libId=l2&rel=' + encodeURIComponent(rel), { headers: H });
    const ticket = await ticketRes.json();
    assert.equal(ticket.scope, 'alist');
    assert.ok(ticket.t && ticket.exp > Math.floor(Date.now() / 1000));

    /* 只带票据（模拟 <audio> 无法带 header 的桌面远程模式）：鉴权通过，停在未配置连接 */
    const rawQ = '/api/alist/raw?libId=l2&rel=' + encodeURIComponent(rel) + '&t=' + encodeURIComponent(ticket.t);
    const raw = await fetch(base + rawQ, { redirect: 'manual' });
    assert.equal(raw.status, 502, '票据应通过鉴权，而不是 401');
    assert.equal((await raw.json()).error.code, 'ALIST_UNCONFIGURED');

    /* 篡改 rel / 缺票据：票据绑定生效 */
    const bad = await fetch(base + '/api/alist/raw?libId=l2&rel=' + encodeURIComponent(rel + 'x') + '&t=' + encodeURIComponent(ticket.t));
    assert.equal(bad.status, 401, 'rel 不匹配应 401');
    const noT = await fetch(base + '/api/alist/raw?libId=l2&rel=' + encodeURIComponent(rel));
    assert.equal(noT.status, 401, '无会话无票据应 401');

    /* 旧客户端仍打 /api/media：alist 库应分派到取链，本地库仍走本地读盘 */
    const oldClient = await fetch(base + '/api/media/' + encodeURIComponent(rel) + '?libId=l2', { headers: H });
    assert.equal(oldClient.status, 502);
    assert.equal((await oldClient.json()).error.code, 'ALIST_UNCONFIGURED');
    const local = await fetch(base + '/api/media/nope.mp3?libId=l1', { headers: H });
    assert.equal(local.status, 404, '本地库行为不变');

    /* 其它 scope 的票据不受影响 */
    const mediaTicket = await (await fetch(base + '/api/ticket?scope=media', { headers: H })).json();
    assert.equal(mediaTicket.scope, 'media');
    assert.ok(mediaTicket.t);
  } finally {
    if (proc && !proc.killed) proc.kill();
  }
});
