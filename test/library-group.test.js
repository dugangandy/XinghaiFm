/* js/library.js 的分组口径：groupFiles 是纯函数，给个最小 window 壳直接 require。
   两种模式都要覆盖：平铺（默认）与「按目录分两级」（一层=分类、二层=专辑）。
   跑法：node --test test */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
require('../js/util.js');
const U = global.window.FM.util;
require('../js/library.js');
const L = global.window.FM.lib;

/* 生成扫描结果里的一条文件记录（depth 按层级算，和 walk 一致） */
function f(rel) {
  const segs = rel.split('/');
  const name = segs[segs.length - 1];
  const dot = name.lastIndexOf('.');
  return {
    rel: rel,
    name: name,
    ext: dot < 0 ? '' : name.slice(dot + 1).toLowerCase(),
    size: 1024,
    mtime: 0,
    depth: segs.length
  };
}

function keys(list) {
  return list.map(g => g.key).sort();
}

test('平铺模式：一层子目录就是专辑，根目录文件单独一组', () => {
  const groups = L.groupFiles([
    f('三体/01.mp3'), f('三体/02.mp3'),
    f('平凡的世界/01.mp3'),
    f('散集.mp3')
  ], false);
  assert.deepEqual(keys(groups), ['__root__', '三体', '平凡的世界'].sort());
  const tt = groups.find(g => g.key === '三体');
  assert.equal(tt.files.length, 2);
  assert.equal(tt.cat, null, '平铺模式没有目录分类');
  assert.equal(tt.dirName, '', 'dirName 交给 build 按 key 兜底');
});

test('平铺模式：专辑 id 仍是目录名哈希（存量整理数据不受影响）', () => {
  const groups = L.groupFiles([f('三体/01.mp3')], false);
  assert.equal(U.uid('a', groups[0].key), U.uid('a', '三体'));
});

test('两级模式：一层目录当分类，二层目录当专辑', () => {
  const groups = L.groupFiles([
    f('历史/明朝那些事/01.mp3'), f('历史/明朝那些事/02.mp3'),
    f('文学/三体/01.mp3')
  ], true);
  assert.deepEqual(keys(groups), ['历史/明朝那些事', '文学/三体']);
  const g = groups.find(x => x.key === '历史/明朝那些事');
  assert.equal(g.cat, '历史');
  assert.equal(g.dirName, '明朝那些事');
  assert.equal(g.files.length, 2);
});

test('两级模式：三层及更深的音频并入最近的二级专辑', () => {
  const groups = L.groupFiles([
    f('历史/明朝那些事/01.mp3'),
    f('历史/明朝那些事/第一卷/02.mp3'),
    f('历史/明朝那些事/第一卷/分章/03.mp3')
  ], true);
  assert.deepEqual(keys(groups), ['历史/明朝那些事'], '子目录不单独成专辑');
  assert.equal(groups[0].files.length, 3);
});

test('两级模式：一层目录里直接放的音频合成该分类的散集专辑', () => {
  const groups = L.groupFiles([
    f('历史/明朝那些事/01.mp3'),
    f('历史/序章.mp3')
  ], true);
  assert.deepEqual(keys(groups), ['历史', '历史/明朝那些事']);
  const loose = groups.find(x => x.key === '历史');
  assert.equal(loose.cat, '历史');
  assert.equal(loose.dirName, '历史');
  assert.equal(loose.files.length, 1);
  /* 散集专辑的 id 与平铺时的同名专辑一致，开关来回切不会丢整理数据 */
  assert.equal(U.uid('a', loose.key), U.uid('a', '历史'));
});

test('两级模式：根目录散落文件仍归「未分类单集」', () => {
  const groups = L.groupFiles([f('散集.mp3'), f('历史/明朝那些事/01.mp3')], true);
  const root = groups.find(g => g.key === '__root__');
  assert.ok(root);
  assert.equal(root.cat, null);
  assert.equal(root.files.length, 1);
});

test('两级模式：不同分类下的同名专辑不会撞在一起', () => {
  const groups = L.groupFiles([
    f('历史/合集/01.mp3'),
    f('文学/合集/01.mp3')
  ], true);
  assert.deepEqual(keys(groups), ['历史/合集', '文学/合集']);
  const ids = groups.map(g => U.uid('a', g.key));
  assert.equal(new Set(ids).size, 2, '专辑 id 必须唯一');
});

test('空扫描结果 → 空分组', () => {
  assert.deepEqual(L.groupFiles([], true), []);
  assert.deepEqual(L.groupFiles([], false), []);
  assert.deepEqual(L.groupFiles(null, true), []);
  assert.deepEqual(L.groupFiles([], 'auto'), []);
});

/* ── auto 自动检测：不假设整库层数一致，每个一级目录自己判断 ── */

test('自动检测：2 层与 3 层混在同一个库里各按自己的结构走', () => {
  const groups = L.groupFiles([
    f('三体/01.mp3'), f('三体/02.mp3'),          // 一级目录里直接有音频 → 它是一张专辑
    f('历史/明朝那些事/01.mp3')                   // 一级目录只有子目录 → 它是分类
  ], 'auto');
  assert.deepEqual(keys(groups), ['三体', '历史/明朝那些事'].sort());
  const leaf = groups.find(g => g.key === '三体');
  assert.equal(leaf.cat, null, '叶目录不是分类');
  assert.equal(leaf.dirName, '三体');
  const sub = groups.find(g => g.key === '历史/明朝那些事');
  assert.equal(sub.cat, '历史');
  assert.equal(sub.dirName, '明朝那些事');
});

test('自动检测：专辑里按 CD1/CD2 分卷时仍是一张专辑', () => {
  const groups = L.groupFiles([
    f('三体/CD1/01.mp3'), f('三体/CD2/02.mp3')
  ], 'auto');
  assert.deepEqual(keys(groups), ['三体']);
  assert.equal(groups[0].cat, null);
  assert.equal(groups[0].files.length, 2);
});

test('自动检测：分类/专辑/CD1 这种三层半的结构并到二级专辑', () => {
  const groups = L.groupFiles([
    f('历史/明朝那些事/CD1/01.mp3'), f('历史/明朝那些事/CD2/02.mp3')
  ], 'auto');
  assert.deepEqual(keys(groups), ['历史/明朝那些事']);
  assert.equal(groups[0].cat, '历史');
});

test('自动检测：专辑根上散着音频、子目录再分卷时合成一张', () => {
  const groups = L.groupFiles([
    f('三体/01.mp3'), f('三体/CD2/02.mp3')
  ], 'auto');
  assert.deepEqual(keys(groups), ['三体']);
  assert.equal(groups[0].files.length, 2);
});

test('自动检测：专辑 id 与对应旧口径一致（切档不丢整理数据）', () => {
  const auto = L.groupFiles([f('三体/01.mp3'), f('历史/明朝那些事/01.mp3')], 'auto');
  const leaf = auto.find(g => g.key === '三体');
  /* 2 层目录在平铺模式下 key 也是「三体」 */
  const flat = L.groupFiles([f('三体/01.mp3')], 'flat');
  assert.equal(U.uid('a', leaf.key), U.uid('a', flat[0].key));
  /* 3 层目录在二级目录模式下 key 也是「历史/明朝那些事」 */
  const cat = L.groupFiles([f('历史/明朝那些事/01.mp3')], 'cat');
  const sub = auto.find(g => g.key === '历史/明朝那些事');
  assert.equal(U.uid('a', sub.key), U.uid('a', cat[0].key));
});

test('自动检测：分类下多一层分组（分类/分组/专辑）也能认出专辑', () => {
  const groups = L.groupFiles([
    f('管理/PMP/希赛PMP第七版/01.mp3'), f('管理/PMP/希赛PMP第七版/02.mp3'),
    f('管理/PMP/希赛ACP敏捷/01.mp3'),
    f('管理/领导力/01.mp3')                 // 同分类里另一本是「分类/专辑」
  ], 'auto');
  assert.deepEqual(keys(groups), [
    '管理/PMP/希赛PMP第七版', '管理/PMP/希赛ACP敏捷', '管理/领导力'
  ].sort());
  groups.forEach(function (g) {
    assert.equal(g.cat, '管理', '分类固定是一级目录');
  });
  assert.equal(groups.find(g => g.key === '管理/PMP/希赛PMP第七版').files.length, 2);
});

test('自动检测：音频放在 MP3 / 音频 这类容器目录里时不算专辑', () => {
  const groups = L.groupFiles([
    f('计算机/极客时间/Kubernetes入门实战课/MP3/01.mp3'),
    f('计算机/极客时间/Kubernetes入门实战课/音频/02.mp3')
  ], 'auto');
  assert.deepEqual(keys(groups), ['计算机/极客时间/Kubernetes入门实战课']);
  assert.equal(groups[0].cat, '计算机');
  assert.equal(groups[0].dirName, 'Kubernetes入门实战课');
});

test('自动检测：「08【战略篇】第8章：xxx」这类章节目录不单独成专辑', () => {
  const groups = L.groupFiles([
    f('极客时间/说服高手/08【战略篇】第8章：说服高手进阶技巧/01.mp3'),
    f('极客时间/说服高手/09【战略篇】第9章：收尾/01.mp3')
  ], 'auto');
  assert.deepEqual(keys(groups), ['极客时间/说服高手'], '两个章并回课程这一张专辑');
  assert.equal(groups[0].dirName, '说服高手');
  assert.equal(groups[0].cat, '极客时间');
  assert.equal(groups[0].files.length, 2);
});

test('自动检测：编号 + 括号的章节目录同样不单独成专辑', () => {
  const groups = L.groupFiles([
    f('计算机/极客时间/web安全/03【进阶篇】注入攻击/01.mp3'),
    f('计算机/极客时间/web安全/第10讲 收尾/01.mp3')
  ], 'auto');
  assert.deepEqual(keys(groups), ['计算机/极客时间/web安全']);
});

test('自动检测：编号+方括号标签+横线的系列专辑不被当成章节', () => {
  const groups = L.groupFiles([
    f('国学文化/11 曾仕强/07 [易经] -易经的奥秘/01.mp4'),
    f('国学文化/11 曾仕强/07 [易经] -易经的奥秘/02.mp4'),
    f('国学文化/11 曾仕强/13 [易经] -易经六十四问/01.mp4'),
    f('国学文化/11 曾仕强/曾仕强讲中华文化 - 第二季/01.mp4')
  ], 'auto');
  assert.deepEqual(keys(groups), [
    '国学文化/11 曾仕强/07 [易经] -易经的奥秘',
    '国学文化/11 曾仕强/13 [易经] -易经六十四问',
    '国学文化/11 曾仕强/曾仕强讲中华文化 - 第二季'
  ].sort());
  groups.forEach(function (g) { assert.equal(g.cat, '国学文化'); });
});

test('自动检测：数字开头的真专辑名不被当成章节', () => {
  const groups = L.groupFiles([
    f('小说/1984/01.mp3'),
    f('小说/24个比利/01.mp3'),
    f('小说/7号房的礼物/01.mp3')
  ], 'auto');
  assert.deepEqual(keys(groups), [
    '小说/1984', '小说/24个比利', '小说/7号房的礼物'
  ].sort());
});

test('自动检测：根目录散落文件仍归「未分类单集」', () => {
  const groups = L.groupFiles([f('散集.mp3'), f('三体/01.mp3')], 'auto');
  const root = groups.find(g => g.key === '__root__');
  assert.ok(root);
  assert.equal(root.cat, null);
});

test('目录分类 id 稳定且与手工分类区分开', () => {
  assert.equal(L.dirCatId('历史'), L.dirCatId('历史'));
  assert.notEqual(L.dirCatId('历史'), L.dirCatId('文学'));
  assert.ok(L.dirCatId('历史').charAt(0) === 'd', '目录分类用 d 前缀');
});
