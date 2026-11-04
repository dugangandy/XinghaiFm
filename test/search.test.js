/* js/search.js 的匹配与历史：纯函数，不依赖 DOM。
   跑法：node --test test */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {};
require('../js/util.js');
require('../js/pinyin-data.js');
require('../js/search.js');
const FM = global.window.FM;
const S = FM.search;

test('拼音表随仓库提交且完整（漏打包会静默退化，必须挡住）', () => {
  const raw = String(FM.pinyinData || '');
  assert.ok(raw.length > 100000, 'js/pinyin-data.js 缺失或体积异常');
  assert.ok(raw.indexOf('三:san') >= 0 && raw.indexOf('体:ti') >= 0);
  assert.ok(raw.indexOf('长:chang,zhang') >= 0 || raw.indexOf('长:zhang,chang') >= 0);
});

test('生成物与字典版本一致（装了开发依赖才校验）', () => {
  let version;
  try { version = require('pinyin-pro/package.json').version; } catch (e) { return; }
  const head = fs.readFileSync(path.join(__dirname, '..', 'js', 'pinyin-data.js'), 'utf8').slice(0, 400);
  assert.ok(head.indexOf('pinyin-pro ' + version) >= 0, '拼音表过时了，请运行 npm run gen:pinyin');
});

test('拼音表：三体 → santi / st', () => {
  const py = S.pinyinOf('三体');
  assert.equal(py.full, 'santi');
  assert.equal(py.initials, 'st');
});

test('全拼：santi 与 san ti 都能命中三体', () => {
  assert.ok(S.scoreText('三体', 'santi') > 0);
  assert.ok(S.scoreText('三体', 'san ti') > 0);
  assert.equal(S.scoreText('三体', 'santi'), 58);
});

test('首字母：st 命中三体，且排在「完全子串」之后', () => {
  const st = S.scoreText('三体', 'st');
  assert.ok(st > 0);
  assert.ok(st < S.scoreText('三体', '三'));
});

test('模糊：字母子序列 snti 命中三体，3 字母以下不参与（降噪）', () => {
  assert.equal(S.scoreText('三体', 'snti'), 22);
  assert.equal(S.scoreText('三体', 'sn'), 0);
  assert.equal(S.scoreText('三体', 'snt'), 0);
});

test('带标点的拼音查询：san-ti / santi! 与 san ti 等价', () => {
  assert.equal(S.scoreText('三体', 'san-ti'), 58);
  assert.equal(S.scoreText('三体', 'santi!'), 58);
});

test('多音字变体：chongqing / yinhang 能命中重庆 / 银行', () => {
  assert.ok(S.scoreText('重庆', 'chongqing') > 0);
  assert.ok(S.scoreText('银行', 'yinhang') > 0);
});

test('中文查询仍走子串，不做拼音拆解', () => {
  assert.equal(S.scoreText('三体', '三'), 85);
  assert.equal(S.scoreText('三体', '体'), 70);
  assert.equal(S.scoreText('三体全集', '三体'), 85);
  assert.equal(S.scoreText('三体', '四体'), 0);
});

test('英文标题按字母子串，不受拼音影响', () => {
  assert.equal(S.scoreText('Kubernetes 入门', 'kube'), 85);
  assert.ok(S.scoreText('Kubernetes 入门', 'k8s') === 0);
});

test('专辑打分：标题优先于标签，标签仍可命中', () => {
  const titleHit = { title: '三体', tags: [] };
  const tagHit = { title: '科幻合集', tags: ['三体'] };
  assert.ok(S.scoreAlbum(titleHit, '三体') > S.scoreAlbum(tagHit, '三体'));
  assert.ok(S.scoreAlbum(tagHit, 'santi') > 0);
  assert.equal(S.scoreAlbum({ title: '平凡的世界', tags: [] }, 'santi'), 0);
});

test('搜索历史：去重前移、最多 12 条、忽略单字、可清空', () => {
  const store = {
    data: {},
    read(key, def) { return key in this.data ? this.data[key] : def; },
    write(key, v) { this.data[key] = v; },
    touch() {}
  };
  FM.store = store;

  S.history.clear();
  assert.deepEqual(S.history.list(), []);

  S.history.push('三体');
  S.history.push('平凡的世界');
  S.history.push('三体');
  let list = S.history.list();
  assert.deepEqual(list.map(x => x.q), ['三体', '平凡的世界'], '重复查询移到最前面且不重复');

  S.history.push('a');
  assert.equal(S.history.list().length, 2, '单字查询不记录');

  for (let i = 0; i < 20; i++) S.history.push('关键词' + i);
  list = S.history.list();
  assert.equal(list.length, 12, '最多保留 12 条');
  assert.equal(list[0].q, '关键词19', '最新的排最前');

  S.history.clear();
  assert.deepEqual(S.history.list(), []);
});
