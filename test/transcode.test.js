/* transcode.js：格式表、缓存 key、真实 ffmpeg 转码、时长探测、缓存清理。
   需要本机有 ffmpeg（FM_FFMPEG / bin/ffmpeg / PATH 任一处）；没有就整组跳过。
   跑法：node --test test */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TC = require('../transcode');

const FFMPEG = TC.findFfmpeg();
const NO_FFMPEG = !FFMPEG;

/* 临时工作目录：样本和缓存都放这儿，整个文件跑完统一删掉 */
const temps = [];
test.after(function () {
  temps.forEach(function (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
});

function workDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-tc-test-'));
  temps.push(dir);
  return dir;
}

function ffmpeg(args) {
  execFileSync(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'].concat(args), { stdio: 'pipe' });
}

/* 1 秒的 flv（h264 + aac）：体积很小，重封装不到 1 秒；1 秒的 wma 用来测音频转码 */
function makeSamples(dir) {
  const flv = path.join(dir, 'a.flv');
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', flv
  ]);
  return { flv: flv };
}

function makeWma(dir) {
  const wma = path.join(dir, 'a.wma');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-ac', '1', '-ar', '44100', '-c:a', 'wmav2', '-b:a', '32k', wma]);
  return wma;
}

test('格式表：flv → mp4、wma → mp3；ape/wv 一律不转码', () => {
  ['ape', 'wv'].forEach(function (e) {
    assert.equal(TC.outExt(e), '', e + ' 不再走转码');
    assert.equal(TC.needs(e), false, e + ' 不该触发转码');
  });
  assert.equal(TC.outExt('.APE'), '');
  assert.equal(TC.outExt('flv'), 'mp4');
  assert.equal(TC.outExt('wma'), 'mp3', 'wma 交给 ffmpeg 转成真 mp3 文件');
  assert.equal(TC.outExt('WMA'), 'mp3');
  assert.equal(TC.outExt('mp3'), '');
  assert.equal(TC.needs('mp4'), false);
  assert.equal(TC.needs('FLV'), true);
  assert.equal(TC.needs('wma'), true);
});

test('缓存文件名：40 位 sha1 + 目标扩展名，size/mtime 变了 key 跟着变', () => {
  /* 下面几条只测纯函数，不需要 ffmpeg */
  const a = TC.key('书/第01集.wma', { size: 100, mtimeMs: 1000 });
  const b = TC.key('书/第01集.wma', { size: 101, mtimeMs: 1000 });
  const c = TC.key('书/第01集.wma', { size: 100, mtimeMs: 2000 });
  assert.match(a, /^[a-f0-9]{40}$/);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(TC.key('书/第01集.wma', { size: 100, mtimeMs: 1000 }), a, '同样的输入必须稳定');
  const l1 = TC.key('书/第01集.wma', { size: 100, mtimeMs: 1000 }, 'alist:l1|书/第01集.wma');
  const l2 = TC.key('书/第01集.wma', { size: 100, mtimeMs: 1000 }, 'alist:l2|书/第01集.wma');
  assert.notEqual(l1, l2, '不同网盘库即使 rel/size/mtime 相同也不能共用缓存');
  assert.equal(TC.fileName('x.flv', { size: 1, mtimeMs: 2 }, 'mp4'),
    TC.key('x.flv', { size: 1, mtimeMs: 2 }) + '.mp4');
  assert.match(TC.fileName('x.flv', { size: 1, mtimeMs: 2 }, 'mp4'), TC.NAME_RE);
});

test('前端白名单：flv / wma 要转码，ape/wv 归为不支持，但仍能扫进库', () => {
  global.window = global.window || {};
  global.window.FM = global.window.FM || {};
  require('../js/media.js');
  const M = global.window.FM.media;
  assert.equal(M.kindOf('flv'), 'video');
  assert.equal(M.kindOf('wma'), 'audio');
  assert.equal(M.VIDEO.flv, 1, 'flv 必须能扫进来，否则库里根本看不到');
  assert.equal(M.AUDIO.wv, 1, 'wv 仍要扫进库（列表里能看到，只是播不了）');
  assert.equal(M.needsTranscode('flv'), true, 'flv 需要重封装');
  ['ape', 'wv'].forEach(function (e) {
    assert.equal(M.needsTranscode(e), false, e + ' 不再转码');
    assert.equal(M.unsupported(e), true, e + ' 要落到「不支持格式」上');
    assert.equal(M.AUDIO[e], 1, e + ' 仍要扫进库');
  });
  assert.equal(M.needsTranscode('wma'), true, 'wma 要转成 mp3 才能播');
  assert.equal(M.clientTranscode('wma'), true, '没 ffmpeg 时还能退到浏览器内解码');
  assert.equal(M.unsupported('wma'), false, 'wma 有解，不该归到不支持');
  assert.equal(M.unsupported('mp3'), false);
  ['mp3', 'mp4', 'm4a', 'webm'].forEach(function (e) {
    assert.equal(M.needsTranscode(e), false, e + ' 不该触发转码');
  });
  assert.equal(M.needsTranscode('FLV'), true, '扩展名大小写不敏感');
  assert.equal(M.needsTranscode('WMA'), true);
  assert.equal(M.unsupported('WV'), true, '不支持的判断也不区分大小写');
  assert.equal(M.unsupported('APE'), true);
});

/* 只在本机完全没有 ffmpeg 时才成立：FM_FFMPEG 指向不存在的路径后仍然找得到 PATH 上的 */
test('没有 ffmpeg 时：findFfmpeg 返回空，prepare 抛 no-ffmpeg', { skip: NO_FFMPEG ? false : '本机有 ffmpeg，无法模拟缺失' }, async () => {
  const old = process.env.FM_FFMPEG;
  process.env.FM_FFMPEG = path.join(os.tmpdir(), 'no-such-ffmpeg-please');
  try {
    assert.equal(TC.findFfmpeg(true), '');
    await assert.rejects(
      () => TC.prepare({ file: 'x.flv', rel: 'x.flv', stat: { size: 1, mtimeMs: 1 }, cacheDir: os.tmpdir() }),
      function (e) { return e.code === 'no-ffmpeg'; }
    );
  } finally {
    if (old == null) delete process.env.FM_FFMPEG; else process.env.FM_FFMPEG = old;
    TC.findFfmpeg(true);
  }
});

/* ape / wv 改成「直接提示不支持」后，后端也不该再接受它们：前端一拦，这里就不该有调用；
   万一有旧页面或手工请求进来，明确报 bad-format 比偷偷转一分钟更清楚 */
test('ape / wv 不再转码：prepare 直接抛 bad-format', async () => {
  for (const ext of ['ape', 'wv']) {
    await assert.rejects(
      () => TC.prepare({ file: 'x.' + ext, rel: 'x.' + ext, stat: { size: 1, mtimeMs: 1 }, cacheDir: os.tmpdir() }),
      function (e) { return e.code === 'bad-format'; },
      ext + ' 应该被拒绝'
    );
  }
});

test('flv → mp4：默认走重封装（copy），产物时长正确且第二次命中缓存', { skip: NO_FFMPEG && '本机没有 ffmpeg' }, async function (t) {
  const dir = workDir();
  const cacheDir = path.join(dir, 'cache');
  let f = '';
  try { f = makeSamples(dir).flv; } catch (e) { return t.skip('本机 ffmpeg 不支持 libx264 编码'); }
  const st = fs.statSync(f);
  const opt = { file: f, rel: 'a.flv', stat: { size: st.size, mtimeMs: st.mtimeMs }, cacheDir: cacheDir };

  const r1 = await TC.prepare(opt);
  assert.equal(r1.ext, 'mp4');
  assert.equal(r1.cached, false);
  const out = fs.statSync(r1.file);
  /* 重封装不重新编码：体积和源文件基本一致（差几十字节的头），差太多说明偷偷重编码了 */
  assert.ok(out.size > st.size * 0.5 && out.size < st.size * 1.5,
    'flv 重封装后体积应该和源文件接近，' + st.size + ' → ' + out.size);

  const dur = await TC.probeDuration(r1.file);
  assert.ok(Math.abs(dur - 1) < 0.4, '转出来的 mp4 时长应约 1 秒，实际 ' + dur);

  const r2 = await TC.prepare(opt);
  assert.equal(r2.cached, true);
});

test('wma → mp3：原生 LAME 转成真文件，时长正确且第二次命中缓存', { skip: NO_FFMPEG && '本机没有 ffmpeg' }, async function (t) {
  const dir = workDir();
  const cacheDir = path.join(dir, 'cache');
  let f = '';
  try { f = makeWma(dir); } catch (e) { return t.skip('本机 ffmpeg 不支持 wmav2 编码'); }
  const st = fs.statSync(f);
  const opt = { file: f, rel: 'a.wma', stat: { size: st.size, mtimeMs: st.mtimeMs }, cacheDir: cacheDir };

  const r1 = await TC.prepare(opt);
  assert.equal(r1.ext, 'mp3', 'wma 的产物必须是 mp3');
  assert.equal(r1.cached, false);
  assert.match(path.basename(r1.file), TC.NAME_RE, '产物文件名要能过 __tc 通道的白名单');

  /* 单声道走 48k：2 秒约 12KB，给一倍容差，能挡住「其实没转/转成空文件」 */
  const out = fs.statSync(r1.file);
  assert.ok(out.size > 4000 && out.size < 30000, 'mp3 体积应约 12KB，实际 ' + out.size);

  const dur = await TC.probeDuration(r1.file);
  assert.ok(Math.abs(dur - 2) < 0.4, '转出来的 mp3 时长应约 2 秒，实际 ' + dur);

  const r2 = await TC.prepare(opt);
  assert.equal(r2.cached, true, '第二次必须直接命中缓存');
});

test('网盘直链：input 是 http 地址也能转出 mp3，且换一条签名仍命中同一份缓存',
  { skip: NO_FFMPEG && '本机没有 ffmpeg' }, async function (t) {
    const dir = workDir();
    const cacheDir = path.join(dir, 'cache');
    let f = '';
    try { f = makeWma(dir); } catch (e) { return t.skip('本机 ffmpeg 不支持 wmav2 编码'); }
    /* 网盘直链本质就是「带临时签名的静态文件」，本地照这个形状起一个就够了 */
    const http = require('node:http');
    const data = fs.readFileSync(f);
    const srv = http.createServer(function (req, res) {
      const m = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range || ''));
      if (!m) {
        return res.writeHead(200, { 'content-length': data.length, 'accept-ranges': 'bytes' }).end(data);
      }
      const s = m[1] === '' ? Math.max(0, data.length - Number(m[2])) : Number(m[1]);
      const e = m[2] === '' ? data.length - 1 : Math.min(Number(m[2]), data.length - 1);
      res.writeHead(206, {
        'content-length': e - s + 1,
        'content-range': 'bytes ' + s + '-' + e + '/' + data.length,
        'accept-ranges': 'bytes'
      }).end(data.subarray(s, e + 1));
    });
    await new Promise(function (r) { srv.listen(0, '127.0.0.1', r); });
    const url = 'http://127.0.0.1:' + srv.address().port + '/a.wma?sign=tmp';
    const opt = { input: url, rel: 'net/a.wma', stat: { size: data.length, mtimeMs: 1000 }, cacheDir: cacheDir };
    try {
      const r1 = await TC.prepare(opt);
      assert.equal(r1.ext, 'mp3', '直链输入也要转成 mp3');
      assert.equal(r1.cached, false);
      assert.match(path.basename(r1.file), TC.NAME_RE);
      const out = fs.statSync(r1.file);
      assert.ok(out.size > 4000 && out.size < 30000, 'mp3 体积应约 12KB，实际 ' + out.size);

      /* 直链里的签名每次都变：缓存只认 rel+size+mtime，换一条链接也必须命中 */
      const r2 = await TC.prepare(Object.assign({}, opt, { input: url + '&sign=new' }));
      assert.equal(r2.cached, true, '换签名后必须仍命中同一个产物');

      /* 不同网盘库恰好有同名同大小同 mtime 文件时，不能复用另一库的音频 */
      const otherLib = await TC.prepare(Object.assign({}, opt, {
        input: url + '&other-lib=1', cacheKey: 'alist:other-lib|net/a.wma'
      }));
      assert.equal(otherLib.cached, false, '库作用域不同必须生成隔离缓存');
      assert.notEqual(otherLib.file, r1.file);

      /* 时长探测同理：临时签名不能进缓存键，否则每刷新一次就多探一遍 */
      const d = await TC.probeDuration(url, 'alist:lib|net/a.wma');
      assert.ok(Math.abs(d - 2) < 0.4, '直链探测时长应约 2 秒，实际 ' + d);
      assert.equal(await TC.probeDuration('http://127.0.0.1:1/none.wma', 'alist:lib|none'), 0,
        '取不到的直链返回 0，不抛错');
    } finally {
      srv.close();
    }
  });

test('取消：转码中 abort 立刻收场，不留半成品', { skip: NO_FFMPEG && '本机没有 ffmpeg' }, async function (t) {
  const dir = workDir();
  const cacheDir = path.join(dir, 'cache');
  let f = '';
  try {
    /* flv1（Sorenson H.263）进不了 mp4：copy 必然失败，会走重编码，
       2 分钟 640x480 足够跑出一批进度事件，取消才测得准 */
    f = path.join(dir, 'long.flv');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=120:size=640x480:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=120',
      '-c:v', 'flv1', '-c:a', 'libmp3lame', '-shortest', f]);
  } catch (e) { return t.skip('本机 ffmpeg 不支持 flv1 编码'); }
  const st = fs.statSync(f);
  const ctrl = new AbortController();
  const p = TC.prepare({
    file: f, rel: 'long.flv', stat: { size: st.size, mtimeMs: st.mtimeMs }, cacheDir: cacheDir, signal: ctrl.signal,
    /* 收到第一个进度才取消：这说明 ffmpeg 已经在跑，才验证得到「杀进程 + 清 .part」 */
    onProgress: function () { try { ctrl.abort(); } catch (e) {} }
  });
  await assert.rejects(p, function (e) { return e.code === 'aborted'; });
  await new Promise(function (r) { setTimeout(r, 120); });
  const left = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];
  assert.deepEqual(left, [], '取消后不该留下 .part 或转了一半的文件，实际：' + left.join(','));
  /* 取消过的文件重新请求时还得能正常转（不是把状态搞坏了） */
  const again = await TC.prepare({ file: f, rel: 'long.flv', stat: { size: st.size, mtimeMs: st.mtimeMs }, cacheDir: cacheDir });
  assert.equal(again.ext, 'mp4');
  assert.equal(again.cached, false);
});

test('取消：多个等待者时，取消一个不影响另一个（同一个任务只转一次）', { skip: NO_FFMPEG && '本机没有 ffmpeg' }, async function (t) {
  const dir = workDir();
  const cacheDir = path.join(dir, 'cache');
  let f = '';
  try {
    f = path.join(dir, 'share.flv');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=120:size=640x480:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=120',
      '-c:v', 'flv1', '-c:a', 'libmp3lame', '-shortest', f]);
  } catch (e) { return t.skip('本机 ffmpeg 不支持 flv1 编码'); }
  const st = fs.statSync(f);
  const opt = { file: f, rel: 'share.flv', stat: { size: st.size, mtimeMs: st.mtimeMs }, cacheDir: cacheDir };

  const c1 = new AbortController();
  const p1 = TC.prepare(Object.assign({
    signal: c1.signal,
    /* 转起来之后再取消，避免「其实早就转完了」的假失败 */
    onProgress: function () { try { c1.abort(); } catch (e) {} }
  }, opt));
  /* 第二个调用同时发起：可能 join 到同一个任务，也可能因为还没登记而排到后面，
     两种情况下它都必须成功 */
  await new Promise(function (r) { setTimeout(r, 80); });   // 等 p1 进 inflight，p2 才是 join
  const p2 = TC.prepare(Object.assign({}, opt));

  await assert.rejects(p1, function (e) { return e.code === 'aborted'; });
  const r2 = await p2;
  assert.equal(r2.ext, 'mp4', '还有人在等，任务不该被一起取消');

  const r3 = await TC.prepare(opt);
  assert.equal(r3.cached, true, '产物应已落盘，第三个调用走缓存');
});

test('时长探测：不存在的文件返回 0，不抛错', { skip: NO_FFMPEG && '本机没有 ffmpeg' }, async () => {
  const dir = workDir();
  assert.equal(await TC.probeDuration(path.join(dir, 'nope.wv')), 0);
});

test('缓存清理：超过上限时从最旧的删到 80%，中断残留的 .part 也会被清掉', async () => {
  const dir = workDir();
  const cacheDir = path.join(dir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const keyOf = function (i) { return String(i).padStart(40, '0'); };
  /* 4 个 100 字节的缓存（keyOf(0) 最旧）+ 一个 7 小时前的 .part */
  for (let i = 0; i < 4; i++) {
    const f = path.join(cacheDir, keyOf(i) + '.mp3');
    fs.writeFileSync(f, Buffer.alloc(100, i));
    const old = new Date(Date.now() - (100 - i) * 60 * 1000);
    fs.utimesSync(f, old, old);
  }
  const part = path.join(cacheDir, keyOf(9) + '.mp4.part');
  fs.writeFileSync(part, Buffer.alloc(100));
  const oldPart = new Date(Date.now() - 7 * 3600 * 1000);
  fs.utimesSync(part, oldPart, oldPart);

  await TC.sweep(cacheDir, 250);
  const left = fs.readdirSync(cacheDir);
  assert.ok(!fs.existsSync(part), '过期 .part 应被清掉');
  assert.ok(fs.existsSync(path.join(cacheDir, keyOf(3) + '.mp3')), '最新的一个是最后一个被删的');
  const total = left.reduce(function (n, name) { return n + fs.statSync(path.join(cacheDir, name)).size; }, 0);
  assert.ok(total <= 250, '清理后总量要回到上限以下，实际 ' + total);
});
