/* P4：/api/alist/config 与封面读写分离的 HTTP 回归。
   不访问真实网盘：PUT 只校验输入并把凭据加密落库，封面写到服务端本地临时目录。
   跑法：node --test test/alist-config.test.js */
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
/* 1x1 PNG：cover-fetch 的 dataUrl 分支只做 base64 解码，不解析图片内容 */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC';
const HOST = 'http://alist.example.com:5244';
const PW = 'pw-alist-do-not-log';

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
    try { const r = await fetch(base + '/__auth'); if (r.status) return true; } catch (e) {}
    if (Date.now() > deadline) throw new Error('serve.js 未能在超时内启动');
    await new Promise(function (r) { setTimeout(r, 100); });
    return loop();
  })();
}
/* 服务端对同一 IP 的写操作按 scope 限流（默认 5 次/秒）：慢一点，别让用例自己撞 429 */
const pace = function () { return new Promise(function (r) { setTimeout(r, 260); }); };

test('P4：配置 CRUD / 权限矩阵 / 封面读写分离', async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-alist-config-'));
  const dbFile = path.join(dir, 'fm.db');
  const authFile = path.join(dir, '.auth.json');
  const mediaDir = path.join(dir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const db = DB.open(dbFile);
  DB.ensureSchema(db);
  const mk = function (name, role) {
    const pw = DB.makePassword('pw-' + name);
    return DB.addUser(db, { username: name, role: role, algo: pw.algo, iterations: pw.iterations, salt: pw.salt, hash: pw.hash }).id;
  };
  const adminUid = mk('admin1', 'admin');
  mk('user1', 'user');
  const user2Uid = mk('user2', 'user');
  DB.replaceLibs(db, adminUid, [
    { id: 'local1', name: '本地库', path: mediaDir, addedAt: Date.now(), watch: 0, type: 'local', basePath: '/' }
  ], 'local1');
  db.close();

  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.js'), String(port), '--host', '127.0.0.1', '--allow-lib-edit'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { FM_DATA_FILE: dbFile, FM_AUTH_FILE: authFile }),
    stdio: 'ignore'
  });
  const base = 'http://127.0.0.1:' + port;
  t.after(async function () {
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
    const admin = await login('admin1');
    const user = await login('user1');
    const user2 = await login('user2');

    async function req(method, url, body, token, headers) {
      await pace();
      const h = Object.assign({ 'content-type': 'application/json' }, headers || {});
      if (token) h.authorization = 'Bearer ' + token;
      const r = await fetch(base + url, {
        method: method, headers: h,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      let out = null;
      try { out = await r.json(); } catch (e) { out = await r.text().catch(function () { return ''; }); }
      return { status: r.status, out: out, headers: r.headers };
    }
    const put = function (body, token, headers) { return req('PUT', '/api/alist/config', body, token, headers); };

    /* ── 权限矩阵与输入校验 ── */
    const baseCfg = { name: '网盘有声书', host: HOST, username: 'u', password: PW, base: '/音乐/如愿' };
    assert.equal((await put(baseCfg, null)).status, 401, '未登录应 401');
    assert.equal((await put(baseCfg, user)).status, 403, '普通用户应 403');
    assert.equal((await put({}, admin)).status, 400, '缺 host 应 400');
    assert.equal((await put(Object.assign({}, baseCfg, { host: 'http://127.0.0.1:5244' }), admin)).status, 400, '内网 host 应 400');
    assert.equal((await put(Object.assign({}, baseCfg, { base: '/a/../../etc' }), admin)).status, 400, '路径穿越应 400');
    assert.equal((await put(Object.assign({}, baseCfg, { cdn: ['http://evil.example'] }), admin)).status, 400, '非法 CDN 应 400');
    assert.equal((await put(Object.assign({}, baseCfg, { password: '', token: '' }), admin)).status, 400, '缺凭据应 400');

    /* ── PUT 新建：建库 + 加密落库 ── */
    const created = await put(baseCfg, admin);
    assert.equal(created.status, 200, JSON.stringify(created.out));
    const id = created.out.view.id;
    assert.ok(id && id !== 'local1');
    assert.equal(created.out.view.type, 'alist');
    assert.equal(created.out.view.configured, true);
    assert.equal(created.out.view.basePath, '/音乐/如愿');

    const libsResp = await req('GET', '/api/libs', undefined, admin);
    const libView = libsResp.out.libs.find(function (l) { return l.id === id; });
    assert.equal(libView.type, 'alist', '/api/libs 应带 type');
    assert.equal(libView.configured, true);
    assert.equal(libView.missing, false, '不能以本地路径判网盘库缺失');

    const chk = DB.open(dbFile);
    const row = chk.prepare('SELECT path, type, base_path, watch FROM libs WHERE id = ?').get(id);
    assert.equal(row.path, 'alist:' + id, '元数据键必须带 alist: 命名空间');
    assert.equal(row.type, 'alist');
    assert.equal(row.base_path, '/音乐/如愿');
    assert.equal(row.watch, 0, '网盘库不做本地目录监听');
    const cred = String(DB.getSetting(chk, 'alist:' + id + ':cred', '') || '');
    assert.ok(cred && cred.indexOf(PW) < 0, '凭据必须加密，明文不能出现在 settings');
    assert.equal(DB.getSetting(chk, 'alist:' + id + ':host', ''), HOST);
    assert.ok(String(DB.getSetting(chk, 'alist:' + id + ':cdn', '')).indexOf('drive.quark.cn') >= 0, 'CDN 白名单默认放行');
    chk.close();

    /* ── GET：只回掩码视图 ── */
    const got = await req('GET', '/api/alist/config?libId=' + encodeURIComponent(id), undefined, admin);
    assert.equal(got.status, 200, JSON.stringify(got.out));
    assert.equal(got.out.host, HOST);
    assert.equal(got.out.base, '/音乐/如愿');
    assert.equal(got.out.hasCredential, true);
    assert.equal(got.out.credentialType, 'password');
    const text = JSON.stringify(got.out);
    assert.ok(text.indexOf(PW) < 0, '响应不能回传凭据明文');
    assert.ok(!('password' in got.out) && !('token' in got.out) && !('dirPassword' in got.out), '响应不能带凭据字段');
    assert.equal((await req('GET', '/api/alist/config?libId=local1', undefined, admin)).status, 403, '本地库不能查配置');
    assert.equal((await req('GET', '/api/alist/config?libId=' + id, undefined, undefined)).status, 401, '未登录应 401');
    assert.equal((await req('GET', '/api/alist/config?libId=' + id, undefined, user)).status, 403, '普通用户应 403');

    /* ── PUT 更新：空密码沿用原值 ── */
    const updated = await put({ libId: id, name: '如愿', host: HOST, base: '/音乐', password: '', token: '' }, admin);
    assert.equal(updated.status, 200, JSON.stringify(updated.out));
    assert.equal(updated.out.view.name, '如愿');
    assert.equal(updated.out.view.basePath, '/音乐');
    const got2 = await req('GET', '/api/alist/config?libId=' + id, undefined, admin);
    assert.equal(got2.out.hasCredential, true, '编辑时不回填密码不能把凭据抹掉');
    assert.equal(got2.out.credentialType, 'password');

    /* 显式填 token → 切到 token 模式；再填密码 → 必须清掉旧 token。
       否则 login() 仍优先用旧 token，新密码永远不生效。 */
    assert.equal((await put({ libId: id, name: '如愿', host: HOST, base: '/音乐', token: 'tk-1' }, admin)).status, 200);
    const gotTk = await req('GET', '/api/alist/config?libId=' + id, undefined, admin);
    assert.equal(gotTk.out.credentialType, 'token', '填 token 应切到 token 模式');
    assert.equal((await put({ libId: id, name: '如愿', host: HOST, base: '/音乐', password: 'pw-mode-2' }, admin)).status, 200);
    const gotPw = await req('GET', '/api/alist/config?libId=' + id, undefined, admin);
    assert.equal(gotPw.out.credentialType, 'password', '填密码应切回密码模式并清掉旧 token');
    assert.equal((await put({ libId: 'local1', host: HOST, username: 'u', password: PW }, admin)).status, 403, '不能把本地库改成网盘库');

    /* ── 封面读写分离：只写服务端本地数据目录，不写虚拟网盘路径 ── */
    const coverDir = path.join(dir, 'covers', 'alist', id);
    const evilDir = path.join(dir, 'evil-covers');
    const coverHdr = { 'x-fm-lib': id };
    const saved = await req('POST', '/api/cover', {
      dirName: '如愿', payload: { dataUrl: PNG, coverDir: evilDir }
    }, admin, coverHdr);
    assert.equal(saved.status, 200, JSON.stringify(saved.out));
    assert.ok(fs.existsSync(path.join(coverDir, 'covers.json')), '封面应落在服务端本地数据目录');
    assert.ok(!fs.existsSync(evilDir), '客户端伪造的 coverDir 必须被服务端覆盖');
    assert.ok(!fs.existsSync(path.join(ROOT, 'alist:' + id, '.fm-covers')), '绝不能往虚拟网盘路径写辅助文件');

    const idx = await req('GET', '/api/covers?libId=' + id, undefined, admin);
    assert.ok(idx.out['如愿'] && idx.out['如愿'].file, '索引应读得到刚保存的封面');
    const file = idx.out['如愿'].file;
    const img = await req('GET', '/api/cover/' + encodeURIComponent(file) + '?libId=' + id, undefined, admin);
    assert.equal(img.status, 200, '封面图片应能按库读出来');
    assert.ok(String(img.headers.get('content-type')).indexOf('image/') === 0);
    assert.ok(fs.existsSync(path.join(coverDir, file)));

    const removed = await req('DELETE', '/api/cover?dir=' + encodeURIComponent('如愿'), undefined, admin, coverHdr);
    assert.equal(removed.status, 200);
    const idx2 = await req('GET', '/api/covers?libId=' + id, undefined, admin);
    assert.ok(!idx2.out['如愿'], '删除后索引应清掉条目');
    assert.ok(!fs.existsSync(path.join(coverDir, file)), '删除后图片应一起清掉');

    /* 本地库回归：行为不变，仍写 <root>/.fm-covers */
    const localSaved = await req('POST', '/api/cover', { dirName: '本地专辑', payload: { dataUrl: PNG } }, admin, { 'x-fm-lib': 'local1' });
    assert.equal(localSaved.status, 200, JSON.stringify(localSaved.out));
    assert.ok(fs.existsSync(path.join(mediaDir, '.fm-covers', 'covers.json')), '本地库封面路径不能变');
    assert.ok(!fs.existsSync(path.join(coverDir, 'covers.json')) ||
      !JSON.parse(fs.readFileSync(path.join(coverDir, 'covers.json'), 'utf8'))['本地专辑'], '不能串库');

    /* ── 直链：没有扫描快照时必须 404，不能放行任意 rel ── */
    const rel = '音乐/如愿/01.flac';
    async function alistTicket(token, libId) {
      const r = await fetch(base + '/api/ticket?scope=alist&libId=' + libId + '&rel=' + encodeURIComponent(rel),
        { headers: { authorization: 'Bearer ' + token } });
      return (await r.json()).t;
    }
    const noSnap = await fetch(base + '/api/alist/raw?libId=' + id + '&rel=' + encodeURIComponent(rel) +
      '&t=' + encodeURIComponent(await alistTicket(admin, id)));
    assert.equal(noSnap.status, 404, '未扫描时直链应 404');
    assert.equal((await noSnap.json()).error.code, 'NOT_FOUND');

    /* ── 共享副本：配置按源库 id 解析（副本 id 是 sh<源id><uid>） ── */
    const chkSh = DB.open(dbFile);
    DB.setLibShare(chkSh, id, false, [user2Uid]);
    DB.syncUserSharedLibs(chkSh, user2Uid);
    chkSh.close();
    const copyId = 'sh' + id + user2Uid;
    const u2libs = await req('GET', '/api/libs', undefined, user2);
    const copy = u2libs.out.libs.find(function (l) { return l.id === copyId; });
    assert.ok(copy, '共享副本应出现在接收方库列表');
    assert.equal(copy.missing, false, '副本必须能读到源库凭据，而不是显示未配置');
    assert.equal(copy.configured, true);
    /* 副本取链应停在「快照缺失」，而不是「未配置连接」——证明配置读的是源库 id */
    const copyRaw = await fetch(base + '/api/alist/raw?libId=' + copyId + '&rel=' + encodeURIComponent(rel) +
      '&t=' + encodeURIComponent(await alistTicket(user2, copyId)));
    assert.equal(copyRaw.status, 404, '副本应读到源库配置后停在快照缺失');
    assert.equal((await copyRaw.json()).error.code, 'NOT_FOUND');

    /* ── DELETE 配置：清凭据但保留库 ── */
    const cleared = await req('DELETE', '/api/alist/config?libId=' + id, undefined, admin);
    assert.equal(cleared.status, 200, JSON.stringify(cleared.out));
    assert.equal(cleared.out.view.configured, false);
    const got3 = await req('GET', '/api/alist/config?libId=' + id, undefined, admin);
    assert.equal(got3.out.hasCredential, false);
    const libs3 = await req('GET', '/api/libs', undefined, admin);
    assert.equal(libs3.out.libs.find(function (l) { return l.id === id; }).missing, true, '清掉凭据后库应转为 missing');

    /* ── 移除库：连带清配置与本地封面目录 ── */
    const rm = await req('POST', '/api/lib', { action: 'remove', id: id }, admin);
    assert.equal(rm.status, 200, JSON.stringify(rm.out));
    const chk2 = DB.open(dbFile);
    assert.equal(String(DB.getSetting(chk2, 'alist:' + id + ':cred', '') || ''), '');
    chk2.close();
    assert.ok(!fs.existsSync(coverDir), '库移除后封面目录应一起清掉');
  } finally {
    if (proc && !proc.killed) proc.kill();
  }
});
