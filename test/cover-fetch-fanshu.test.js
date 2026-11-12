/* 帆书官方书目的书名匹配：目录名剥日期前缀、相似度、日期兜底、封面尺寸解析。
   跑法：node --test test */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('../cover-fetch');

test('baseName：剥掉 MMDD 前缀和书名号', () => {
  assert.equal(C.baseName('0106《战安庆》'), '战安庆');
  assert.equal(C.baseName('0424如何克服社交恐惧'), '如何克服社交恐惧');
  assert.equal(C.baseName(' 0117 商解西游'), '商解西游', '前导空格也要吃掉');
  assert.equal(C.baseName('《三体》'), '三体');
  assert.equal(C.baseName(''), '');
});

test('bookScore：同名 1.0，整段包含 0.9，不相关接近 0', () => {
  assert.equal(C.bookScore('0106《战安庆》', '战安庆'), 1);
  assert.ok(C.bookScore('0106《战安庆》', '战安庆·樊登讲书') >= 0.9, '官方标题带卖点尾巴也要认');
  assert.ok(C.bookScore('0424如何克服社交恐惧', '如何克服社交焦虑') >= 0.6, '相差几个字仍要留下');
  assert.ok(C.bookScore('战安庆', '三体') < 0.2);
});

test('mmddOf / publishMd：只认合法月日', () => {
  assert.equal(C.mmddOf('0424如何克服社交恐惧'), '0424');
  assert.equal(C.mmddOf(' 0117 商解西游'), '0117');
  assert.equal(C.mmddOf('2020年'), '', '20 月不是合法月');
  assert.equal(C.mmddOf('1301 某书'), '', '13 月不是合法月');
  assert.equal(C.mmddOf('战安庆'), '');
  assert.equal(C.publishMd(Date.UTC(2022, 3, 24)), '0424', 'UTC 时间戳按北京时间算月日');
  assert.equal(C.publishMd(0), '');
});

test('matchOfficial：书名不够像时，发布日期对得上也采信', () => {
  const books = [
    { id: '1', title: '如何克服社交焦虑', cover: 'https://x/1.jpg', publishTime: Date.UTC(2022, 3, 24) },
    { id: '2', title: '完全无关的书', cover: 'https://x/2.jpg', publishTime: Date.UTC(2022, 5, 1) }
  ];
  const hit = C.matchOfficial('0424如何克服社交恐惧', books);
  assert.ok(hit, '应靠 0424 命中');
  assert.equal(hit.book.id, '1');
  assert.ok(hit.score >= 0.6);

  assert.equal(C.matchOfficial('0101某个名字', books), null, '日期和书名都对不上就不认');
  assert.equal(C.matchOfficial('', books), null);
});

test('imageSize：PNG/JPEG 读宽高，认不出返回 null', () => {
  const png = Buffer.alloc(32);
  png.writeUInt8(0x89, 0);
  png.write('PNG', 1, 'ascii');
  png.writeUInt32BE(168, 16);
  png.writeUInt32BE(224, 20);
  assert.deepEqual(C.imageSize(png), { w: 168, h: 224 });

  const jpg = Buffer.alloc(32);
  jpg.writeUInt8(0xff, 0); jpg.writeUInt8(0xd8, 1);
  jpg.writeUInt8(0xff, 2); jpg.writeUInt8(0xc0, 3);
  jpg.writeUInt16BE(17, 4);            /* 段长度 */
  jpg.writeUInt8(8, 6);
  jpg.writeUInt16BE(300, 7);           /* 高 */
  jpg.writeUInt16BE(400, 9);           /* 宽 */
  assert.deepEqual(C.imageSize(jpg), { w: 400, h: 300 });

  assert.equal(C.imageSize(Buffer.from('not an image at all........')), null);
  assert.equal(C.imageSize(null), null);
});

test('albumDirs：根目录有 YYYY年 就下钻一层，索引键不带年份', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-covers-dirs-'));
  try {
    fs.mkdirSync(path.join(root, '2024年', '0106《战安庆》'), { recursive: true });
    fs.mkdirSync(path.join(root, '2025年', '0101 某书'), { recursive: true });
    fs.mkdirSync(path.join(root, 'MP3'), { recursive: true });
    const list = await C.albumDirs(root, '');
    assert.deepEqual(list.map(function (x) { return x.name; }), ['0106《战安庆》', '0101 某书']);
    assert.deepEqual(list.map(function (x) { return x.year; }), [2024, 2025]);
    assert.equal((await C.albumDirs(root, '战安庆')).length, 1, '--only 仍按专辑名过滤');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
