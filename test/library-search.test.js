/* library.js 的 search / searchAll：只用最小桩，不依赖 DOM / 后端。
   覆盖：打分排序、跨库聚合、隐藏口径、scope 派生、缓存失效、脏索引容错。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
require('../js/util.js');
require('../js/pinyin-data.js');
require('../js/search.js');
const FM = global.window.FM;

const mem = {}, metas = {}, indexes = {};
FM.store = {
  read(k, d) { return k in mem ? mem[k] : d; },
  write(k, v) { mem[k] = v; },
  touch() {}
};
FM.db = {
  albumMeta() { return metas; },
  setAlbumMeta(m) {
    if (m === metas) return;         /* 真实实现是落盘；这里本来就是同一个对象 */
    Object.keys(metas).forEach(k => delete metas[k]);
    Object.assign(metas, m);
  },
  durations() { return {}; },
  progress() { return {}; },
  catsFor() { return []; },
  setCatsFor() {},
  indexMode() { return 'flat'; },
  setIndex(id, idx) { indexes[id] = JSON.parse(JSON.stringify(idx)); },
  index(id) { return indexes[id] || null; },
  touch() {}
};
FM.media = { kindOf: () => 'audio' };
const libs = [
  { id: 'la', name: '库A' },
  { id: 'lb', name: '库B' },
  { id: 'lc', name: '库C' }
];
FM.fs = {
  activeId: 'la',
  libs() { return libs; },
  favIds: new Set(),
  favTrackIds: new Set(),
  serverReached: false,
  isAdmin: true,
  pushMeta() {}
};
require('../js/library.js');
const L = FM.lib;

function mkScan(libId, root, dirs) {
  const files = [];
  dirs.forEach(function (d) {
    d[1].forEach(function (n) {
      files.push({ rel: d[0] + '/' + n + '.mp3', name: n + '.mp3', ext: 'mp3', size: 100, mtime: 1, depth: 1 });
    });
  });
  return { libId, root, rootName: root, scannedAt: 1000, dirMode: 'flat', files };
}

const scanA = mkScan('la', '/libA', [['三体', ['01', '02']], ['平凡的世界', ['01']]]);
const scanB = mkScan('lb', '/libB', [['三体·全集', ['三体序曲', '02']], ['明朝那些事', ['01']]]);
L.build(scanA);
L.build(scanB);
L.build(scanA);          /* 切回 A，两个库的 index 缓存都在 */

test('search：全拼命中专辑，精确标题排在目录名命中之前', () => {
  const res = L.search('santi');
  assert.ok(res.albums.length >= 1);
  assert.equal(res.albums[0].title, '三体');
  assert.ok(L.search('pfdsj').albums.some(a => a.title === '平凡的世界'));
});

test('searchAll：当前库在前，其它库索引缓存也参与，未建索引的库单独提示', () => {
  const res = L.searchAll('santi');
  assert.ok(res.albums.length >= 2);
  assert.equal(res.albums[0].self, true);
  assert.equal(res.albums[0].libId, 'la');
  assert.ok(res.albums.some(r => r.libId === 'lb'), '库B 的专辑要出现');
  assert.deepEqual(res.pendingLibs.map(l => l.id), ['lc']);
  assert.equal(res.pendingLibs[0].missing, false);
});

test('跨库曲目与当前库同一套匹配：拼音也能搜到别的库里的单集', () => {
  const res = L.searchAll('三体序曲');
  assert.ok(res.tracks.some(r => r.libId === 'lb' && r.track.title === '三体序曲'));
  assert.ok(res.tracks.every(r => !/\.mp3$/.test(r.track.title)), '匹配的是去扩展名的标题');
  assert.ok(L.searchAll('santi').tracks.some(r => r.libId === 'lb' && r.track.title === '三体序曲'),
    '拼音查询也要能命中跨库单集');
});

test('scope=cur 只返回当前库，且由全量缓存派生', () => {
  const res = L.searchAll('santi', { scope: 'cur' });
  assert.ok(res.albums.length >= 1);
  assert.ok(res.albums.every(r => r.self && r.libId === 'la'));
  assert.deepEqual(res.pendingLibs, []);
});

test('隐藏口径统一：默认排除隐藏专辑及其单集，showHidden 才出现', () => {
  const bIdx = indexes.lb;
  const bAlbum = bIdx.albums.find(a => a.title.indexOf('三体') >= 0);
  const key = bIdx.root + '|' + bAlbum.id;
  metas[key] = { root: bIdx.root, hidden: 1 };
  L.invalidateSearch();                /* 真实路径是 setMeta / refreshMeta / pullMeta */

  const hidden = L.searchAll('santi');
  assert.ok(!hidden.albums.some(r => r.libId === 'lb'), '隐藏专辑不该出现');
  const shown = L.searchAll('santi', { showHidden: true });
  assert.ok(shown.albums.some(r => r.libId === 'lb'), 'showHidden 打开后要能看到');

  const byTitle = L.searchAll('三体序曲');
  assert.ok(!byTitle.tracks.some(r => r.libId === 'lb'), '隐藏专辑的单集也不该被搜出来');
  assert.ok(L.searchAll('三体序曲', { showHidden: true }).tracks.some(r => r.libId === 'lb'));
  delete metas[key];
  L.invalidateSearch();
});

test('setMeta 自己就让缓存失效：当前库隐藏后搜不到，取消隐藏后恢复', () => {
  const a = L.albums().find(x => x.title === '三体');
  L.setMeta(a.id, { hidden: 1 });
  assert.ok(!L.searchAll('santi').albums.some(r => r.self && r.album.id === a.id));
  L.setMeta(a.id, { hidden: 0 });
  assert.ok(L.searchAll('santi').albums.some(r => r.self && r.album.id === a.id));
});

test('元数据变化：缓存失效后，跨库结果里的标题跟着改', () => {
  const bIdx = indexes.lb;
  const ming = bIdx.albums.find(a => a.title === '明朝那些事');
  const key = bIdx.root + '|' + ming.id;
  assert.ok(L.searchAll('明朝那些事').albums.some(r => r.libId === 'lb'));
  assert.equal(L.searchAll('改过的书名').albums.length, 0, '先把这个查询也放进缓存');

  metas[key] = { root: bIdx.root, title: '改过的书名' };
  assert.equal(L.searchAll('改过的书名').albums.length, 0, '缓存未失效时仍是旧结果');
  L.refreshMeta();                     /* 内部会 invalidateSearch */
  const hit = L.searchAll('改过的书名').albums.find(r => r.libId === 'lb');
  assert.ok(hit);
  assert.equal(hit.album.title, '改过的书名');

  delete metas[key];
  L.invalidateSearch();                /* 显式失效也要生效 */
  assert.ok(L.searchAll('明朝那些事').albums.some(r => r.libId === 'lb'));
});

test('脏索引行不抛错，也不会污染结果', () => {
  indexes.lb.tracks.push(['t-dirty', 'a-dirty', '脏行/', undefined, undefined]);
  L.invalidateSearch();
  assert.doesNotThrow(() => L.searchAll('01'));
  indexes.lb.tracks.pop();
});
