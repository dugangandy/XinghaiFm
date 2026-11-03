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
});

test('目录分类 id 稳定且与手工分类区分开', () => {
  assert.equal(L.dirCatId('历史'), L.dirCatId('历史'));
  assert.notEqual(L.dirCatId('历史'), L.dirCatId('文学'));
  assert.ok(L.dirCatId('历史').charAt(0) === 'd', '目录分类用 d 前缀');
});
