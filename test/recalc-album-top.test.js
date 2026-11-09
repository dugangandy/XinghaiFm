/* 专辑 Top5 回填脚本的回归：映射同构、补差语义、幂等、用户隔离、脏数据跳过。
   跑法：node --test test */
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const DB = require('../db');
const MAP = require('../tools/album-map');
const R = require('../tools/recalc-album-top');

const ROOT = '/lib/a';
const AID = 'a1vojm1h';             /* uid('a','三体')，防映射算法被改动 */
const T1 = 't1rfu2wp';              /* uid('t','三体/01.mp3') */

function fresh() {
  const db = DB.open(':memory:');
  DB.ensureSchema(db);
  DB.addUser(db, { id: 'u_admin', username: 'admin', role: 'admin', salt: 'c2FsdA==', hash: 'aGFzaA==' });
  return db;
}

function addLib(db, id, root, name) {
  db.prepare('INSERT INTO libs(id, user_id, name, path, added_at, active, position) VALUES(?,?,?,?,?,?,?)')
    .run(id, 'u_admin', name || id, root, Date.now(), 1, 0);
}

function putScan(db, root, files) {
  DB.setSetting(db, 'scan:' + DB.libRootKey(root), JSON.stringify({
    root: root, rootName: 'libRoot', scannedAt: 1, files: files
  }));
}

function markDone(db, root, trackId, d, uid) {
  db.prepare('INSERT INTO user_progress(user_id, lib_root, track_id, p, d, done, t) VALUES(?,?,?,?,?,?,?)')
    .run(uid || 'u_admin', DB.libRootKey(root), trackId, d, d, 1, 1);
}

function setup(opts) {
  const o = opts || {};
  const db = fresh();
  addLib(db, 'l1', ROOT, '测试库');
  putScan(db, ROOT, o.files || [{ rel: '三体/01.mp3' }, { rel: '三体/02.mp3' }]);
  if (o.mode) DB.setLibDirMode(db, ROOT, o.mode);
  return db;
}

test('映射：与前端 uid 同构，flat / cat / auto 三档分组不同', () => {
  /* 锚点：uid 是 FNV-1a + base36，和 js/util.js:102-111 一致；改这里说明两边不同步了 */
  assert.equal(MAP.uid('a', '三体'), 'a1vojm1h');
  assert.equal(MAP.uid('t', '三体/01.mp3'), 't1rfu2wp');
  assert.equal(MAP.uid('a', 'a'), 'a1r9wi7g');

  const files = [{ rel: '三体/01.mp3' }, { rel: '根目录散集.mp3' }];
  const flat = MAP.buildTrackAlbumMap({ files: files, rootName: 'a' }, 'flat', 'a');
  assert.equal(flat.get(T1).albumId, 'a1vojm1h');
  /* 根目录散集在 flat 下用 rootName 兜底，与 library.js 的 albumIdOf 一致 */
  assert.equal(flat.get(MAP.uid('t', '根目录散集.mp3')).albumId, 'a1r9wi7g');

  const catFiles = [{ rel: '分类/专辑/01.mp3' }];
  const cat = MAP.buildTrackAlbumMap({ files: catFiles, rootName: 'a' }, 'cat', 'a');
  assert.equal(cat.get(MAP.uid('t', '分类/专辑/01.mp3')).albumId, 'af58ed7');

  const auto = MAP.buildTrackAlbumMap({ files: catFiles, rootName: 'a' }, 'auto', 'a');
  assert.equal(auto.get(MAP.uid('t', '分类/专辑/01.mp3')).albumId, 'af58ed7', 'auto 遇到「分类/专辑」应认出二级专辑');

  /* 同一份文件在 flat 下是「分类」一张，cat/auto 下是「分类/专辑」一张 */
  const flatOne = MAP.buildTrackAlbumMap({ files: catFiles, rootName: 'a' }, 'flat', 'a');
  assert.notEqual(flatOne.get(MAP.uid('t', '分类/专辑/01.mp3')).albumId, 'af58ed7');

  /* auto 的三级专辑：中间分组不影响，落点是第一个直接含音频的目录 */
  const deep = MAP.buildTrackAlbumMap({ files: [{ rel: '分类/中间/专辑/01.mp3' }], rootName: 'a' }, 'auto', 'a');
  assert.equal(deep.get(MAP.uid('t', '分类/中间/专辑/01.mp3')).albumId, MAP.uid('a', '分类/中间/专辑'));

  /* auto 的章节目录往上收一层：01-开篇词 不单独成专辑 */
  const chap = MAP.buildTrackAlbumMap({ files: [{ rel: '分类/专辑/01-开篇词/01.mp3' }], rootName: 'a' }, 'auto', 'a');
  assert.equal(chap.get(MAP.uid('t', '分类/专辑/01-开篇词/01.mp3')).albumId, 'af58ed7');
});

test('补差：现有更小补到重算值，写入幂等，dry-run 不落库', () => {
  const db = setup();
  DB.albumListenAdd(db, 'u_admin', [{ albumId: AID, libRoot: ROOT, title: '三体', deltaSecs: 100 }]);
  markDone(db, ROOT, T1, 600);
  markDone(db, ROOT, MAP.uid('t', '三体/02.mp3'), 600);

  const plan = R.buildPlan(db, { uid: 'u_admin' });
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].albumId, AID);
  assert.equal(plan.rows[0].count, 2);
  assert.equal(Math.round(plan.rows[0].calcSecs), 1200);
  assert.equal(Math.round(plan.rows[0].deltaSecs), 1100);
  assert.equal(DB.albumListenTop(db, 'u_admin', ROOT, 5)[0].secs, 100, '预览阶段不能写库');

  assert.equal(R.applyPlan(db, plan).changed, 1);
  assert.equal(DB.albumListenTop(db, 'u_admin', ROOT, 5)[0].secs, 1200);
  assert.equal(DB.albumListenTop(db, 'u_admin', ROOT, 5)[0].title, '三体');

  /* 复跑：没有可补的差额 */
  const again = R.buildPlan(db, { uid: 'u_admin' });
  assert.equal(again.rows.length, 0);
  assert.equal(R.applyPlan(db, again).changed, 0);
  assert.equal(DB.albumListenTop(db, 'u_admin', ROOT, 5)[0].secs, 1200);
});

test('现有值更大：保持不动，标题快照也不被覆盖', () => {
  const db = setup();
  DB.albumListenAdd(db, 'u_admin', [{ albumId: AID, libRoot: ROOT, title: '用户改过的名字', deltaSecs: 3000 }]);
  markDone(db, ROOT, T1, 600);

  const plan = R.buildPlan(db, { uid: 'u_admin' });
  assert.equal(plan.rows.length, 0);
  R.applyPlan(db, plan);
  const row = DB.albumListenTop(db, 'u_admin', ROOT, 5)[0];
  assert.equal(row.secs, 3000);
  assert.equal(row.title, '用户改过的名字');
});

test('用户隔离：只处理指定用户，别的账号榜单不变', () => {
  const db = setup();
  DB.addUser(db, { id: 'u_other', username: 'other', role: 'user', salt: 'c2FsdA==', hash: 'aGFzaA==' });
  DB.albumListenAdd(db, 'u_other', [{ albumId: AID, libRoot: ROOT, title: '三体', deltaSecs: 77 }]);
  markDone(db, ROOT, T1, 600);
  markDone(db, ROOT, T1, 900, 'u_other');

  const plan = R.buildPlan(db, { uid: 'u_admin' });
  assert.equal(plan.rows.length, 1);
  R.applyPlan(db, plan);
  assert.equal(DB.albumListenTop(db, 'u_admin', ROOT, 5)[0].secs, 600);
  assert.equal(DB.albumListenTop(db, 'u_other', ROOT, 5)[0].secs, 77, '其他用户的行不能被改');
});

test('脏数据：done=0 不计，未映射跳过，时长异常跳过，d 缺失用 durations 兜底', () => {
  const db = setup();
  const t2 = MAP.uid('t', '三体/02.mp3');
  markDone(db, ROOT, T1, 600);                      /* 正常 */
  DB.userProgressWrite(db, 'u_admin', DB.libRootKey(ROOT), { t2: { p: 100, d: 900, done: false, t: 2 } });  /* 未听完 */
  markDone(db, ROOT, 'tNotInScan', 100);            /* 未映射 */
  markDone(db, ROOT, MAP.uid('t', '三体/03.mp3'), 0);          /* d=0，走 durations */
  markDone(db, ROOT, MAP.uid('t', '三体/04.mp3'), 200000);     /* 异常大，跳过 */
  putScan(db, ROOT, [
    { rel: '三体/01.mp3' }, { rel: '三体/02.mp3' },
    { rel: '三体/03.mp3' }, { rel: '三体/04.mp3' }
  ]);
  DB.durationUpsert(db, ROOT, { [MAP.uid('t', '三体/03.mp3')]: 300 });

  const plan = R.buildPlan(db, { uid: 'u_admin' });
  assert.equal(plan.stats.doneRows, 4, 'done=0 不进查询');
  assert.equal(plan.stats.unmapped, 1);
  assert.equal(plan.stats.fallback, 1);
  assert.equal(plan.stats.badDuration, 1);
  assert.equal(plan.stats.mapped, 2, '只有 01 和 03 计入');
  assert.equal(plan.rows.length, 1);
  assert.equal(Math.round(plan.rows[0].calcSecs), 900);
});

test('没有扫描缓存：跳过并计数；用 --scan 导出可以补上', () => {
  const db = fresh();
  addLib(db, 'l1', ROOT, '测试库');
  markDone(db, ROOT, T1, 600);

  let plan = R.buildPlan(db, { uid: 'u_admin' });
  assert.equal(plan.stats.noCache, 1);
  assert.equal(plan.rows.length, 0);

  plan = R.buildPlan(db, {
    uid: 'u_admin',
    scans: [{ root: ROOT, rootName: 'libRoot', files: [{ rel: '三体/01.mp3' }] }]
  });
  assert.equal(plan.stats.noCache, 0);
  assert.equal(plan.rows.length, 1);
  assert.equal(Math.round(plan.rows[0].calcSecs), 600);
});

test('标题优先级：album_meta 重命名 > album_listen 快照 > 扫描目录名', () => {
  const db = setup();
  const bId = MAP.uid('a', '三体2');
  putScan(db, ROOT, [{ rel: '三体/01.mp3' }, { rel: '三体2/01.mp3' }]);
  markDone(db, ROOT, T1, 600);
  markDone(db, ROOT, MAP.uid('t', '三体2/01.mp3'), 300);
  DB.albumMetaUpsert(db, ROOT, { [AID]: { cats: [], title: '重命名后的三体' } });
  DB.albumListenAdd(db, 'u_admin', [{ albumId: bId, libRoot: ROOT, title: '旧快照标题', deltaSecs: 10 }]);

  const plan = R.buildPlan(db, { uid: 'u_admin' });
  const byId = new Map(plan.rows.map(function (r) { return [r.albumId, r]; }));
  assert.equal(byId.get(AID).title, '重命名后的三体');
  assert.equal(byId.get(bId).title, '旧快照标题');
});

test('--lib 过滤：只重算指定库', () => {
  const db = setup();
  const rootB = '/lib/b';
  addLib(db, 'l2', rootB, '第二个库');
  putScan(db, rootB, [{ rel: '别的/01.mp3' }]);
  markDone(db, ROOT, T1, 600);
  markDone(db, rootB, MAP.uid('t', '别的/01.mp3'), 300);

  const all = R.buildPlan(db, { uid: 'u_admin' });
  assert.equal(all.rows.length, 2);

  const only = R.buildPlan(db, { uid: 'u_admin', lib: 'l2' });
  assert.equal(only.rows.length, 1);
  assert.equal(only.rows[0].libRoot, DB.libRootKey(rootB));

  const byPath = R.buildPlan(db, { uid: 'u_admin', lib: ROOT });
  assert.equal(byPath.rows.length, 1);
  assert.equal(byPath.rows[0].libRoot, DB.libRootKey(ROOT));
});

test('参数解析：--apply 与 --dry-run 互斥，--scan 可多次', () => {
  const o = R.parse(['--apply', '--scan', 'a.json', '--scan', 'b.json', '--db', 'x.db', '--limit', '7']);
  assert.equal(o.apply, true);
  assert.deepEqual(o.scans, ['a.json', 'b.json']);
  assert.equal(o.db, 'x.db');
  assert.equal(o.limit, 7);
  assert.equal(R.parse(['--apply', '--dry-run']).apply, false);
  assert.throws(function () { R.parse(['--nope']); }, /未知参数/);
});
