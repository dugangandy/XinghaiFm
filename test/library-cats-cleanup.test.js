/* build() 重扫时的目录分类对账：只按本轮扫描结果留下 d 分类，
   并清掉 album_meta 里指向已删分类的引用（含已消失专辑的孤儿行）。
   用最小桩跑 build，不依赖 DOM / 后端。跑法：node --test test */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
require('../js/util.js');
const FM = global.window.FM;
const U = FM.util;

const mem = {};
let metas = {};
let cats = [];
let patches = [];
let mode = 'cat';

FM.store = {
  read(k, d) { return k in mem ? mem[k] : d; },
  write(k, v) { mem[k] = v; },
  touch() {}
};
FM.db = {
  albumMeta() { return metas; },
  setAlbumMeta(m) {
    if (m === metas) return;
    Object.keys(metas).forEach(k => delete metas[k]);
    Object.assign(metas, m);
  },
  durations() { return {}; },
  progress() { return {}; },
  catsFor() { return cats; },
  setCatsFor(id, list) { cats = list; },
  indexMode() { return mode; },
  saveIndexNow() { return { ok: true, chars: 0 }; },
  index() { return null; },
  touch() {}
};
FM.media = { kindOf: () => 'audio' };
FM.fs = {
  activeId: 'lib1',
  libs() { return [{ id: 'lib1', name: '测试库', path: '/lib' }]; },
  favIds: new Set(),
  favTrackIds: new Set(),
  serverReached: false,
  isAdmin: true,
  pushMeta(p) { patches.push(p); }
};
require('../js/library.js');
const L = FM.lib;

function f(rel) {
  const segs = rel.split('/');
  const name = segs[segs.length - 1];
  return { rel, name, ext: 'mp3', size: 1024, mtime: 0, depth: segs.length };
}
function mkScan(rels, m) {
  return {
    libId: 'lib1', root: '/lib', rootName: '测试库', scannedAt: 1000,
    dirMode: m || mode, files: rels.map(f)
  };
}
function reset(m) {
  Object.keys(mem).forEach(k => delete mem[k]);
  Object.keys(metas).forEach(k => delete metas[k]);
  cats = [];
  patches = [];
  mode = m || 'cat';
  FM.fs.serverReached = false;
  FM.fs.isAdmin = true;
}
function deletedIds() {
  return patches.reduce((acc, p) => acc.concat(p.catsDeleted || []), []);
}
function metaKeyOf(rel) { return '/lib|' + U.uid('a', rel); }

const dHist = L.dirCatId('历史');
const dOld = L.dirCatId('旧目录');
const dLit = L.dirCatId('文学');

test('重扫对账：目录已删，孤儿专辑的引用不再给残留 d 分类续命', () => {
  reset('cat');
  cats = [
    { id: dHist, name: '历史', order: 0 },
    { id: dOld, name: '旧目录', order: 1 },
    { id: 'c1', name: '手工分类', order: 2 }
  ];
  const live = metaKeyOf('历史/明朝那些事');
  const orphan = metaKeyOf('旧目录/已删的书');
  metas[live] = { cats: [dHist], auto: true, root: '/lib' };
  /* 目录删掉后 album_meta 的旧行还在，它引用着 dOld */
  metas[orphan] = { cats: [dOld], auto: true, root: '/lib' };

  L.build(mkScan(['历史/明朝那些事/01.mp3']));
  assert.deepEqual(deletedIds(), [], '第一轮缺失只记候选，不删');

  /* 第二轮仍然缺这个目录，才认定是真删了 */
  L.build(mkScan(['历史/明朝那些事/01.mp3']));

  assert.deepEqual(deletedIds(), [dOld], '残留目录分类要落库删行');
  assert.deepEqual(cats.map(c => c.id).sort(), [dHist, 'c1'].sort(), '手工分类和现存目录分类都保留');
  assert.deepEqual(metas[live].cats, [dHist], '活专辑的归类不受影响');
  assert.deepEqual(metas[orphan].cats, [], '孤儿行里指向已删分类的引用也要清掉，免得拉快照又灌回来');
  assert.ok(patches.some(p => p.albumMeta && p.albumMeta[orphan]), '引用清理要推给数据库');
});

test('切回平铺：全部目录分类清掉，归类引用一起清，手工分类不动', () => {
  reset('flat');
  cats = [
    { id: dHist, name: '历史', order: 0 },
    { id: dLit, name: '文学', order: 1 },
    { id: 'c1', name: '手工分类', order: 2 }
  ];
  const live = metaKeyOf('历史');
  metas[live] = { cats: [dHist, 'c1'], auto: false, root: '/lib' };

  L.build(mkScan(['三体/01.mp3']));

  assert.deepEqual(deletedIds().sort(), [dHist, dLit].sort());
  assert.deepEqual(cats.map(c => c.id), ['c1']);
  assert.deepEqual(metas[live].cats, ['c1'], '人工归类里指向已删分类的引用也要清掉');
});

test('目录仍在：即使有孤儿行引用也不误删', () => {
  reset('cat');
  cats = [{ id: dHist, name: '历史', order: 0 }];
  metas[metaKeyOf('历史/已删的书')] = { cats: [dHist], auto: true, root: '/lib' };

  L.build(mkScan(['历史/明朝那些事/01.mp3']));

  assert.deepEqual(deletedIds(), []);
  assert.equal(cats[0].id, dHist);
});

test('本轮活专辑手工挂在已删目录分类下：仍然保留，不误删用户整理', () => {
  reset('cat');
  cats = [
    { id: dHist, name: '历史', order: 0 },
    { id: dOld, name: '旧目录', order: 1 }
  ];
  const live = metaKeyOf('历史/明朝那些事');
  metas[live] = { cats: [dOld], auto: false, root: '/lib' };

  L.build(mkScan(['历史/明朝那些事/01.mp3']));

  assert.deepEqual(deletedIds(), [], '活专辑的引用仍有保护力');
  assert.ok(cats.some(c => c.id === dOld));
});

test('cats 默认按名称排序，手动排序按 order 并保留隐藏分类位置', () => {
  reset('cat');
  cats = [
    { id: 'z', name: '乙', order: 0 },
    { id: dHist, name: '目录分类', order: 1 },
    { id: 'a', name: '甲', order: 2 }
  ];
  L.build(mkScan(['专辑/01.mp3'], 'flat'));
  cats = [
    { id: 'z', name: '乙', order: 0 },
    { id: dHist, name: '目录分类', order: 1 },
    { id: 'a', name: '甲', order: 2 }
  ];
  assert.deepEqual(L.cats().map(c => c.id), ['a', 'z']);
  assert.equal(L.reorderCats(['z', 'a']), true);
  assert.deepEqual(L.cats().map(c => c.id), ['z', 'a']);
  assert.deepEqual(cats.map(c => c.id), ['z', dHist, 'a']);
  assert.deepEqual(cats.map(c => c.order), [0, 1, 2]);
  assert.equal(mem['catsManual:lib1'], true);
  assert.equal(patches[patches.length - 1].catsManual, true);
  assert.equal(L.reorderCats(['z', 'missing']), false);
});

test('add/update 分类保留目录分类，新增类别编号排在末尾', () => {
  reset('cat');
  cats = [
    { id: 'c1', name: '甲', order: 0 },
    { id: dHist, name: '目录分类', order: 1 },
    { id: 'c2', name: '乙', order: 2 }
  ];
  L.build(mkScan(['专辑/01.mp3'], 'cat'));
  L.updateCat('c1', { name: '新名称' });
  assert.ok(cats.some(c => c.id === dHist));
  const added = L.addCat('丙', '#fff');
  assert.equal(cats.find(c => c.id === added).order, 4);
  assert.ok(cats.some(c => c.id === dHist));
});

test('普通网页用户无写权限：跳过对账，只靠展示层隐藏', () => {
  reset('flat');
  FM.fs.serverReached = true;
  FM.fs.isAdmin = false;
  cats = [{ id: dHist, name: '历史', order: 0 }];

  L.build(mkScan(['三体/01.mp3']));

  assert.deepEqual(deletedIds(), []);
  assert.deepEqual(L.cats(), [], '平铺模式下展示层仍然隐藏 d 分类');
  assert.equal(L.reorderCats([dHist]), false, '普通网页用户即使调用模型方法也不能更改顺序');
});

test('空扫描结果（掉盘/扫描失败）：不按「全都不存在」对账', () => {
  reset('cat');
  cats = [{ id: dHist, name: '历史', order: 0 }];
  const live = metaKeyOf('历史/明朝那些事');
  metas[live] = { cats: [dHist], auto: true, root: '/lib' };

  L.build(mkScan([]));

  assert.deepEqual(deletedIds(), [], '这一轮没读到 ≠ 目录都删了');
  assert.deepEqual(cats.map(c => c.id), [dHist]);
  assert.deepEqual(metas[live].cats, [dHist]);
});

test('部分目录读不到（掉盘）：一轮残缺扫描不动分类，连续两轮才清', () => {
  reset('cat');
  cats = [
    { id: dHist, name: '历史', order: 0 },
    { id: dLit, name: '文学', order: 1 }
  ];
  metas[metaKeyOf('历史/明朝那些事')] = { cats: [dHist], auto: true, root: '/lib' };
  const partial = mkScan(['历史/明朝那些事/01.mp3']);

  L.build(partial);
  assert.deepEqual(deletedIds(), [], '第一次缺失只是候选，分类和引用都还在');
  assert.ok(cats.some(c => c.id === dLit), '文学分类不能被一轮残缺扫描清掉');

  L.build(partial);
  assert.deepEqual(deletedIds(), [dLit], '连续两轮缺失才落库删行');
});

test('缺失的目录又回来了：候选作废，重新从头计数', () => {
  reset('cat');
  cats = [
    { id: dHist, name: '历史', order: 0 },
    { id: dLit, name: '文学', order: 1 }
  ];

  L.build(mkScan(['历史/明朝那些事/01.mp3']));                        /* 文学缺失 → 候选 */
  L.build(mkScan(['历史/明朝那些事/01.mp3', '文学/散文集/01.mp3']));  /* 文学回来 → 候选清空 */
  L.build(mkScan(['历史/明朝那些事/01.mp3']));                        /* 再次缺失，只算第一轮 */

  assert.deepEqual(deletedIds(), [], '候选被目录重新出现打断过，不能累计');
  assert.ok(cats.some(c => c.id === dLit));
});

test('本地分类缓存落后于数据库：只清本次删掉的分类，别的引用不动', () => {
  reset('cat');
  /* 本地只有 c1，服务端其实还有 c2（这次扫描没先 pullMeta） */
  cats = [{ id: 'c1', name: '手工分类', order: 0 }];
  const live = metaKeyOf('历史/明朝那些事');
  metas[live] = { cats: ['c1', 'c2'], auto: false, root: '/lib' };

  L.build(mkScan(['历史/明朝那些事/01.mp3']));

  assert.deepEqual(deletedIds(), []);
  assert.deepEqual(metas[live].cats, ['c1', 'c2'], '缓存里暂时没有的分类不能当成已删除');
});
