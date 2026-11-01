/* 安全相关的回归测试：登录跳转、HTML 转义、封面抓取的内网拦截与体积上限。
   跑法：node --test test */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { escHtml, safeNext } = require('../tools/safe');
const { isBlockedIp, assertPublicUrl, saveCoverForDir, MAX_IMAGE_BYTES } = require('../cover-fetch');

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
