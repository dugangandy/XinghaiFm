/* Alist/OpenList 对接模块的回归测试：SSRF、UTF-8 中文路径、裸 token、分页、
   raw_url 白名单、错误映射、libs 加列兼容。跑法：node --test test/alist.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB = require('../db');
const A = require('../tools/alist');

/* 本地 mock 服务器：记录原始请求字节，便于断言 UTF-8 与裸 token */
function mockServer(handler) {
  const seen = [];
  const srv = http.createServer(function (req, res) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      const raw = Buffer.concat(chunks);
      let body = null;
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch (e) {}
      seen.push({ url: req.url, method: req.method, headers: req.headers, raw: raw, body: body });
      handler(req, res, body);
    });
  });
  return new Promise(function (resolve) {
    srv.listen(0, '127.0.0.1', function () {
      const host = 'http://127.0.0.1:' + srv.address().port;
      /* 测试注入：跳过公网 IP 校验，把请求 pin 到 127.0.0.1 */
      const testOpts = {
        resolve: async function (rawUrl) {
          const u = new URL(rawUrl);
          return { url: u, address: '127.0.0.1', family: 4 };
        }
      };
      resolve({
        host: host,
        opts: testOpts,
        seen: seen,
        close: function () { return new Promise(function (r) { srv.close(r); }); }
      });
    });
  });
}

function jsonReply(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

test('normalizeRel：中文/空格放行，路径穿越与空段拒绝', function () {
  assert.equal(A.normalizeRel('音乐/如愿/如愿 - 王菲.flac'), '音乐/如愿/如愿 - 王菲.flac');
  assert.equal(A.normalizeRel('KY/数学/2025年启航数学全程班'), 'KY/数学/2025年启航数学全程班');
  ['../etc/passwd', 'a/../../b', '/etc/passwd', 'a//b', 'a/./b', '', '  ', 'a\\b', 'a\0b']
    .forEach(function (bad) { assert.throws(function () { A.normalizeRel(bad); }, /BAD_PATH/, String(bad)); });
});

test('encodeAlistPath：逐段编码中文与特殊字符', function () {
  assert.equal(A.encodeAlistPath('/音乐/如愿/a#b.mp3'), '/%E9%9F%B3%E4%B9%90/%E5%A6%82%E6%84%BF/a%23b.mp3');
  assert.equal(A.encodeAlistPath('/a b/c?d.mp3'), '/a%20b/c%3Fd.mp3');
});

test('isBlockedIp / resolvePublicTarget：内网与元数据地址拒绝，公网 IP 放行', async function () {
  ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.5', '::1'].forEach(function (ip) {
    assert.equal(A.isBlockedIp(ip), true, ip);
  });
  assert.equal(A.isBlockedIp('8.8.8.8'), false);
  await assert.rejects(function () { return A.resolvePublicTarget('http://127.0.0.1:5244/x'); }, /BAD_HOST/);
  await assert.rejects(function () { return A.resolvePublicTarget('http://169.254.169.254/latest/x'); }, /BAD_HOST/);
  await assert.rejects(function () { return A.resolvePublicTarget('http://localhost/x'); }, /BAD_HOST/);
  await assert.rejects(function () { return A.resolvePublicTarget('file:///etc/passwd'); }, /BAD_HOST/);
  const t = await A.resolvePublicTarget('http://8.8.8.8:5244/api/me');
  assert.equal(t.address, '8.8.8.8');
});

test('isAllowedRawHost / suggestCdn：自身 host 与 *.drive.quark.cn 放行，恶意域拒绝', function () {
  const cfgHost = 'http://139.198.0.1:5244';
  assert.equal(A.isAllowedRawHost(cfgHost + '/p/a.mp3?sign=x', cfgHost, A.DEFAULT_CDN), true);
  assert.equal(A.isAllowedRawHost('https://dl-c-zb-u.drive.quark.cn/x', cfgHost, A.DEFAULT_CDN), true);
  assert.equal(A.isAllowedRawHost('http://evil.example.com/x', cfgHost, A.DEFAULT_CDN), false);
  assert.equal(A.isAllowedRawHost('ftp://x.example.com/x', cfgHost, A.DEFAULT_CDN), false);
  assert.deepEqual(A.suggestCdn('https://dl-c-zb-u.drive.quark.cn/x', cfgHost), ['*.drive.quark.cn']);
  assert.deepEqual(A.suggestCdn(cfgHost + '/p/a.mp3?sign=x', cfgHost), []);
  /* 未知驱动只建议精确 host，不能按末三段推断出整个二级域 */
  assert.deepEqual(A.suggestCdn('https://abc.def.example.com/x', cfgHost), ['abc.def.example.com']);
});

test('safeDirectLink：中文路径转义、非 http 拒绝', function () {
  assert.equal(
    A.safeDirectLink('https://dl-c-zb-u.drive.quark.cn/音乐/如愿.flac?sign=abc'),
    'https://dl-c-zb-u.drive.quark.cn/%E9%9F%B3%E4%B9%90/%E5%A6%82%E6%84%BF.flac?sign=abc'
  );
  assert.throws(function () { A.safeDirectLink('javascript:alert(1)'); }, /NO_DIRECT_LINK/);
  assert.throws(function () { A.safeDirectLink(''); }, /NO_DIRECT_LINK/);
});

test('requestJson：UTF-8 JSON、裸 token header、不跟随跳转', async function () {
  const s = await mockServer(function (req, res, body) {
    if (req.url === '/api/redirect') { res.writeHead(302, { location: 'http://evil.example/' }); return res.end(); }
    jsonReply(res, 200, { code: 200, data: { echo: body && body.path } });
  });
  try {
    const cfg = { host: s.host };
    const out = await A.requestJson(cfg, '/api/fs/list', { path: '/夸克网盘TV/音乐' },
      { token: 'plain-token-xyz', resolve: s.opts.resolve });
    assert.equal(out.data.echo, '/夸克网盘TV/音乐');
    const r = s.seen[0];
    assert.equal(r.headers.authorization, 'plain-token-xyz', 'Authorization 必须是裸 token');
    assert.match(r.headers['content-type'], /charset=utf-8/);
    assert.ok(r.raw.includes(Buffer.from('夸克网盘TV', 'utf8')), '中文必须以 UTF-8 字节发送');
    await assert.rejects(function () {
      return A.requestJson(cfg, '/api/redirect', null, { method: 'GET', resolve: s.opts.resolve });
    }, /ALIST_UNEXPECTED_REDIRECT/);
  } finally { await s.close(); }
});

test('mapUpstream：上游错误码映射', function () {
  assert.equal(A.mapUpstream(401, { message: 'unauthorized' }).code, 'ALIST_AUTH_FAILED');
  assert.equal(A.mapUpstream(429, {}).code, 'RATE_LIMIT');
  assert.equal(A.mapUpstream(404, {}).code, 'NOT_FOUND');
  assert.equal(A.mapUpstream(500, { message: 'failed get storage: storage not found' }).code, 'BAD_ENCODING');
  assert.equal(A.mapUpstream(500, { message: 'boom' }).code, 'ALIST_UNREACHABLE');
});

test('login：token 缓存与 401 自动刷新一次', async function () {
  let loginCount = 0;
  const s = await mockServer(function (req, res) {
    if (req.url === '/api/auth/login') {
      loginCount++;
      return jsonReply(res, 200, { code: 200, data: { token: 'tk-' + loginCount } });
    }
    return jsonReply(res, 200, { code: 200, data: { ok: true } });
  });
  try {
    const cfg = { host: s.host, username: 'u', password: 'p' };
    A.clearTokenCache();
    const a = await A.login(cfg, s.opts);
    const b = await A.login(cfg, s.opts);
    assert.equal(a.token, 'tk-1');
    assert.equal(b.token, 'tk-1');
    assert.equal(loginCount, 1, '同一 host/user 应复用内存 token');
    assert.equal(s.seen[0].headers.authorization, undefined, '登录请求不带 Authorization');
    assert.equal(s.seen[0].body.otp_code, undefined, '未开启 2FA 不应带 otp_code');
  } finally { A.clearTokenCache(); await s.close(); }
});

test('listDir：按页大小翻页，total 偏小不截断，中文 path 原样 UTF-8', async function () {
  const s = await mockServer(function (req, res, body) {
    const page = body.page;
    const items = page === 1
      ? Array.from({ length: 200 }, function (_, i) { return { name: '一' + i + '.flac', is_dir: false, size: 1 }; })
      : Array.from({ length: 50 }, function (_, i) { return { name: '二' + i + '.mp3', is_dir: false, size: 1 }; });
    /* total 故意只报 200（等价于「只表示当前页」的驱动）：不能拿它当终止条件，
       否则第二页会被截掉，扫描结果就会少很多文件 */
    jsonReply(res, 200, { code: 200, data: { content: items, total: 200, provider: 'QuarkTV', write: false } });
  });
  try {
    const out = await A.listDir({ host: s.host }, 'tk', '/夸克网盘TV', s.opts);
    assert.equal(out.items.length, 250);
    assert.equal(out.provider, 'QuarkTV');
    assert.equal(s.seen.length, 2);
    assert.equal(s.seen[0].body.path, '/夸克网盘TV');
    assert.equal(s.seen[0].body.per_page, 200);
    assert.ok(s.seen[0].raw.includes(Buffer.from('夸克网盘TV', 'utf8')));
  } finally { await s.close(); }
});

test('getFile：raw_url 白名单校验、缺失与恶意 host 报错', async function () {
  let raw = '';
  const s = await mockServer(function (req, res) {
    jsonReply(res, 200, { code: 200, data: { raw_url: raw, provider: 'Local', size: 10 } });
  });
  try {
    const cfg = { host: s.host, cdn: A.DEFAULT_CDN };
    raw = s.host + '/p/%E9%9F%B3%E4%B9%90.mp3?sign=abc';
    const ok = await A.getFile(cfg, 'tk', '/音乐/a.mp3', s.opts);
    assert.equal(ok.rawUrl, raw);
    raw = 'https://dl-a.drive.quark.cn/x?sign=abc';
    assert.equal((await A.getFile(cfg, 'tk', '/音乐/a.mp3', s.opts)).rawUrl, raw);
    raw = 'http://evil.example.com/x';
    await assert.rejects(function () { return A.getFile(cfg, 'tk', '/x', s.opts); }, /BAD_RAW_HOST/);
    raw = '';
    await assert.rejects(function () { return A.getFile(cfg, 'tk', '/x', s.opts); }, /NO_DIRECT_LINK/);
  } finally { await s.close(); }
});

test('probe：返回版本/驱动清单/中文目录样本，不落库不写文件', async function () {
  const s = await mockServer(function (req, res, body) {
    if (req.url === '/api/public/settings') {
      return jsonReply(res, 200, { code: 200, data: { version: 'refs/heads/main (Commit abc)', site_title: 'OpenList' } });
    }
    if (req.url === '/api/auth/login') return jsonReply(res, 200, { code: 200, data: { token: 'tk' } });
    if (req.url === '/api/admin/storage/list') {
      return jsonReply(res, 200, { code: 200, data: { content: [
        { mount_path: '/KY', driver: 'Local' }, { mount_path: '/夸克网盘TV', driver: 'QuarkTV' }
      ] } });
    }
    if (req.url === '/api/fs/list') {
      return jsonReply(res, 200, { code: 200, data: { content: [
        { name: '数学', is_dir: true, size: 0 }, { name: '如愿 - 王菲.flac', is_dir: false, size: 158000000 }
      ], total: 2, provider: 'unknown' } });
    }
    if (req.url === '/api/fs/get') {
      return jsonReply(res, 200, { code: 200, data: { raw_url: 'https://dl-x.drive.quark.cn/f?sign=abc', size: 10 } });
    }
    jsonReply(res, 404, { code: 404, message: 'not found' });
  });
  try {
    const out = await A.probe({ host: s.host, username: 'u', password: 'p', base: '/夸克网盘TV' },
      Object.assign({}, s.opts, { probeRange: false }));
    assert.equal(out.ok, true);
    assert.equal(out.serverTitle, 'OpenList');
    assert.match(out.version, /Commit/);
    assert.equal(out.storages.length, 2);
    assert.equal(out.storages[1].driver, 'QuarkTV');
    assert.equal(out.sample[0].name, '数学');
    assert.equal(out.basePath, '/夸克网盘TV');
    assert.deepEqual(out.cdnSuggest, ['*.drive.quark.cn']);
    /* 列目录 path 必须是 UTF-8 中文，不能是 GBK */
    const listReq = s.seen.find(function (r) { return r.url === '/api/fs/list'; });
    assert.ok(listReq.raw.includes(Buffer.from('夸克网盘TV', 'utf8')));
  } finally { A.clearTokenCache(); await s.close(); }
});

test('超时：上游挂起时抛 ALIST_TIMEOUT', async function () {
  const s = await mockServer(function () { /* 故意不回 */ });
  try {
    await assert.rejects(function () {
      return A.requestJson({ host: s.host }, '/api/fs/list', { path: '/' },
        { timeout: 120, resolve: s.opts.resolve });
    }, /ALIST_TIMEOUT/);
  } finally { await s.close(); }
});

test('db：libs 加列幂等，replaceLibs 保留 type/basePath，旧库默认 local', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-alist-db-'));
  const file = path.join(dir, 'fm.db');
  try {
    const db = DB.open(file);
    DB.ensureSchema(db);
    DB.ensureSchema(db); /* 幂等 */
    const cols = db.prepare('PRAGMA table_info(libs)').all().map(function (c) { return c.name; });
    assert.ok(cols.includes('type') && cols.includes('base_path'));

    /* libs.user_id 有外键，先建用户；用低轮数哈希避免拖慢测试 */
    const uid = 'u-test';
    const pw = DB.makePassword('x', 1000);
    DB.addUser(db, { id: uid, username: uid, algo: pw.algo, iterations: pw.iterations, salt: pw.salt, hash: pw.hash });
    DB.replaceLibs(db, uid, [
      { id: 'l1', name: '本地库', path: '/Volumes/media' },
      { id: 'l2', name: '夸克网盘TV', path: 'alist:l2', type: 'alist', basePath: '/夸克网盘TV' }
    ], 'l1');
    const list = DB.listLibs(db, uid);
    assert.equal(list[0].type, 'local');
    assert.equal(list[0].basePath, '/');
    assert.equal(list[1].type, 'alist');
    assert.equal(list[1].basePath, '/夸克网盘TV');
    assert.equal(DB.getLib(db, uid, 'l2').type, 'alist');
    assert.equal(DB.activeLib(db, uid).type, 'local');

    /* 模拟 /api/lib 改名：mutateLibs 保留字段后整份替换，类型不能被抹掉 */
    const again = list.map(function (l) { return { id: l.id, name: l.name + '!', path: l.path, type: l.type, basePath: l.basePath }; });
    DB.replaceLibs(db, uid, again, 'l1');
    assert.equal(DB.getLib(db, uid, 'l2').type, 'alist');
    assert.equal(DB.getLib(db, uid, 'l2').basePath, '/夸克网盘TV');
    db.close();
  } finally {
    /* Windows 上 WAL 句柄可能延迟释放，清理失败不影响断言（与 transcode.test.js 同口径） */
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
});
