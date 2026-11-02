/* js/util.js 里不碰 DOM 的纯函数：格式化、自然排序、hash、缩写、节流防抖。
   util.js 是浏览器脚本（挂在 window.FM 上），这里给个最小 window 壳直接 require。
   跑法：node --test test */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
require('../js/util.js');
const U = global.window.FM.util;

test('fmtTime：分秒补零、超过一小时带小时位、脏值按 0 处理', () => {
  assert.equal(U.fmtTime(0), '0:00');
  assert.equal(U.fmtTime(65), '1:05');
  assert.equal(U.fmtTime(59.9), '0:59', '小数向下取整');
  assert.equal(U.fmtTime(3600), '1:00:00');
  assert.equal(U.fmtTime(3661), '1:01:01');
  [-5, NaN, Infinity, undefined].forEach(function (v) {
    assert.equal(U.fmtTime(v), '0:00', String(v) + ' 应兜底成 0');
  });
});

test('fmtDur：按小时/分钟粗粒度展示，0 与空值都给 0 分钟', () => {
  assert.equal(U.fmtDur(0), '0 分钟');
  assert.equal(U.fmtDur(null), '0 分钟');
  assert.equal(U.fmtDur(60), '1 分钟');
  assert.equal(U.fmtDur(3600), '1 小时');
  assert.equal(U.fmtDur(5400), '1 小时 30 分');
  assert.equal(U.fmtDur(3599), '60 分钟', '不足 1 小时的四舍五入到分钟');
});

test('fmtSize：GB 保留两位、MB 至少 1、空值为破折号', () => {
  assert.equal(U.fmtSize(0), '—');
  assert.equal(U.fmtSize(1024), '1 MB', '不足 1MB 也不显示 0 MB');
  assert.equal(U.fmtSize(5 * 1048576), '5 MB');
  assert.equal(U.fmtSize(1073741824), '1.00 GB');
  assert.equal(U.fmtSize(20 * 1073741824), '20.0 GB', '两位数 GB 只留一位小数');
});

test('fmtAgo：刚刚 / 分钟 / 小时 / 天 / 日期逐级降级', () => {
  const now = Date.now();
  assert.equal(U.fmtAgo(0), '');
  assert.equal(U.fmtAgo(now), '刚刚');
  assert.equal(U.fmtAgo(now - 5 * 60000), '5 分钟前');
  assert.equal(U.fmtAgo(now - 3 * 3600000), '3 小时前');
  assert.equal(U.fmtAgo(now - 2 * 86400000), '2 天前');
  /* 超过 30 天回落到「X 月 X 日」 */
  assert.match(U.fmtAgo(now - 40 * 86400000), /^\d{1,2} 月 \d{1,2} 日$/);
});

test('naturalCompare：数字段按数值比，文件名排序不受位数影响', () => {
  ['第2集', 'a2', '02.mp3', '片头 2'].forEach(function (p) {
    const re = /\d+/;
    const a = p.replace(re, '2'), b = p.replace(re, '10');
    assert.ok(U.naturalCompare(a, b) < 0, a + ' 应排在 ' + b + ' 前');
    assert.ok(U.naturalCompare(b, a) > 0, '反向比较应得正数');
  });
  assert.equal(U.naturalCompare('同一集', '同一集'), 0);
  /* 真实用途：给文件列表排序 */
  assert.deepEqual(
    ['第10集.mp3', '第2集.mp3', '第1集.mp3'].sort(U.naturalCompare),
    ['第1集.mp3', '第2集.mp3', '第10集.mp3']);
});

test('hash / uid：同输入同结果、无符号 32 位、前缀透传', () => {
  assert.equal(U.hash('三体'), U.hash('三体'));
  assert.notEqual(U.hash('三体'), U.hash('球状闪电'));
  const h = U.hash('任意字符串');
  assert.ok(h >= 0 && h <= 0xffffffff, 'hash 必须是无符号 32 位');
  assert.equal(U.uid('t_', 'a/1.mp3'), 't_' + U.hash('a/1.mp3').toString(36));
});

test('initials：书名号/方括号前缀剥离，中文取两字，拉丁取字母', () => {
  assert.equal(U.initials(''), '声');
  assert.equal(U.initials(null), '声');
  assert.equal(U.initials('《三体》'), '三体');
  assert.equal(U.initials('【极客时间】Vue 开发实战'), 'Vu');
  assert.equal(U.initials('【极客时间】Vue 开发实战', true), 'Vue', 'latinWord 时拉丁前缀最多取 5 个字母');
  assert.equal(U.initials('被讨厌的勇气'), '讨厌', '「被」字开头的长标题去掉首字');
  assert.equal(U.initials('12讲 三体'), '三体');
});

test('escape / stripExt / clamp / coverVars', () => {
  assert.equal(U.escape('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(U.stripExt('第01集.mp3'), '第01集');
  assert.equal(U.stripExt('无扩展名'), '无扩展名');
  assert.equal(U.clamp(5, 0, 3), 3);
  assert.equal(U.clamp(-1, 0, 3), 0);
  assert.equal(U.clamp(2, 0, 3), 2);
  /* 同一个 seed 稳定出同一组颜色，且都在调色板里 */
  assert.deepEqual(U.coverColors(7), U.coverColors(7));
  assert.ok(U.coverVars(7).indexOf('--c1:') === 0);
});

test('debounce：连续调用只执行最后一次', async () => {
  let calls = [];
  const fn = U.debounce(function (v) { calls.push(v); }, 10);
  fn(1); fn(2); fn(3);
  assert.deepEqual(calls, [], '等待期内不该触发');
  await U.sleep(40);
  assert.deepEqual(calls, [3]);
});

test('throttle：首次立即执行，窗口内只补发第一次被挡住的调用', async () => {
  let calls = [];
  const fn = U.throttle(function (v) { calls.push(v); }, 30);
  fn(1);
  assert.deepEqual(calls, [1], '首次立即执行');
  fn(2); fn(3);
  assert.deepEqual(calls, [1], '窗口内不执行');
  /* 实现是「窗口末尾补发第一次被挡住的调用」，不是最后一次 */
  await U.sleep(60);
  assert.deepEqual(calls, [1, 2]);
});

test('emitter：on 可退订，单个回调抛错不影响其它回调', () => {
  const em = U.emitter();
  const got = [];
  const off = em.on('x', function (v) { got.push('a' + v); });
  em.on('x', function () { throw new Error('boom'); });
  em.on('x', function (v) { got.push('b' + v); });
  const origErr = console.error;
  console.error = function () {};
  try {
    em.emit('x', 1);
    assert.deepEqual(got, ['a1', 'b1']);
    off();
    em.emit('x', 2);
    assert.deepEqual(got, ['a1', 'b1', 'b2']);
    em.emit('没注册过的', 3);   /* 不该抛 */
  } finally {
    console.error = origErr;
  }
});
