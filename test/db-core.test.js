/* db.js 非元数据部分（设置、密码、用户、资源库、收藏、远程设备、旧文件迁移）的回归测试。
   这些都是每端启动必经的路径，改动 schema 或 SQL 时最容易静默踩坏。
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
/* 测试里把迭代次数压到 1000：PBKDF2 默认 60 万轮，跑几十次会让测试慢到没法用。
   addUser 走 password 分支时不吃 iterations 参数，所以要自己算好 salt/hash 传进去。 */
const FAST = 1000;
function user(db, name, extra) {
  const pw = DB.makePassword('123456', FAST);
  return DB.addUser(db, Object.assign({
    username: name, algo: pw.algo, iterations: FAST, salt: pw.salt, hash: pw.hash
  }, extra || {}));
}

test('settings：默认值 / 覆盖写入 / secret 只生成一次', () => {
  const db = fresh();
  assert.equal(DB.getSetting(db, '不存在'), null);
  assert.equal(DB.getSetting(db, '不存在', '兜底'), '兜底');
  DB.setSetting(db, 'k', 'v1');
  assert.equal(DB.getSetting(db, 'k'), 'v1');
  DB.setSetting(db, 'k', 'v2');
  assert.equal(DB.getSetting(db, 'k'), 'v2');
  DB.setSetting(db, 'n', 42);
  assert.equal(DB.getSetting(db, 'n'), '42', '非字符串按 String 存');

  const s1 = DB.secret(db);
  assert.ok(s1 && s1.length >= 40, 'secret 应是 32 字节 base64');
  DB.ensureSchema(db);
  assert.equal(DB.secret(db), s1, '重复建表不能换掉 secret，否则旧 token 全废');
  assert.notEqual(DB.secret(fresh()), s1, '不同库的 secret 应互相独立');
});

test('密码：makePassword 往返、错密码拒绝、缺字段不炸', () => {
  const pw = DB.makePassword('p@ss', FAST);
  assert.equal(pw.algo, 'pbkdf2_sha256');
  assert.equal(pw.iterations, FAST);
  assert.ok(pw.salt && pw.hash);
  assert.equal(DB.checkPassword(pw, 'p@ss'), true);
  assert.equal(DB.checkPassword(pw, 'p@ss '), false);
  assert.equal(DB.checkPassword(pw, ''), false);
  assert.equal(DB.checkPassword(null, 'p@ss'), false);
  assert.equal(DB.checkPassword({}, 'p@ss'), false);
  /* 同一个密码两次加盐结果不同 */
  assert.notEqual(DB.makePassword('same', FAST).hash, DB.makePassword('same', FAST).hash);
});

test('setUserPassword：旧密码失效、token_version 自增', () => {
  const db = fresh();
  const u = user(db, 'alice');
  const before = u.token_version;
  DB.setUserPassword(db, u.id, '新密码');
  const after = DB.getUser(db, u.id);
  assert.equal(after.token_version, before + 1);
  assert.equal(DB.checkPassword(after, '新密码'), true);
  assert.equal(DB.checkPassword(after, '123456'), false);
  DB.setUserPassword(db, u.id, '再改一次');
  assert.equal(DB.getUser(db, u.id).token_version, before + 2);
});

test('users：查找 / 排序 / 管理员优先 / 自动 id / 重名报错', () => {
  const db = fresh();
  assert.equal(DB.countUsers(db), 0);
  assert.equal(DB.adminUser(db), null);
  assert.equal(DB.firstUserId(db), null);

  const b = user(db, 'bob', { role: 'admin', createdAt: '2026-01-02T00:00:00.000Z' });
  const a = user(db, 'alice', { createdAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(DB.countUsers(db), 2);
  assert.deepEqual(DB.listUsers(db).map(function (u) { return u.username; }), ['alice', 'bob']);
  assert.equal(DB.firstUserId(db), a.id);
  assert.equal(DB.findUser(db, 'alice').id, a.id);
  assert.equal(DB.findUser(db, 'ALICE'), null, '用户名区分大小写');
  assert.equal(DB.findUser(db, ''), null);
  assert.equal(DB.getUser(db, '不存在'), null);
  assert.equal(DB.adminUser(db).id, b.id, '有 admin 时优先返回 admin');
  assert.throws(function () { user(db, 'alice'); }, /UNIQUE|constraint/i);
});

test('newUserId：用户名里的中文和符号不会进 id', () => {
  assert.match(DB.newUserId('张三 Zhang San!'), /^u_zhang_san_[a-z0-9]{4}$/);
  assert.match(DB.newUserId(''), /^u_user_[a-z0-9]{4}$/);
  assert.match(DB.newUserId('!!!'), /^u_user_[a-z0-9]{4}$/);
});

test('touchLogin / removeUser：时间戳写入，删用户级联清库和收藏', () => {
  const db = fresh();
  const u = user(db, 'carol');
  assert.equal(DB.getUser(db, u.id).last_login_at, null);
  DB.touchLogin(db, u.id);
  assert.match(DB.getUser(db, u.id).last_login_at, /^\d{4}-/);

  DB.replaceLibs(db, u.id, [{ id: 'l1', name: '有声书', path: '/media/a' }], 'l1');
  DB.setFav(db, u.id, 'l1', 'album1', true);
  DB.setFavTrack(db, u.id, 'l1', 't1', true);
  DB.removeUser(db, u.id);
  assert.equal(DB.countUsers(db), 0);
  assert.deepEqual(DB.listLibs(db, u.id), []);
  assert.deepEqual(DB.listFavs(db, u.id, 'l1'), []);
  assert.deepEqual(DB.listFavTracks(db, u.id, 'l1'), [], '删用户要连 fav_tracks 一起清（外键级联）');
});

test('replaceLibs：过滤无路径项、active 回落、顺序稳定、重复调用不累积', () => {
  const db = fresh();
  const u = user(db, 'dave');
  const list = [
    { id: 'l2', name: '乙库', path: '/media/b' },
    { path: '/media/c' },                       /* 没 id，要给个默认的 */
    { id: 'bad', name: '空路径', path: '' },     /* 应被过滤 */
    null
  ];
  assert.deepEqual(DB.replaceLibs(db, u.id, list, 'l2'), { active: 'l2' });
  let libs = DB.listLibs(db, u.id);
  assert.equal(libs.length, 2);
  assert.deepEqual(libs.map(function (l) { return l.id; }), ['l2', libs[1].id]);
  assert.equal(libs[0].active, 1);
  assert.equal(libs[1].name, 'c', '没名字时用目录名');
  assert.equal(DB.activeLib(db, u.id).id, 'l2');

  /* activeId 指向不存在的库 → 回落第一个 */
  assert.deepEqual(DB.replaceLibs(db, u.id, list, 'l9'), { active: 'l2' });
  assert.equal(DB.listLibs(db, u.id).length, 2, '替换而不是追加');
  /* 空列表 → 无 active */
  assert.deepEqual(DB.replaceLibs(db, u.id, [], 'l2'), { active: null });
  assert.deepEqual(DB.listLibs(db, u.id), []);
  assert.equal(DB.activeLib(db, u.id), null);
});

test('setActiveLib / getLib / libPath：切换互斥、跨用户按 id 查路径', () => {
  const db = fresh();
  const u1 = user(db, 'eve', { createdAt: '2026-01-01T00:00:00.000Z' });
  const u2 = user(db, 'frank', { createdAt: '2026-01-02T00:00:00.000Z' });
  DB.replaceLibs(db, u1.id, [{ id: 'a', name: 'A', path: '/media/a' }, { id: 'b', name: 'B', path: '/media/b' }], 'a');
  DB.replaceLibs(db, u2.id, [{ id: 'c', name: 'C', path: '/media/c' }], 'c');

  assert.equal(DB.setActiveLib(db, u1.id, 'b'), true);
  const libs = DB.listLibs(db, u1.id);
  assert.deepEqual(libs.map(function (l) { return l.active; }), [0, 1]);
  assert.equal(DB.activeLib(db, u1.id).id, 'b');
  assert.equal(DB.activeLib(db, u2.id).id, 'c', '切换别人的库不该影响自己');
  assert.equal(DB.setActiveLib(db, u1.id, '不属于我'), false);
  assert.equal(DB.activeLib(db, u1.id).id, 'b', '失败时不能把 active 清掉');

  assert.equal(DB.getLib(db, u1.id, 'a').path, '/media/a');
  assert.equal(DB.getLib(db, u2.id, 'a'), null, '不同用户看不到彼此的库');
  assert.equal(DB.libPath(db, 'a'), '/media/a');
  assert.equal(DB.libPath(db, '不存在'), null);
});

test('收藏：空参数拒绝、重复收藏幂等、清库时连带清曲目收藏', () => {
  const db = fresh();
  const u = user(db, 'grace');
  assert.equal(DB.setFav(db, '', 'l1', 'a1', true), false);
  assert.equal(DB.setFav(db, u.id, '', 'a1', true), false);
  assert.equal(DB.setFav(db, u.id, 'l1', '', true), false);

  assert.equal(DB.setFav(db, u.id, 'l1', 'a1', true), true);
  DB.setFav(db, u.id, 'l1', 'a1', true);                     /* 重复点收藏 */
  assert.deepEqual(DB.listFavs(db, u.id, 'l1'), ['a1']);

  DB.setFavTrack(db, u.id, 'l1', 't1', true);
  DB.setFavTrack(db, u.id, 'l1', 't2', true);
  DB.setFavTrack(db, u.id, 'l1', 't1', false);
  assert.deepEqual(DB.listFavTracks(db, u.id, 'l1'), ['t2']);
  assert.equal(DB.setFavTrack(db, u.id, 'l1', '', true), false);
  assert.equal(DB.clearFavTracks(db, u.id, 'l1'), 1);
  assert.deepEqual(DB.listFavTracks(db, u.id, 'l1'), []);

  assert.equal(DB.clearFavs(db, u.id, 'l1'), 1);
  assert.deepEqual(DB.listFavs(db, u.id, 'l1'), []);
  assert.equal(DB.clearFavs(db, '', 'l1'), 0);
  /* 别的库不受影响 */
  DB.setFav(db, u.id, 'l2', 'a9', true);
  DB.clearFavs(db, u.id, 'l1');
  assert.deepEqual(DB.listFavs(db, u.id, 'l2'), ['a9']);
});

test('remote：空配置读回 null，写完去掉尾斜杠，传 null 删除', () => {
  const db = fresh();
  assert.equal(DB.getRemote(db), null);
  const r = DB.setRemote(db, { base: 'https://fm.example.com//', token: 'tk', uid: 'u1' });
  assert.deepEqual(r, { base: 'https://fm.example.com', token: 'tk', uid: 'u1' });
  assert.deepEqual(DB.getRemote(db), r);
  /* 覆盖写 */
  DB.setRemote(db, { base: 'https://x.example.com', token: '', uid: null });
  assert.deepEqual(DB.getRemote(db), { base: 'https://x.example.com', token: '', uid: null });
  assert.equal(DB.setRemote(db, { base: '' }), null);
  assert.equal(DB.getRemote(db), null);
});

test('共享：指派给指定用户 / 所有人、物化只读行、撤销与清理', () => {
  const db = fresh();
  const admin = user(db, 'admin', { role: 'admin' });
  const bob = user(db, 'bob');
  const eve = user(db, 'eve');
  DB.replaceLibs(db, admin.id, [{ id: 'src1', name: '共享库', path: '/media/shared' }], 'src1');
  /* bob 自己已经有一个库：共享来的副本不应抢走 active */
  DB.replaceLibs(db, bob.id, [{ id: 'b1', name: 'B', path: '/media/b' }], 'b1');

  assert.equal(DB.listShares(db, 'src1'), null, '默认没有共享配置');
  assert.equal(DB.setLibShare(db, 'src1', false, [bob.id]), true);
  assert.deepEqual(DB.listShares(db, 'src1'), { targetAll: false, targets: [bob.id] });

  DB.syncUserSharedLibs(db, bob.id);
  const bl = DB.listLibs(db, bob.id);
  assert.equal(bl.length, 2);
  const sh = bl.find(function (l) { return l.shared_id === 'src1'; });
  assert.ok(sh, '目标用户应看到共享副本');
  assert.equal(sh.path, '/media/shared');
  assert.equal(sh.active, 0, '自己已有 active 库时，共享副本不抢激活');

  DB.syncUserSharedLibs(db, admin.id);
  assert.equal(DB.listLibs(db, admin.id).length, 1, '源库所有者本人不会被物化出重复行');

  /* 撤销指派：非 active 的副本应被清掉 */
  DB.setLibShare(db, 'src1', false, []);
  DB.syncUserSharedLibs(db, bob.id);
  assert.equal(DB.listLibs(db, bob.id).filter(function (l) { return l.shared_id; }).length, 0);

  /* 所有人：bob 和 eve 都能看到；源库所有者不重复 */
  DB.setLibShare(db, 'src1', true, []);
  DB.syncUserSharedLibs(db, bob.id);
  DB.syncUserSharedLibs(db, eve.id);
  assert.equal(DB.listLibs(db, bob.id).filter(function (l) { return l.shared_id === 'src1'; }).length, 1);
  assert.equal(DB.listLibs(db, eve.id).filter(function (l) { return l.shared_id === 'src1'; }).length, 1);
  assert.equal(DB.listLibs(db, admin.id).length, 1);

  /* replaceLibs 只重排自己的库，不误删共享副本 */
  DB.replaceLibs(db, bob.id, [{ id: 'b1', name: 'B', path: '/media/b' }], 'b1');
  assert.equal(DB.listLibs(db, bob.id).filter(function (l) { return l.shared_id; }).length, 1, '私有库替换不能删掉共享行');

  /* 源库被删：removeLibShare 连带清掉所有副本 */
  DB.removeLibShare(db, 'src1');
  assert.equal(DB.listShares(db, 'src1'), null);
  assert.equal(DB.listLibs(db, bob.id).filter(function (l) { return l.shared_id; }).length, 0);
  assert.equal(DB.listLibs(db, eve.id).filter(function (l) { return l.shared_id; }).length, 0);
});

test('migrate：迁移旧配置文件、已有用户时跳过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-mig-'));
  try {
    const authFile = path.join(dir, '.auth.json');
    const configFile = path.join(dir, 'config.json');
    const remoteFile = path.join(dir, 'remote.json');
    const pw = DB.makePassword('old-pw', FAST);
    fs.writeFileSync(authFile, JSON.stringify({
      algo: pw.algo, iterations: pw.iterations, salt: pw.salt, hash: pw.hash, createdAt: '2025-01-01T00:00:00.000Z'
    }));
    fs.writeFileSync(configFile, JSON.stringify({
      root: '/media/only', active: 'x'
    }));
    fs.writeFileSync(remoteFile, JSON.stringify({ base: 'https://fm.example.com/', token: 'tk' }));

    const db = fresh();
    const s = DB.migrate(db, { authFile: authFile, configFile: configFile, remoteFile: remoteFile });
    assert.equal(s.skipped, false);
    assert.equal(s.user, 'admin');
    assert.equal(s.generatedPassword, null, '已有 auth 文件就不该再生成密码');
    assert.equal(s.libs, 1);
    assert.equal(s.remote, true);

    const admin = DB.findUser(db, 'admin');
    assert.equal(admin.id, DB.ADMIN_ID);
    assert.equal(admin.role, 'admin');
    assert.equal(DB.checkPassword(admin, 'old-pw'), true, '老密码要还能登');
    assert.equal(DB.listLibs(db, DB.ADMIN_ID)[0].path, '/media/only');
    assert.equal(DB.getRemote(db).uid, DB.ADMIN_ID);

    /* 第二次迁移：已有用户，直接跳过 */
    assert.equal(DB.migrate(db, { authFile: authFile }).skipped, true);

    /* 没有 auth 文件：生成随机密码，且能用来登录 */
    const db2 = fresh();
    const s2 = DB.migrate(db2, {});
    assert.match(s2.generatedPassword, /^[A-Za-z0-9]{6,12}$/);
    assert.equal(DB.checkPassword(DB.findUser(db2, 'admin'), s2.generatedPassword), true);
    assert.equal(s2.libs, 0);
    assert.equal(s2.remote, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('账号规则：用户名格式与密码强度下限', () => {
  assert.equal(DB.usernameError('alice'), '');
  assert.equal(DB.usernameError('Alice_01'), '');
  assert.equal(DB.usernameError('a.b-c'), '');
  assert.notEqual(DB.usernameError(''), '');
  assert.notEqual(DB.usernameError('1alice'), '', '必须字母开头');
  assert.notEqual(DB.usernameError('a lice'), '', '不允许空格');
  assert.notEqual(DB.usernameError('alice!'), '', '不允许特殊符号');
  assert.notEqual(DB.usernameError('a'.repeat(65)), '', '最长 64');

  assert.equal(DB.passwordError('alice', 'abcd1234'), '');
  assert.notEqual(DB.passwordError('alice', 'short'), '', '至少 8 位');
  assert.notEqual(DB.passwordError('alice', '12345678'), '', '不能纯数字');
  assert.notEqual(DB.passwordError('longusername', 'LongUserName'), '', '不能和用户名相同（忽略大小写）');
  assert.notEqual(DB.passwordError('alice', '        '), '', '不能全空白');
});

test('用户状态：默认启用、禁用/启用自增 token_version、可用管理员计数', () => {
  const db = fresh();
  const admin = user(db, 'admin', { role: 'admin' });
  const bob = user(db, 'bob');
  assert.equal(DB.getUser(db, bob.id).disabled, 0, '默认启用');
  assert.equal(DB.countEnabledAdmins(db), 1);
  assert.equal(DB.listUsers(db).find(function (x) { return x.id === bob.id; }).disabled, 0, 'listUsers 带出 disabled');

  const v0 = DB.getUser(db, bob.id).token_version;
  assert.equal(DB.setUserDisabled(db, bob.id, true), true);
  const off = DB.getUser(db, bob.id);
  assert.equal(off.disabled, 1);
  assert.ok(off.token_version > v0, '禁用要自增 token_version，旧会话立即失效');
  assert.equal(DB.countEnabledAdmins(db), 1, '普通用户禁用不影响管理员计数');
  /* 状态没变化时不应重复自增 token_version */
  const v1 = DB.getUser(db, bob.id).token_version;
  assert.equal(DB.setUserDisabled(db, bob.id, true), false);
  assert.equal(DB.getUser(db, bob.id).token_version, v1);

  DB.setUserDisabled(db, admin.id, true);
  assert.equal(DB.countEnabledAdmins(db), 0, '最后一个管理员被禁用后计数归零（接口层会拦住）');
  DB.setUserDisabled(db, admin.id, false);
  assert.equal(DB.countEnabledAdmins(db), 1);
  assert.equal(DB.setUserDisabled(db, '不存在', true), false);
});

test('共享指派：addLibShareTarget 追加目标、target_all 时忽略', () => {
  const db = fresh();
  const admin = user(db, 'admin', { role: 'admin' });
  const bob = user(db, 'bob');
  const eve = user(db, 'eve');
  DB.replaceLibs(db, admin.id, [{ id: 'src1', name: '库', path: '/media/a' }], 'src1');

  assert.equal(DB.addLibShareTarget(db, 'src1', bob.id), true);
  assert.deepEqual(DB.listShares(db, 'src1'), { targetAll: false, targets: [bob.id] });
  DB.addLibShareTarget(db, 'src1', eve.id);
  assert.deepEqual(DB.listShares(db, 'src1').targets.sort(), [bob.id, eve.id].sort());

  /* 已「所有人」可见时不再记录单人目标（避免冗余，也不影响物化） */
  DB.setLibShare(db, 'src1', true, []);
  DB.addLibShareTarget(db, 'src1', bob.id);
  assert.deepEqual(DB.listShares(db, 'src1'), { targetAll: true, targets: [] });
});
