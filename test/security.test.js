/* 安全相关的回归测试：登录跳转、HTML 转义、封面抓取的内网拦截与体积上限。
   跑法：node --test test */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { escHtml, safeNext } = require('../tools/safe');
const { isBlockedIp, assertPublicUrl, saveCoverForDir, safeCoverName, MAX_IMAGE_BYTES } = require('../cover-fetch');

test('safeNext：只放行站内单斜杠路径', () => {
  assert.equal(safeNext('//evil.com'), '/');
  assert.equal(safeNext('/\\evil.com'), '/');
  assert.equal(safeNext('http://evil.com'), '/');
  assert.equal(safeNext(''), '/');
  assert.equal(safeNext(null), '/');
  assert.equal(safeNext('/album/abc?a=1'), '/album/abc?a=1');
  /* 控制字符（CRLF）要被剥掉，避免写进 location 头部 */
  assert.equal(safeNext('/a\r\nSet-Cookie: x=1'), '/aSet-Cookie: x=1');
});

test('escHtml：引号尖括号都转义', () => {
  assert.equal(escHtml('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(escHtml(null), '');
});

test('isBlockedIp：本机/私有/链路本地一律拦', () => {
  ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.5', '169.254.169.254', '100.100.1.1',
    '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1'].forEach(function (ip) {
    assert.equal(isBlockedIp(ip), true, ip + ' 应被拦');
  });
  ['8.8.8.8', '93.184.216.34'].forEach(function (ip) {
    assert.equal(isBlockedIp(ip), false, ip + ' 应放行');
  });
});

test('assertPublicUrl：非 http(s) 与内网地址直接拒', async () => {
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), /http\/https/);
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1:8080/x'), /内网/);
  await assert.rejects(() => assertPublicUrl('http://localhost/x'), /内网/);
  await assert.rejects(() => assertPublicUrl('http://[::1]/x'), /内网/);
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/meta-data/'), /内网/);
  /* IP 字面量不需要 DNS，离线也能测 */
  const u = await assertPublicUrl('https://8.8.8.8/a.png');
  assert.equal(u.host, '8.8.8.8');
});

test('safeCoverName：只接受纯文件名，拒绝路径穿越', () => {
  assert.equal(safeCoverName('cover.jpg'), 'cover.jpg');
  assert.equal(safeCoverName('a-b_c.1.png'), 'a-b_c.1.png');
  ['../x.jpg', '..\\x.jpg', 'a/b.jpg', '/etc/passwd', '..', '.', '', null].forEach(function (bad) {
    assert.equal(safeCoverName(bad), null, String(bad) + ' 应被拒');
  });
});

test('saveCoverForDir：file 路径穿越不能写到 coverDir 之外', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-cover-trav-'));
  const url = 'data:image/jpeg;base64,' + Buffer.alloc(1024, 7).toString('base64');
  try {
    const coverDir = path.join(root, '.fm-covers');
    /* 试图用 ../ 写到资源库根目录 */
    const entry = await saveCoverForDir(root, '专辑', { dataUrl: url, file: '../evil.jpg' });
    assert.ok(entry && entry.file, '仍应写出一张封面');
    assert.equal(path.basename(entry.file), entry.file, '文件名必须是不含路径的纯文件名');
    assert.ok(fs.existsSync(path.join(coverDir, entry.file)), '应落在 .fm-covers 内');
    assert.ok(!fs.existsSync(path.join(root, 'evil.jpg')), '不能写到 coverDir 之外');

    /* 绝对路径同样不能落到任意位置 */
    const abs = path.join(os.tmpdir(), 'fm-evil-abs.jpg');
    const entry2 = await saveCoverForDir(root, '专辑2', { dataUrl: url, file: abs });
    assert.equal(path.basename(entry2.file), entry2.file, '绝对路径应被归一化为纯文件名');
    assert.ok(fs.existsSync(path.join(coverDir, entry2.file)));
    assert.ok(!fs.existsSync(abs), '不能写到任意绝对路径');

    /* 合法纯文件名仍然可用 */
    const entry3 = await saveCoverForDir(root, '专辑3', { dataUrl: url, file: 'custom.jpg' });
    assert.equal(entry3.file, 'custom.jpg');
    assert.ok(fs.existsSync(path.join(coverDir, 'custom.jpg')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveCoverForDir：并发写入不会互相覆盖 covers.json 条目', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-cover-race-'));
  const url = 'data:image/jpeg;base64,' + Buffer.alloc(2048, 3).toString('base64');
  try {
    /* 一键抓取是 3 路并发写多张封面：读改写没有串行的话，后写的会把先写的条目抹掉 */
    const names = ['专辑一', '专辑二', '专辑三', '专辑四', '专辑五', '专辑六'];
    await Promise.all(names.map(function (n) { return saveCoverForDir(root, n, { dataUrl: url }); }));
    const map = JSON.parse(fs.readFileSync(path.join(root, '.fm-covers', 'covers.json'), 'utf8'));
    names.forEach(function (n) {
      assert.ok(map[n] && map[n].file, n + ' 的索引条目应保留');
      assert.ok(fs.existsSync(path.join(root, '.fm-covers', map[n].file)), n + ' 的封面文件应在盘上');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveCoverForDir：超过 2MB 的上传被拒，正常尺寸能落盘', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-cover-test-'));
  const url = bytes => 'data:image/jpeg;base64,' + Buffer.alloc(bytes, 7).toString('base64');
  try {
    await assert.rejects(() => saveCoverForDir(root, '超大三体', { dataUrl: url(MAX_IMAGE_BYTES + 1024) }), /图片太大/);
    const entry = await saveCoverForDir(root, '三体', { dataUrl: url(64 * 1024) });
    assert.ok(entry && entry.file, '应写入封面文件');
    assert.ok(fs.existsSync(path.join(root, '.fm-covers', entry.file)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
