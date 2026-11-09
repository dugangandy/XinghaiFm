/* P2：网盘目录扫描与 /api/scan 分派的回归测试。
   - 单元：mock OpenList 目录树，验证递归、中文 rel、深度、过滤、失败不产出半份快照
   - 集成：启动 serve.js + 临时 DB，验证 alist 库缓存命中 / scan/at / stale / 未配置错误码
   跑法：node --test test/alist-scan.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DB = require('../db');
const A = require('../tools/alist');
const MEDIA_EXT = new Set(['m4a', 'm4b', 'mp3', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'ape', 'wv',
  'mp4', 'm4v', 'mov', 'webm', 'ogv', 'flv']);
const SKIP_DIR = /^[._]/;

const TREE = {
  '/夸克网盘TV': [
    { name: '音乐', is_dir: true, size: 0 },
    { name: '.隐藏目录', is_dir: true, size: 0 },
    { name: '说明.pdf', is_dir: false, size: 10 },
    { name: '顶层.mp3', is_dir: false, size: 100, modified: '2025-01-01T00:00:00Z' }
  ],
  '/夸克网盘TV/音乐': [
    { name: '如愿', is_dir: true, size: 0 },
    { name: '单曲.flac', is_dir: false, size: 158000000, modified: '2025-02-03T04:05:06Z' }
  ],
  '/夸克网盘TV/音乐/如愿': [
    { name: '如愿 - 王菲.flac', is_dir: false, size: 200, modified: '2025-03-04T00:00:00Z' },
    { name: 'cover.jpg', is_dir: false, size: 5 }
  ]
};

function mockTree(opts) {
  const o = opts || {};
  const srv = http.createServer(function (req, res) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      let body = null;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch (e) {}
      const reply = function (code, obj) {
        const buf = Buffer.from(JSON.stringify(obj), 'utf8');
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
        res.end(buf);
      };
      if (req.url === '/api/auth/login') return reply(200, { code: 200, data: { token: 'tk' } });
      if (req.url === '/api/fs/list') {
        const p = String((body && body.path) || '');
        if (o.failAt && p === o.failAt) return reply(500, { code: 500, message: 'boom' });
        return reply(200, { code: 200, data: { content: TREE[p] || [], total: (TREE[p] || []).length, provider: 'QuarkTV' } });
      }
      reply(404, { code: 404, message: 'not found' });
    });
  });
  return new Promise(function (resolve) {
    srv.listen(0, '127.0.0.1', function () {
      resolve({
        host: 'http://127.0.0.1:' + srv.address().port,
        resolve: async function (rawUrl) { return { url: new URL(rawUrl), address: '127.0.0.1', family: 4 }; },
        close: function () { return new Promise(function (r) { srv.close(r); }); }
      });
    });
  });
}

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

test('saveConfig/readConfig：凭据加密落库，接口不回明文', function () {
  const db = DB.open(':memory:');
  DB.ensureSchema(db);
  A.saveConfig(db, 'l2', {
    host: 'http://public.example:5244', username: 'admin', password: 'secret-pw', token: 'secret-tk',
    base: '/夸克网盘TV', cdn: ['*.drive.quark.cn']
  });
  const raw = DB.getSetting(db, 'alist:l2:cred', '');
  assert.ok(raw && !raw.includes('secret-pw') && !raw.includes('secret-tk'), '密文里不能出现明文凭据');
  const cfg = A.readConfig(db, 'l2');
  assert.equal(cfg.host, 'http://public.example:5244');
  assert.equal(cfg.username, 'admin');
  assert.equal(cfg.password, 'secret-pw');
  assert.equal(cfg.token, 'secret-tk');
  assert.equal(cfg.base, '/夸克网盘TV');
  assert.deepEqual(cfg.cdn, ['*.drive.quark.cn']);
  A.deleteConfig(db, 'l2');
  assert.equal(A.readConfig(db, 'l2'), null);
  assert.equal(A.encryptCred && A.decryptCred('bad-secret', raw), null, '错误密钥解不开');
  db.close();
});

test('scanFolderAlist：递归、中文 rel、深度上限、隐藏目录与扩展名过滤', async function () {
  const s = await mockTree();
  try {
    const lib = { id: 'l2', name: '夸克网盘TV', path: 'alist:l2', basePath: '/夸克网盘TV' };
    const cfg = { host: s.host, token: 'tk', base: '/夸克网盘TV' };
    const out = await A.scanFolderAlist(lib, cfg, {
      resolve: s.resolve, mediaExt: MEDIA_EXT, skipDir: SKIP_DIR, maxDepth: 2
    });
    assert.equal(out.root, 'alist:l2');
    assert.equal(out.rootName, '夸克网盘TV');
    assert.equal(out.source, 'alist');
    const rels = out.files.map(function (f) { return f.rel; }).sort();
    assert.deepEqual(rels, ['顶层.mp3', '音乐/单曲.flac'].sort());
    const flac = out.files.find(function (f) { return f.name === '单曲.flac'; });
    assert.equal(flac.ext, 'flac');
    assert.equal(flac.size, 158000000);
    assert.equal(flac.mtime, Date.parse('2025-02-03T04:05:06Z'));
    assert.equal(flac.depth, 2);
    assert.ok(!rels.some(function (r) { return r.indexOf('.隐藏') >= 0 || r.endsWith('.pdf') || r.endsWith('.jpg'); }));
    assert.ok(!rels.some(function (r) { return r.indexOf('如愿 - 王菲') >= 0; }), '超过 maxDepth 不再递归');

    /* 深度放到 3 才能拿到第三层文件 */
    const deep = await A.scanFolderAlist(lib, cfg, {
      resolve: s.resolve, mediaExt: MEDIA_EXT, skipDir: SKIP_DIR, maxDepth: 3
    });
    assert.ok(deep.files.some(function (f) { return f.rel === '音乐/如愿/如愿 - 王菲.flac'; }));
  } finally { A.clearTokenCache(); await s.close(); }
});

test('scanFolderAlist：任一层列目录失败都抛错，不产出半份快照', async function () {
  const s = await mockTree({ failAt: '/夸克网盘TV/音乐' });
  try {
    await assert.rejects(function () {
      return A.scanFolderAlist({ id: 'l2', name: '网盘', path: 'alist:l2' },
        { host: s.host, token: 'tk', base: '/夸克网盘TV' },
        { resolve: s.resolve, mediaExt: MEDIA_EXT, skipDir: SKIP_DIR, maxDepth: 3 });
    }, /ALIST_UNREACHABLE/);
  } finally { A.clearTokenCache(); await s.close(); }
});

test('/api/scan：alist 库缓存命中 / scan/at / stale 回退 / 未配置错误码', async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-alist-scan-'));
  const dbFile = path.join(dir, 'fm.db');
  const db = DB.open(dbFile);
  DB.ensureSchema(db);
  const pw = DB.makePassword('pw');
  const user = DB.addUser(db, { username: 'admin2', role: 'admin', algo: pw.algo, iterations: pw.iterations, salt: pw.salt, hash: pw.hash });
  const uid = user.id;
  const ins = db.prepare('INSERT INTO libs(id,user_id,name,path,added_at,active,position,watch,type,base_path) VALUES(?,?,?,?,?,?,?,?,?,?)');
  ins.run('l2', uid, '夸克网盘TV', 'alist:l2', Date.now(), 1, 0, 0, 'alist', '/夸克网盘TV');
  ins.run('l3', uid, '未配置库', 'alist:l3', Date.now(), 0, 1, 0, 'alist', '/KY');
  const snapshot = {
    rootName: '夸克网盘TV', root: 'alist:l2', scannedAt: Date.now(), source: 'alist',
    files: [{ rel: '音乐/单曲.flac', name: '单曲.flac', ext: 'flac', size: 10, mtime: 1, depth: 2 }]
  };
  const k = 'scan:' + DB.libRootKey('alist:l2');
  DB.setSetting(db, k, JSON.stringify(snapshot));
  DB.setSetting(db, k + ':at', String(snapshot.scannedAt));
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
      body: JSON.stringify({ username: 'admin2', password: 'pw' })
    });
    const token = (await lr.json()).token;
    const H = { authorization: 'Bearer ' + token };

    const cached = await (await fetch(base + '/api/scan?libId=l2', { headers: H })).json();
    assert.equal(cached.root, 'alist:l2');
    assert.equal(cached.files[0].rel, '音乐/单曲.flac');
    assert.equal(cached.libId, 'l2');
    assert.ok(Object.prototype.hasOwnProperty.call(cached, 'dirMode'));

    const at = await (await fetch(base + '/api/scan/at?libId=l2', { headers: H })).json();
    assert.equal(at.scannedAt, snapshot.scannedAt);

    /* refresh=1 但没有连接配置：不能清空旧列表，应回 stale 快照 */
    const stale = await (await fetch(base + '/api/scan?libId=l2&refresh=1', { headers: H })).json();
    assert.equal(stale.stale, true);
    assert.equal(stale.files.length, 1, '旧快照必须保留');

    /* 没有旧缓存的库：返回结构化 ALIST_UNCONFIGURED，不是 500 scan failed */
    const r3 = await fetch(base + '/api/scan?libId=l3&refresh=1', { headers: H });
    assert.equal(r3.status, 502);
    const e3 = await r3.json();
    assert.equal(e3.error.code, 'ALIST_UNCONFIGURED');
  } finally {
    if (proc && !proc.killed) proc.kill();
  }
});
