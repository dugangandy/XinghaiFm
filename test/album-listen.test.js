/* 专辑 Top5 榜的数据层回归：schema v9 的 album_listen 表、批量累加写入、
   按库过滤与全库聚合排序、脏数据拦截、移除资源库时的清理。
   跑法：node --test test */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const DB = require('../db');

function fresh() {
  const db = DB.open(':memory:');
  DB.ensureSchema(db);
  return db;
}
function rowsOf(db, uid, libRoot, limit) {
  return DB.albumListenTop(db, uid, libRoot, limit);
}

test('schema：v9 建出 album_listen 表', () => {
  const db = fresh();
  assert.equal(DB.SCHEMA_VERSION, 9);
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='album_listen'").get();
  assert.ok(t, 'album_listen 表应存在');
  /* 主键是 (user_id, lib_root, album_id)：按库过滤正好命中前缀 */
  const cols = db.prepare('PRAGMA table_info(album_listen)').all().map(c => c.name);
  ['user_id', 'lib_root', 'album_id', 'title', 'secs', 'updated_at'].forEach(function (c) {
    assert.ok(cols.indexOf(c) >= 0, '缺列 ' + c);
  });
  /* 主键已经覆盖 user_id 前缀，额外的单列索引只会拖慢写入 */
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='album_listen'").all()
    .map(r => r.name).filter(n => n !== 'sqlite_autoindex_album_listen_1');
  assert.deepEqual(idx, [], '不应有多余索引：' + idx.join(','));
});

test('写入：同一专辑多次上报按秒数累加，标题取最新非空值', () => {
  const db = fresh();
  const a = 'a1x';
  DB.albumListenAdd(db, 'u1', [{ albumId: a, libRoot: '/lib/a', title: '三体', deltaSecs: 10 }]);
  DB.albumListenAdd(db, 'u1', [{ albumId: a, libRoot: '/lib/a', title: '三体', deltaSecs: 25 }]);
  let rows = rowsOf(db, 'u1', '/lib/a', 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].albumId, a);
  assert.equal(rows[0].secs, 35);

  /* 改名后以新标题为准 */
  DB.albumListenAdd(db, 'u1', [{ albumId: a, libRoot: '/lib/a', title: '三体（重制版）', deltaSecs: 5 }]);
  rows = rowsOf(db, 'u1', '/lib/a', 5);
  assert.equal(rows[0].title, '三体（重制版）');
  assert.equal(rows[0].secs, 40);

  /* 空标题不能把已有快照清掉：跨库榜单还得靠它显示名字 */
  DB.albumListenAdd(db, 'u1', [{ albumId: a, libRoot: '/lib/a', title: '', deltaSecs: 1 }]);
  rows = rowsOf(db, 'u1', '/lib/a', 5);
  assert.equal(rows[0].title, '三体（重制版）');
  assert.equal(rows[0].secs, 41);
});

test('写入：非法 albumId / 负增量 / 缺库路径整条丢弃', () => {
  const db = fresh();
  const n = DB.albumListenAdd(db, 'u1', [
    { albumId: 'bad id!', libRoot: '/lib/a', title: 'x', deltaSecs: 10 },
    { albumId: 'a1', libRoot: '', title: 'x', deltaSecs: 10 },
    { albumId: 'a1', libRoot: '/lib/a', title: 'x', deltaSecs: -5 },
    { albumId: 'a1', libRoot: '/lib/a', title: 'x', deltaSecs: 0 },
    { albumId: 'a1', libRoot: '/lib/a', title: 'x', deltaSecs: 99999 },
    { albumId: 'a1', libRoot: '/lib/a', title: '合法', deltaSecs: 30 }
  ]);
  assert.equal(n, 1, '只有最后一条合法');
  const rows = rowsOf(db, 'u1', '', 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].secs, 30);
});

test('查询：当前库只看自己，全库按 albumId 合并各库时长', () => {
  const db = fresh();
  const a = 'aa1', b = 'ab2', c = 'ac3';
  DB.albumListenAdd(db, 'u1', [
    { albumId: a, libRoot: '/lib/a', title: '甲', deltaSecs: 100 },
    { albumId: b, libRoot: '/lib/a', title: '乙', deltaSecs: 60 },
    { albumId: c, libRoot: '/lib/b', title: '丙', deltaSecs: 80 },
    /* 同一门课在另一个库里也有一份：全库视图应该合并成一条 */
    { albumId: a, libRoot: '/lib/b', title: '甲', deltaSecs: 20 }
  ]);

  const onlyA = rowsOf(db, 'u1', '/lib/a', 5);
  assert.deepEqual(onlyA.map(r => r.albumId), [a, b]);
  assert.equal(onlyA[0].secs, 100);

  const onlyB = rowsOf(db, 'u1', '/lib/b', 5);
  assert.deepEqual(onlyB.map(r => r.albumId), [c, a]);
  assert.equal(onlyB[0].secs, 80);

  const all = rowsOf(db, 'u1', '', 5);
  assert.deepEqual(all.map(r => r.albumId), [a, c, b], '全库按时长降序');
  assert.equal(all[0].secs, 120);
});

test('查询：最多返回 limit 条，limit 落在 1..20', () => {
  const db = fresh();
  const items = [];
  for (let i = 1; i <= 8; i++) {
    items.push({ albumId: 'a' + i.toString(36), libRoot: '/lib/a', title: '专辑' + i, deltaSecs: i * 10 });
  }
  DB.albumListenAdd(db, 'u1', items);
  assert.equal(rowsOf(db, 'u1', '', 5).length, 5);
  assert.equal(rowsOf(db, 'u1', '', 3).length, 3);
  assert.equal(rowsOf(db, 'u1', '', 0).length, 5, '非法 limit 回落 5');
  assert.equal(rowsOf(db, 'u1', '', 999).length, 8, '超过 20 也最多 20，但这里只有 8 条');
  /* 榜单按秒数降序：第一条是听得最久的 */
  assert.equal(rowsOf(db, 'u1', '', 5)[0].albumId, 'a8');
});

test('用户隔离：别人的收听量不进我的榜', () => {
  const db = fresh();
  DB.albumListenAdd(db, 'u1', [{ albumId: 'a1', libRoot: '/lib/a', title: '甲', deltaSecs: 30 }]);
  DB.albumListenAdd(db, 'u2', [{ albumId: 'a1', libRoot: '/lib/a', title: '甲', deltaSecs: 90 }]);
  assert.equal(rowsOf(db, 'u1', '', 5)[0].secs, 30);
  assert.equal(rowsOf(db, 'u2', '', 5)[0].secs, 90);
});

test('库路径归一：大小写 / 反斜杠差异合并到同一行', () => {
  const db = fresh();
  DB.albumListenAdd(db, 'u1', [{ albumId: 'a1', libRoot: '/Lib/A', title: '甲', deltaSecs: 10 }]);
  DB.albumListenAdd(db, 'u1', [{ albumId: 'a1', libRoot: '/lib/a/', title: '甲', deltaSecs: 15 }]);
  const rows = rowsOf(db, 'u1', '/lib/a', 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].secs, 25);
});

test('移除资源库：只清掉那个库的行，别的库保留', () => {
  const db = fresh();
  DB.albumListenAdd(db, 'u1', [
    { albumId: 'a1', libRoot: '/lib/a', title: '甲', deltaSecs: 10 },
    { albumId: 'a2', libRoot: '/lib/b', title: '乙', deltaSecs: 20 }
  ]);
  DB.clearLibMeta(db, '/lib/a');
  assert.equal(rowsOf(db, 'u1', '/lib/a', 5).length, 0);
  assert.equal(rowsOf(db, 'u1', '/lib/b', 5).length, 1);
  assert.equal(rowsOf(db, 'u1', '', 5).length, 1, '全库里只剩 B 库那一张');
});

test('空输入：没有 uid / 空数组时安全返回 0', () => {
  const db = fresh();
  assert.equal(DB.albumListenAdd(db, '', [{ albumId: 'a1', libRoot: '/lib/a', deltaSecs: 10 }]), 0);
  assert.equal(DB.albumListenAdd(db, 'u1', []), 0);
  assert.equal(DB.albumListenAdd(db, 'u1', null), 0);
  assert.deepEqual(rowsOf(db, '', '', 5), []);
});
