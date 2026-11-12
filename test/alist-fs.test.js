/* P3 前端：Alist 票据 URL 拼装与按「库+曲目」分离缓存。
   用最小全局桩加载 js/fs.js（无 DOM），不改动页面对象。
   跑法：node --test test/alist-fs.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const calls = [];
global.window = {
  location: { pathname: '/', search: '', hash: '', href: 'http://localhost/' },
  addEventListener: function () {},
  fmNative: { isDesktop: true, remote: { base: 'http://127.0.0.1:8080', token: 'tk' } },
  FM: {
    util: { NET_FAIL: '网络失败' },
    media: {
      ALL: { mp3: 1, flac: 1 },
      needsTranscode: function (ext) { return ext === 'flv'; },
      unsupported: function (ext) { return ['wma', 'ape', 'wv'].indexOf(ext) >= 0; }
    }
  }
};
global.document = { addEventListener: function () {} };
global.localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
/* Node 22 的 global.navigator 是只读 getter，用 defineProperty 覆盖 */
try { Object.defineProperty(global, 'navigator', { value: { onLine: true }, configurable: true }); } catch (e) {}
global.fetch = async function (url) {
  calls.push(String(url));
  return {
    ok: true, status: 200,
    headers: { get: function () { return null; } },
    json: async function () { return { t: 'TICKET', exp: Math.floor(Date.now() / 1000) + 3600, scope: 'alist' }; }
  };
};
require('../js/fs.js');
const FM = global.window.FM;

function rawPath(rel) { return '/api/alist/raw?rel=' + encodeURIComponent(rel); }

test('signedUrl：alist 票据绑定 libId+rel，每集一张票', async function () {
  const rel = '音乐/单曲.flac';
  const u1 = await FM.fs.signedUrl(rawPath(rel), 'l2', { scope: 'alist', rel: rel });
  assert.match(u1, /^http:\/\/127\.0\.0\.1:8080\/api\/alist\/raw/);
  assert.match(u1, /libId=l2/);
  assert.match(u1, /t=TICKET/);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/api\/ticket\?scope=alist/);
  assert.match(calls[0], /libId=l2/);
  assert.match(calls[0], /rel=/);

  /* 同一集复用票据缓存 */
  await FM.fs.signedUrl(rawPath(rel), 'l2', { scope: 'alist', rel: rel });
  assert.equal(calls.length, 1, '同一集不应重复换票');

  /* 换集必须换票（票据绑定 rel） */
  const rel2 = '音乐/另一首.mp3';
  await FM.fs.signedUrl(rawPath(rel2), 'l2', { scope: 'alist', rel: rel2 });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1], calls[0], '两集的取票 URL 必须不同');

  /* 换库也要换票 */
  await FM.fs.signedUrl(rawPath(rel), 'l3', { scope: 'alist', rel: rel });
  assert.equal(calls.length, 3);
  assert.match(calls[2], /libId=l3/);
});

test('signedUrl：media/cover 的既有 scope 不受影响', async function () {
  const before = calls.length;
  const u = await FM.fs.signedUrl('/api/media/a.mp3', 'l1');
  assert.match(u, /libId=l1/);
  assert.match(u, /t=TICKET/);
  assert.match(calls[calls.length - 1], /scope=media/);
  assert.equal(calls.length, before + 1);
});
