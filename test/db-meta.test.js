/* 库元数据（分类 / 专辑整理 / 进度 / 时长）入库的回归测试：迁移、合并规则、事务原子性。
   跑法：node --test test */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB = require('../db');

function fresh() {
  const db = DB.open(':memory:');
  DB.ensureSchema(db);
  return db;
}
const ROOT = path.resolve(os.tmpdir(), 'fm-meta-lib');

test('schema 升到 v7，库元数据表与用户数据表都建好', () => {
  const db = fresh();
  assert.ok(DB.SCHEMA_VERSION >= 7, 'schema 版本应至少为 7');
  ['cats', 'album_meta', 'progress', 'durations', 'user_progress', 'user_queue', 'user_prefs'].forEach(function (t) {
    const r = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    assert.ok(r, t + ' 表应存在');
  });
});

test('libRootKey：统一分隔符、去掉尾斜杠，Windows 下不区分大小写', () => {
  const a = DB.libRootKey(ROOT);
  assert.ok(a.indexOf('\\') < 0, '不能有反斜杠');
  assert.equal(a, DB.libRootKey(ROOT + path.sep));
  assert.equal(a, DB.libRootKey(ROOT + '////'));
  if (process.platform === 'win32') {
    assert.equal(a, DB.libRootKey(ROOT.toUpperCase()));
  }
  assert.equal(DB.libRootKey(''), '');
});

test('catsReplace：整份替换、保持 order、空数组清空', () => {
  const db = fresh();
  const list = [
    { id: 'c_b', name: '乙', color: '#fff', order: 1 },
    { id: 'c_a', name: '甲', color: '#000', order: 0 }
  ];
  assert.equal(DB.catsReplace(db, ROOT, list), 2);
  const got = DB.catsList(db, ROOT);
  assert.deepEqual(got.map(function (c) { return c.id; }), ['c_a', 'c_b']);
  assert.deepEqual(got.map(function (c) { return c.order; }), [0, 1]);
  /* 再来一次同样内容不重复 */
  DB.catsReplace(db, ROOT, list);
  assert.equal(DB.catsList(db, ROOT).length, 2);
  /* 另一个库互不影响 */
  assert.equal(DB.catsList(db, ROOT + '-other').length, 0);
  /* 空数组 = 用户把分类删光了，不能变成「未初始化」 */
  DB.catsReplace(db, ROOT, []);
  assert.deepEqual(DB.catsList(db, ROOT), []);
});

test('catsWrite：按 id 合并，多端并发加分类不互相覆盖', () => {
  const db = fresh();
  /* 手机先推 [c1]，桌面随后推 [c2]（不含 c1）：两端都应保留，不能整份覆盖 */
  DB.metaApply(db, ROOT, { cats: [{ id: 'c1', name: '手机加的', order: 0 }] });
  DB.metaApply(db, ROOT, { cats: [{ id: 'c2', name: '桌面加的', order: 1 }] });
  let got = DB.catsList(db, ROOT);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map(function (c) { return c.id; }).sort(), ['c1', 'c2']);

  /* 同 id 更新要覆盖（改名/调序），不是再插一行 */
  DB.metaApply(db, ROOT, { cats: [{ id: 'c1', name: '手机改名', order: 2 }, { id: 'c2', name: '桌面加的', order: 1 }] });
  got = DB.catsList(db, ROOT);
  assert.equal(got.length, 2, '同 id 更新不应产生重复行');
  assert.equal(got.find(function (c) { return c.id === 'c1'; }).name, '手机改名');

  /* 与 albumMeta/progress 一样，只推 cats 不会动其它表 */
  assert.equal(Object.keys(DB.albumMetaMap(db, ROOT)).length, 0);
});

test('catsDeleted：按 id 精确删除，跨库不误伤（删分类后重进不复活）', () => {
  const db = fresh();
  /* 两个库都有同名种子 id（真实场景：种子分类跨库同 id） */
  DB.catsReplace(db, ROOT, [{ id: 'c1', name: '甲', order: 0 }, { id: 'c2', name: '乙', order: 1 }]);
  DB.catsReplace(db, ROOT + '-other', [{ id: 'c1', name: '甲', order: 0 }]);
  /* 客户端删分类：推剩余列表 + 被删 id（rest 走 upsert 不会删行，靠 catsDeleted 真正删） */
  DB.metaApply(db, ROOT, { cats: [{ id: 'c2', name: '乙', order: 0 }], catsDeleted: ['c1'] });
  assert.deepEqual(DB.catsList(db, ROOT).map(function (c) { return c.id; }), ['c2']);
  /* 另一个库的同名 id 不能被误删 */
  assert.deepEqual(DB.catsList(db, ROOT + '-other').map(function (c) { return c.id; }), ['c1']);
  /* 删不存在的 id 不报错 */
  DB.metaApply(db, ROOT, { catsDeleted: ['nope'] });
});

test('lastTrack 按用户存：新用户是空的，不同用户互不串', () => {
  const db = fresh();
  DB.setUserLastTrack(db, 'u1', 'lib-a', 't1');
  assert.equal(DB.userLastTrack(db, 'u1', 'lib-a'), 't1');
  /* 同库的另一个用户（共享资源库）：自己没有记录，返回空 —— 前端就不会显示底栏 */
  assert.equal(DB.userLastTrack(db, 'u2', 'lib-a'), '');
  /* 同一个用户换库也不串 */
  assert.equal(DB.userLastTrack(db, 'u1', 'lib-b'), '');
  /* 覆盖写 */
  DB.setUserLastTrack(db, 'u1', 'lib-a', 't2');
  assert.equal(DB.userLastTrack(db, 'u1', 'lib-a'), 't2');
  /* 参数不全时不落库 */
  assert.equal(DB.setUserLastTrack(db, '', 'lib-a', 't3'), 0);
  assert.equal(DB.userLastTrack(db, 'u1', ''), '');
});

test('catsManual：手动排序标记按资源库存储并随元数据快照同步', () => {
  const db = fresh();
  assert.equal(DB.metaSnapshot(db, ROOT).catsManual, false);
  DB.metaApply(db, ROOT, { catsManual: true });
  assert.equal(DB.metaSnapshot(db, ROOT).catsManual, true);
  DB.metaApply(db, ROOT + '-other', { catsManual: true });
  DB.metaApply(db, ROOT, { catsManual: false });
  assert.equal(DB.metaSnapshot(db, ROOT).catsManual, false);
  assert.equal(DB.metaSnapshot(db, ROOT + '-other').catsManual, true);
});

test('dirCatDropped：删掉的目录分类名单落库，跨端不会再自动长回来', () => {
  const db = fresh();
  DB.metaApply(db, ROOT, { dirCatDropped: ['技术', '历史'] });
  assert.deepEqual(DB.droppedDirCats(db, ROOT), ['技术', '历史']);
  /* 快照要带出去：另一台设备 pullMeta 才拿得到 */
  assert.deepEqual(DB.metaSnapshot(db, ROOT).dirCatDropped, ['技术', '历史']);
  /* 整份替换（客户端推的永远是本地完整名单） */
  DB.metaApply(db, ROOT, { dirCatDropped: ['技术'] });
  assert.deepEqual(DB.droppedDirCats(db, ROOT), ['技术']);
  /* 跨库隔离：别的库的同名目录不受影响 */
  assert.deepEqual(DB.droppedDirCats(db, ROOT + '-other'), []);
  /* 只推这一项不会动分类 */
  assert.deepEqual(DB.catsList(db, ROOT), []);
});

test('albumMetaUpsert：键带库前缀、null 删除、往返一致', () => {
  const db = fresh();
  const k = ROOT + '|三体';
  DB.albumMetaUpsert(db, ROOT, { [k]: { cats: ['c_a'], title: '三体（重制）', pinned: true, hidden: 1 } });
  const map = DB.albumMetaMap(db, ROOT);
  assert.deepEqual(Object.keys(map), [k]);
  assert.deepEqual(map[k].cats, ['c_a']);
  assert.equal(map[k].title, '三体（重制）');
  assert.equal(map[k].pinned, 1);
  assert.equal(map[k].hidden, 1);
  /* 另一路径前缀的键也要能落到同一个库（客户端路径写法偶有差异） */
  DB.albumMetaUpsert(db, ROOT, { '别的库|球状闪电': { cats: [] } });
  assert.ok(DB.albumMetaMap(db, ROOT)[ROOT + '|球状闪电']);
  /* null = 删掉这一行，取消归类/取消重命名都走这条 */
  DB.albumMetaUpsert(db, ROOT, { [k]: null });
  assert.deepEqual(Object.keys(DB.albumMetaMap(db, ROOT)), [ROOT + '|球状闪电']);
});

test('progressUpsert / durationUpsert：进度按 t 合并，晚到的旧值不覆盖', () => {
  const db = fresh();
  DB.progressUpsert(db, ROOT, { t1: { p: 30, d: 100, t: 2000, done: false } });
  DB.progressUpsert(db, ROOT, { t1: { p: 10, d: 100, t: 1000, done: false } });   /* 旧上报 */
  assert.equal(DB.progressMap(db, ROOT).t1.p, 30);
  DB.progressUpsert(db, ROOT, { t1: { p: 100, d: 100, t: 3000, done: true } });
  const p = DB.progressMap(db, ROOT).t1;
  assert.deepEqual({ p: p.p, done: p.done }, { p: 100, done: true });
  /* 时长为 0 的脏值不写 */
  DB.durationUpsert(db, ROOT, { t1: 61.5, t2: 0 });
  assert.deepEqual(DB.durationMap(db, ROOT), { t1: 61.5 });
});

test('metaApply：一个事务，中途抛错全部回滚', () => {
  const db = fresh();
  const ok = DB.metaApply(db, ROOT, {
    cats: [{ id: 'c1', name: '分类一' }],
    albumMeta: { [ROOT + '|三体']: { cats: ['c1'] } },
    progress: { t1: { p: 5, d: 100, t: 1 } },
    durations: { t1: 100 }
  });
  assert.deepEqual(ok, { cats: 1, albumMeta: 1, progress: 1, durations: 1 });

  const db2 = fresh();
  const bomby = {};
  Object.defineProperty(bomby, 'k', { enumerable: true, get: function () { throw new Error('boom'); } });
  assert.throws(function () {
    DB.metaApply(db2, ROOT, { cats: [{ id: 'c1', name: '分类一' }], albumMeta: bomby });
  }, /boom/);
  assert.deepEqual(DB.catsList(db2, ROOT), [], '分类写入应随事务回滚');
});

test('migrateLegacyMeta：按库前缀导入、幂等、库里已有数据不覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-meta-'));
  const root = path.resolve(dir, 'lib');
  fs.mkdirSync(root, { recursive: true });
  const snapshot = {
    v: 2,
    root: root,
    cats: [{ id: 'c1', name: '有声书', color: '#f00', order: 0 }],
    albumMeta: {
      [root + '|三体']: { cats: ['c1'], pinned: true },
      ['别的库|三体']: { cats: ['c1'] }
    },
    progress: { t1: { p: 42, d: 100, t: 10, done: false } },
    durations: { t1: 100 }
  };
  fs.writeFileSync(path.join(root, '.fm-meta.json'), JSON.stringify(snapshot));

  try {
    const db = fresh();
    const counts = DB.migrateLegacyMeta(db, root, root);
    assert.deepEqual(counts, { cats: 1, albumMeta: 1, progress: 1, durations: 1 });
    assert.equal(DB.catsList(db, root)[0].name, '有声书');
    const map = DB.albumMetaMap(db, root);
    assert.deepEqual(Object.keys(map), [root + '|三体'], '别的库的条目不该导进来');
    assert.equal(DB.userProgressMap(db, DB.ADMIN_ID, root).t1.p, 42);

    /* 再跑一次：已打过迁移标记，什么都不做 */
    assert.deepEqual(DB.migrateLegacyMeta(db, root, root), 0);

    /* 空库 + 没有标记，但库里已有数据（别的端写过）→ 不覆盖旧文件 */
    const db2 = fresh();
    DB.catsReplace(db2, root, [{ id: 'c9', name: '手工建的' }]);
    DB.migrateLegacyMeta(db2, root, root);
    assert.deepEqual(DB.catsList(db2, root).map(function (c) { return c.id; }), ['c9']);
    assert.equal(DB.metaMigrated(db2, root), true, '有数据也应打标记，别每次启动都读文件');

    /* 文件还没有时不打标记，下次再试 */
    const db3 = fresh();
    const empty = path.resolve(dir, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    assert.equal(DB.migrateLegacyMeta(db3, empty, empty), 0);
    assert.equal(DB.metaMigrated(db3, empty), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clearLibMeta：库移除后不留孤儿行与迁移标记', () => {
  const db = fresh();
  DB.metaApply(db, ROOT, {
    cats: [{ id: 'c1', name: 'x' }],
    albumMeta: { [ROOT + '|三体']: { cats: ['c1'] } },
    progress: { t1: { p: 1, d: 2, t: 3 } },
    durations: { t1: 10 }
  });
  DB.markMetaMigrated(db, ROOT);
  assert.ok(DB.clearLibMeta(db, ROOT) >= 4);
  assert.deepEqual(DB.catsList(db, ROOT), []);
  assert.deepEqual(DB.albumMetaMap(db, ROOT), {});
  assert.deepEqual(DB.userProgressMap(db, DB.ADMIN_ID, ROOT), {});
  assert.deepEqual(DB.durationMap(db, ROOT), {});
  assert.equal(DB.metaMigrated(db, ROOT), false);
});

test('metaSnapshot：整份读回带版本号，空库路径返回空结构', () => {
  const db = fresh();
  const patch = {
    cats: [{ id: 'c1', name: '有声书', color: '#f00', order: 0 }],
    albumMeta: { [ROOT + '|三体']: { cats: ['c1'], title: '三体（重制）', pinned: 1 } },
    progress: { t1: { p: 42, d: 100, t: 7, done: false } },
    durations: { t1: 100 }
  };
  DB.metaApply(db, ROOT, patch);
  const snap = DB.metaSnapshot(db, ROOT);
  assert.equal(snap.v, DB.META_VERSION);
  assert.equal(snap.root, ROOT);
  assert.deepEqual(snap.cats, [{ id: 'c1', name: '有声书', color: '#f00', order: 0 }]);
  assert.deepEqual(snap.albumMeta, patch.albumMeta);
  assert.deepEqual(snap.progress, { t1: { p: 42, d: 100, done: false, t: 7 } });
  assert.deepEqual(snap.durations, { t1: 100 });

  /* 没有库路径时给一份合法的空快照，别返回 undefined 让前端炸 */
  assert.deepEqual(DB.metaSnapshot(db, ''), {
    v: DB.META_VERSION, root: '', cats: [], albumMeta: {}, progress: {}, durations: {},
    dirCatDropped: [], catsManual: false, queue: { tracks: [], position: 0 }, prefs: {}
  });
});

test('metaApply：只传一部分时不动其它表', () => {
  const db = fresh();
  DB.metaApply(db, ROOT, {
    cats: [{ id: 'c1', name: 'x' }],
    progress: { t1: { p: 1, d: 2, t: 3 } }
  });
  DB.metaApply(db, ROOT, { albumMeta: { [ROOT + '|三体']: { pinned: 1 } } });
  assert.equal(DB.catsList(db, ROOT).length, 1, '只推整理字段不该清掉分类');
  assert.equal(DB.userProgressMap(db, DB.ADMIN_ID, ROOT).t1.p, 1);
  assert.equal(DB.albumMetaMap(db, ROOT)[ROOT + '|三体'].pinned, 1);

  /* 非数组的 cats（脏客户端）直接忽略，不能把已有分类清空 */
  DB.metaApply(db, ROOT, { cats: '不是数组' });
  assert.equal(DB.catsList(db, ROOT).length, 1);
});

test('META_LIMIT：分类 / 整理 / 进度 / 时长都按上限截断', () => {
  const db = fresh();
  const many = n => {
    const o = {};
    for (let i = 0; i < n; i++) o['t' + i] = { p: i, d: 100, t: i };
    return o;
  };
  const durs = n => {
    const o = {};
    for (let i = 0; i < n; i++) o['t' + i] = 10 + i;
    return o;
  };
  const cats = [];
  for (let i = 0; i < DB.META_LIMIT.cats + 50; i++) cats.push({ id: 'c' + i, name: 'n' + i });

  const am = {};
  for (let i = 0; i < DB.META_LIMIT.albumMeta + 20; i++) am[ROOT + '|专辑' + i] = { cats: ['c1'] };

  const counts = DB.metaApply(db, ROOT, {
    cats: cats,
    albumMeta: am,
    progress: many(DB.META_LIMIT.progress + 20),
    durations: durs(DB.META_LIMIT.durations + 20)
  });
  assert.deepEqual(counts, {
    cats: DB.META_LIMIT.cats,
    albumMeta: DB.META_LIMIT.albumMeta,
    progress: DB.META_LIMIT.progress,
    durations: DB.META_LIMIT.durations
  });
  assert.equal(DB.catsList(db, ROOT).length, DB.META_LIMIT.cats);
  assert.equal(Object.keys(DB.albumMetaMap(db, ROOT)).length, DB.META_LIMIT.albumMeta);
  assert.equal(Object.keys(DB.userProgressMap(db, DB.ADMIN_ID, ROOT)).length, DB.META_LIMIT.progress);
  assert.equal(Object.keys(DB.durationMap(db, ROOT)).length, DB.META_LIMIT.durations);

  /* 单个专辑最多留 20 个分类，防止前端塞进超长数组 */
  const longCats = [];
  for (let i = 0; i < 30; i++) longCats.push('c' + i);
  DB.albumMetaUpsert(db, ROOT, { '单专辑': { cats: longCats } });
  assert.equal(DB.albumMetaMap(db, ROOT)[ROOT + '|单专辑'].cats.length, 20);
});

test('albumMeta：键没有库前缀时整串当专辑目录', () => {
  const db = fresh();
  DB.albumMetaUpsert(db, ROOT, { '裸专辑名': { cats: ['c1'], hidden: 1 } });
  const map = DB.albumMetaMap(db, ROOT);
  assert.deepEqual(Object.keys(map), [ROOT + '|裸专辑名']);
  assert.equal(map[ROOT + '|裸专辑名'].hidden, 1);
  /* 空键直接跳过，不能写出一个空专辑行 */
  assert.equal(DB.albumMetaUpsert(db, ROOT, { '': { cats: [] } }), 0);
  assert.equal(Object.keys(DB.albumMetaMap(db, ROOT)).length, 1);
});

test('写入计数：进度按处理条数计（被时间戳挡住的也算），时长跳过脏值不计', () => {
  const db = fresh();
  DB.progressUpsert(db, ROOT, { t1: { p: 50, d: 100, t: 500 } });
  /* t 更小的旧上报会被 SQL 的 WHERE 挡掉，但返回值仍按「提交了几条」算，
     调用方只能拿它当日志，不能当「实际写入成功数」用 */
  assert.equal(DB.progressUpsert(db, ROOT, { t1: { p: 1, d: 100, t: 100 } }), 1);
  assert.equal(DB.progressMap(db, ROOT).t1.p, 50);

  /* 时长为 0 / 负数 / 非数字：跳过且不计数 */
  assert.equal(DB.durationUpsert(db, ROOT, { a: 0, b: -3, c: 'x', d: 12.5 }), 1);
  assert.deepEqual(DB.durationMap(db, ROOT), { d: 12.5 });
});

test('空输入：libRootKey 为空时所有写接口都返回 0 且不落行', () => {
  const db = fresh();
  assert.equal(DB.catsReplace(db, '', [{ id: 'c1' }]), 0);
  assert.equal(DB.albumMetaUpsert(db, '', { 'k': { cats: [] } }), 0);
  assert.equal(DB.progressUpsert(db, '', { t1: { p: 1, t: 1 } }), 0);
  assert.equal(DB.durationUpsert(db, '', { t1: 1 }), 0);
  assert.deepEqual(DB.metaApply(db, '', { cats: [{ id: 'c1' }] }), { cats: 0, albumMeta: 0, progress: 0, durations: 0 });
  assert.deepEqual(DB.metaApply(db, ROOT, null), { cats: 0, albumMeta: 0, progress: 0, durations: 0 });
  assert.equal(DB.clearLibMeta(db, ''), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cats').get().n, 0);
});

/* ── v7：收听数据按用户（进度 / 队列 / 偏好） ── */

test('userProgress：不同用户互不干扰，按 t 合并不会被旧上报拨回去', () => {
  const db = fresh();
  DB.metaApply(db, ROOT, { progress: { t1: { p: 42, d: 100, t: 500 } } }, 'u_a');
  DB.metaApply(db, ROOT, { progress: { t1: { p: 10, d: 100, t: 600 } } }, 'u_b');
  assert.equal(DB.userProgressMap(db, 'u_a', ROOT).t1.p, 42);
  assert.equal(DB.userProgressMap(db, 'u_b', ROOT).t1.p, 10);
  /* 同一个用户的旧上报（t 更小）不能把进度往回拨 */
  DB.metaApply(db, ROOT, { progress: { t1: { p: 1, d: 100, t: 100 } } }, 'u_a');
  assert.equal(DB.userProgressMap(db, 'u_a', ROOT).t1.p, 42);
});

test('userQueue / userPrefs：往返、整份覆盖、偏好按字段合并', () => {
  const db = fresh();
  DB.userQueueSet(db, 'u_a', ROOT, ['t1', 't2', 't3'], 1);
  assert.deepEqual(DB.userQueueGet(db, 'u_a', ROOT), { tracks: ['t1', 't2', 't3'], position: 1 });
  /* 队列是单队列整份覆盖，且位置越界会被夹住 */
  DB.userQueueSet(db, 'u_a', ROOT, ['t9'], 7);
  assert.deepEqual(DB.userQueueGet(db, 'u_a', ROOT), { tracks: ['t9'], position: 0 });
  /* 别的用户 / 别的库各自独立 */
  assert.deepEqual(DB.userQueueGet(db, 'u_b', ROOT), { tracks: [], position: 0 });
  assert.deepEqual(DB.userQueueGet(db, 'u_a', ROOT + '-other'), { tracks: [], position: 0 });

  DB.userPrefsWrite(db, 'u_a', { rate: 1.5, loop: 'one' });
  DB.userPrefsWrite(db, 'u_a', { loop: 'all' });
  assert.deepEqual(DB.userPrefsGet(db, 'u_a'), { rate: 1.5, loop: 'all' });
  assert.deepEqual(DB.userPrefsGet(db, 'u_b'), {});
});

test('metaSnapshot / metaApply：进度按 uid，队列与偏好随快照往返', () => {
  const db = fresh();
  DB.metaApply(db, ROOT, {
    progress: { t1: { p: 7, d: 9, t: 3 } },
    queue: { tracks: ['t1'], position: 0 },
    prefs: { sortDesc: true }
  }, 'u_a');
  const a = DB.metaSnapshot(db, ROOT, 'u_a');
  assert.deepEqual(a.progress, { t1: { p: 7, d: 9, done: false, t: 3 } });
  assert.deepEqual(a.queue, { tracks: ['t1'], position: 0 });
  assert.deepEqual(a.prefs, { sortDesc: true });
  /* 另一个用户看同一个库：分类是共享的，收听数据是自己的（空） */
  const b = DB.metaSnapshot(db, ROOT, 'u_b');
  assert.deepEqual(b.progress, {});
  assert.deepEqual(b.queue, { tracks: [], position: 0 });
  assert.deepEqual(b.prefs, {});
  assert.deepEqual(b.cats, a.cats);
});

test('v7 迁移：历史共享进度整份归管理员，普通用户从空开始', () => {
  const db = fresh();
  DB.addUser(db, { id: 'u_admin', username: 'admin', role: 'admin', password: 'Abcdefg1' });
  const u2 = DB.addUser(db, { username: 'other', password: 'Abcdefg1' }).id;
  /* 造出 v6 状态：旧 progress 表里有数据，user_progress 里没有 */
  db.prepare('INSERT INTO progress(lib_root, track_id, p, d, done, t) VALUES(?,?,?,?,?,?)')
    .run(DB.libRootKey(ROOT), 't1', 42, 100, 0, 7);
  db.exec('PRAGMA user_version = 6');
  DB.ensureSchema(db);
  assert.equal(DB.userProgressMap(db, 'u_admin', ROOT).t1.p, 42, '历史进度应归管理员');
  assert.deepEqual(DB.userProgressMap(db, u2, ROOT), {}, '普通用户不该分到历史进度');
});

test('删用户时清掉他的进度 / 队列 / 偏好', () => {
  const db = fresh();
  const u = DB.addUser(db, { id: 'u_x', username: 'xx', password: 'Abcdefg1' }).id;
  DB.metaApply(db, ROOT, {
    progress: { t1: { p: 1, d: 2, t: 3 } },
    queue: { tracks: ['t1'], position: 0 },
    prefs: { rate: 2 }
  }, u);
  assert.equal(DB.userProgressMap(db, u, ROOT).t1.p, 1);
  DB.removeUser(db, u);
  assert.deepEqual(DB.userProgressMap(db, u, ROOT), {});
  assert.deepEqual(DB.userQueueGet(db, u, ROOT), { tracks: [], position: 0 });
  assert.deepEqual(DB.userPrefsGet(db, u), {});
});
