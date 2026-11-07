/* covers.js 的跨库封面：别的资源库的索引按需读一次，再按目录名/相似度查封面。
   只用最小桩（server 模式），不碰 DOM。覆盖：按库分别读、重复读只读一次、
   目录名精确/相似命中、查不到返回 null、读失败短时间不重试、当前库不走这套。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
const FM = (global.window.FM = global.window.FM || {});

const INDEXES = {
  la: { '专辑一': { file: 'a1.jpg' } },
  lb: {
    '曾仕强的易经': { file: 'b1.jpg' },
    '无关目录': { file: 'b2.jpg' }
  }
};
let fetchCount = 0;
let failing = false;

FM.fs = {
  activeId: 'la',
  native: false,
  server: true,
  async apiFetch(url) {
    fetchCount++;
    if (failing) return { ok: false, status: 500 };
    const m = /libId=([^&]+)/.exec(url || '');
    const id = m ? decodeURIComponent(m[1]) : 'la';
    return { ok: true, async json() { return INDEXES[id] || {}; } };
  },
  async signedUrl(p, libId) {
    return p + '?libId=' + encodeURIComponent(libId === undefined ? 'la' : libId);
  }
};

require('../js/covers.js');
const C = FM.covers;

test('跨库封面：先读索引，读完后按目录名精确命中', async () => {
  assert.equal(C.forAlbum({ dirName: '曾仕强的易经' }, 'lb'), null, '索引还没读到时返回 null');
  const loaded = await C.ensureLib('lb');
  assert.equal(loaded, true);
  const url = C.forAlbum({ dirName: '曾仕强的易经' }, 'lb');
  assert.ok(url && url.indexOf('b1.jpg') >= 0, '应拿到 B 库那张图：' + url);
  assert.ok(url.indexOf('libId=lb') >= 0, '封面地址必须带 B 库，否则服务端会按当前库解析');
});

test('跨库封面：同一库只读一次，第二次不再打接口', async () => {
  const before = fetchCount;
  assert.equal(await C.ensureLib('lb'), false, '已读过就该返回 false（调用方据此决定不重绘）');
  assert.equal(fetchCount, before, '不该重复请求');
});

test('跨库封面：目录名带后缀时按相似度复用，差太远就退回渐变', async () => {
  assert.ok(C.forAlbum({ dirName: '曾仕强的易经 完结' }, 'lb'), '加了后缀也复用同一张');
  assert.equal(C.forAlbum({ dirName: '完全不相干的书名' }, 'lb'), null);
  assert.equal(C.forAlbum({ dirName: '' }, 'lb'), null, '没有目录名时不硬套');
});

test('跨库封面：当前库走 a.cover，不在这里查', async () => {
  assert.equal(C.forAlbum({ dirName: '专辑一' }, 'la'), null);
  assert.equal(await C.ensureLib('la'), false);
});

test('跨库封面：读失败后短时间内不重试', async () => {
  failing = true;
  const before = fetchCount;
  assert.equal(await C.ensureLib('lc'), false);
  assert.equal(await C.ensureLib('lc'), false);
  assert.equal(fetchCount - before, 1, '失败只该打一次接口，别每敲一个字都重试');
  failing = false;
});
