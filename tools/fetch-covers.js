#!/usr/bin/env node
/* ── fetch-covers.js · 从喜马拉雅抓取专辑封面 ────────────────────────
 *
 * 有声书目录名通常就是喜马拉雅上的专辑标题，所以拿目录名去搜索、比对、
 * 下载封面，存到 <音频目录>/.fm-covers/ 下，并写一份 covers.json 给播放器用。
 *
 * 用法：
 *   node tools/fetch-covers.js                      # 默认抓 E:\迅雷下载\output
 *   node tools/fetch-covers.js --root "D:/有声书"    # 换目录
 *   node tools/fetch-covers.js --force              # 重抓（默认跳过已抓过的）
 *   node tools/fetch-covers.js --only 三体           # 只抓名字含关键字的专辑
 *
 * 已抓过的专辑会跳过，所以新加了几本书就再跑一次，很便宜。
 * 搜索走 360（喜马拉雅官方搜索接口对非登录请求有风控，多数网络会直接返回
 * risk invalid），命中后再用喜马拉雅专辑接口拿标题和封面，比搜索引擎里的
 * 链接靠谱，也能顺手校验相似度。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HEADERS = {
  'user-agent': UA,
  'accept-language': 'zh-CN,zh;q=0.9',
  'accept': 'text/html,application/json,application/xhtml+xml'
};
const COVER_DIR = '.fm-covers';
const MIN_SCORE = 0.6;       // 低于这个相似度就宁可继续用生成的渐变封面
const MAX_CANDIDATES = 8;

function parseArgs(argv) {
  const o = { root: 'E:/迅雷下载/output', force: false, only: '', delay: 1500 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a === '--force') o.force = true;
    else if (a === '--only') o.only = argv[++i];
    else if (a === '--delay') o.delay = parseInt(argv[++i], 10) || 0;
  }
  return o;
}

/* ── 文本处理：只留字母和数字，书名号、空格、竖线都不参与比较 ── */
function norm(s) {
  const m = String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return m ? m.join('') : '';
}
function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}
function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  A.forEach(x => { if (B.has(x)) hit++; });
  return (2 * hit) / (A.size + B.size);
}

/* 目录名常带「丨作者 演播」这类尾巴，取第一个分隔段当书名 */
function titleOf(dirName) {
  const s = String(dirName).trim();
  const head = s.split(/[丨|｜]|\s{2,}/)[0] || s;
  const book = head.match(/^《([^》]+)》/);
  return (book ? book[1] : head).replace(/[!！].*$/, '').trim();
}

function scoreOf(dirName, albumTitle) {
  const whole = norm(dirName);
  const book = norm(titleOf(dirName));
  const title = norm(albumTitle);
  const A = bigrams(whole), B = bigrams(title);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  A.forEach(function (x) { if (B.has(x)) hit++; });
  const recall = hit / A.size;
  const precision = hit / B.size;
  const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
  /* 目录名几乎被专辑标题整段包含：多半就是这本（专辑标题常带一堆卖点尾巴，
     用 F1 会被稀释，所以单独给一条只看覆盖率的通道）。太短的名字不放行。 */
  const covered = A.size >= 6 && recall >= 0.9 ? 0.9 + 0.1 * precision : 0;
  let s = Math.max(f1, covered);
  if (book.length >= 2) {
    if (title.indexOf(book) === 0) s += 0.14;
    else if (title.indexOf(book) >= 0) s += 0.07;
  }
  return Math.min(1, s);
}

/* ── 网络 ── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchText(url, headers) {
  const res = await fetch(url, { headers: Object.assign({}, HEADERS, headers || {}), redirect: 'follow' });
  return { status: res.status, text: await res.text() };
}

/* 360 搜索：无 site: 的普通查询最稳。www 会时不时弹安全验证，m 站通常还通，
   两个都试一遍比死等一个快。 */
async function search360(query) {
  const hosts = ['https://m.so.com/s?q=', 'https://www.so.com/s?q='];
  const idsRe = new RegExp("ximalaya[.]com/album/([0-9]+)", "g");
  for (let round = 0; round < 2; round++) {
    for (const host of hosts) {
      try {
        const r = await fetchText(host + encodeURIComponent(query));
        if (r.status === 200 && r.text.length > 15000 && !/安全验证|请输入验证码/.test(r.text)) {
          const ids = [];
          let m;
          idsRe.lastIndex = 0;
          while ((m = idsRe.exec(r.text))) if (!ids.includes(m[1])) ids.push(m[1]);
          return ids;
        }
      } catch (e) {}
      await sleep(1800);
    }
    await sleep(3000 + round * 3000);
  }
  return [];
}

/* 喜马拉雅专辑页（www.ximalaya.com/album/<id>）是前端渲染的，HTML 里没有封面，
   页面自己会去拉 /revision/album/v1/simple?albumId=<id>，封面就在那个响应里。
   所以「找专辑页 → 取封面」这一步就是打同一个接口。 */
function absUrl(u) {
  if (!u) return "";
  return u.indexOf("//") === 0 ? "https:" + u : u;
}

async function albumInfo(id) {
  try {
    const r = await fetchText("https://www.ximalaya.com/revision/album/v1/simple?albumId=" + id, {
      "accept": "application/json, text/plain, */*",
      "referer": "https://www.ximalaya.com/album/" + id
    });
    const j = JSON.parse(r.text);
    const d = j && j.data && j.data.albumPageMainInfo;
    if (!d) return null;
    return {
      id: id,
      title: d.albumTitle || "",
      cover: absUrl(d.cover),
      playCount: d.playCount || 0
    };
  } catch (e) { return null; }
}

/* ── 主流程 ── */
async function main() {
  const opt = parseArgs(process.argv);
  const root = path.resolve(opt.root);
  if (!fs.existsSync(root)) { console.error('目录不存在：' + root); process.exit(1); }

  const coverDir = path.join(root, COVER_DIR);
  await fsp.mkdir(coverDir, { recursive: true });
  const mapFile = path.join(coverDir, 'covers.json');

  let map = {};
  try { map = JSON.parse(await fsp.readFile(mapFile, 'utf8')) || {}; } catch (e) { map = {}; }

  /* manual.json：{ "目录名": "专辑id" }，手工指定的优先，跳过搜索 */
  let manual = {};
  try { manual = JSON.parse(await fsp.readFile(path.join(coverDir, 'manual.json'), 'utf8')) || {}; } catch (e) { manual = {}; }

  const dirs = (await fsp.readdir(root, { withFileTypes: true }))
    .filter(d => d.isDirectory() && !/^[._]/.test(d.name))
    .map(d => d.name)
    .filter(n => !opt.only || n.includes(opt.only));

  console.log('共 ' + dirs.length + ' 个专辑目录，封面存到 ' + coverDir + '\n');

  let ok = 0, kept = 0, failed = 0;
  const misses = [];

  for (const dirName of dirs) {
    const old = map[dirName];
    if (!opt.force && old && old.file && fs.existsSync(path.join(coverDir, old.file))) { kept++; continue; }

    /* manual.json 也可以直接写封面图片地址，这种就不搜了 */
    let manualVal = manual[dirName] ? String(manual[dirName]) : "";
    /* 也支持直接贴专辑页地址：https://www.ximalaya.com/album/39246532 */
    const pageId = (manualVal.match(/album[/]([0-9]+)/) || [])[1];
    if (pageId) manualVal = pageId;
    if (/^https?:/.test(manualVal)) {
      try {
        /* 带 !magick=webp 的地址换回原图格式，省得播放器还要认 webp */
        manualVal = manualVal.replace(/!magick=[^&]*/, "");
        const url = /xmcdn[.]com/.test(manualVal) && manualVal.indexOf("!") < 0
          ? manualVal + "!op_type=3&columns=600&rows=600"
          : manualVal;
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        const ext = /png/i.test(res.headers.get("content-type") || "") ? ".png" : ".jpg";
        const file = crypto.createHash("sha1").update(dirName).digest("hex").slice(0, 16) + ext;
        await fsp.writeFile(path.join(coverDir, file), buf);
        map[dirName] = {
          file: file,
          title: dirName,
          albumId: "",
          score: 1,
          at: new Date().toISOString().slice(0, 10),
          source: manualVal
        };
        await fsp.writeFile(mapFile, JSON.stringify(map, null, 2), "utf8");
        ok++;
        console.log("✓ 1.00  " + dirName.slice(0, 30) + "（manual.json 指定的图片）" + String.fromCharCode(10));
      } catch (e) {
        failed++;
        console.log("✗ " + dirName + " → 下载失败 " + e.message + String.fromCharCode(10));
      }
      continue;
    }

    let ids = manualVal && !/^https?:/.test(manualVal) ? [manualVal] : [];
    if (!ids.length) {
      const book = titleOf(dirName);
      /* 把「丨」「｜」这类分隔符换成空格，整串丢给搜索引擎命中最准 */
      const plain = dirName.replace(/[丨|｜]/g, ' ').replace(/\s+/g, ' ').trim();
      const queries = [plain + ' 喜马拉雅'];
      if (book && book !== dirName) {
        queries.push(book + ' 喜马拉雅');
        queries.push(book + ' 有声书');
      }
      for (const q of queries) {
        const hit = await search360(q);
        ids = ids.concat(hit);
        ids = Array.from(new Set(ids));
        await sleep(opt.delay);
        if (ids.length >= MAX_CANDIDATES) break;
      }
    }
    ids = Array.from(new Set(ids)).slice(0, MAX_CANDIDATES);

    const cands = [];
    for (const id of ids) {
      const info = await albumInfo(id);
      if (info && info.cover) cands.push(Object.assign(info, { score: scoreOf(dirName, info.title) }));
      await sleep(300);
    }
    cands.sort((a, b) => b.score - a.score || b.playCount - a.playCount);
    const best = cands[0];

    /* manual.json 里写死的 id 直接信，不再按相似度卡 */
    if (!best || (best.score < MIN_SCORE && !manual[dirName])) {
      failed++;
      misses.push(dirName + (best ? '  （最高 ' + best.score.toFixed(2) + '：' + best.title.slice(0, 40) + '）' : '  （没搜到候选）'));
      console.log('✗ ' + dirName + ' → ' + (best ? '未匹配 ' + best.score.toFixed(2) + ' ' + best.title.slice(0, 28) : '没有候选') + '\n');
      continue;
    }

    try {
      /* 原图常 1MB+，走 CDN 缩放参数拿 600×600，卡片和全屏播放页都够用 */
      const dl = /xmcdn\.com/.test(best.cover) && best.cover.indexOf('!') < 0
        ? best.cover + '!op_type=3&columns=600&rows=600'
        : best.cover;
      const res = await fetch(dl, { headers: HEADERS });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = /png/i.test(res.headers.get('content-type') || '') ? '.png' : '.jpg';
      const file = crypto.createHash('sha1').update(dirName).digest('hex').slice(0, 16) + ext;
      await fsp.writeFile(path.join(coverDir, file), buf);
      map[dirName] = {
        file: file,
        title: best.title,
        albumId: best.id,
        score: +best.score.toFixed(3),
        at: new Date().toISOString().slice(0, 10)
      };
      ok++;
      await fsp.writeFile(mapFile, JSON.stringify(map, null, 2), 'utf8');   // 抓一张存一张，中途打断也不丢
      console.log('✓ ' + best.score.toFixed(2) + '  ' + dirName.slice(0, 30) + '\n     ' + best.title.slice(0, 46) + '\n');
    } catch (e) {
      failed++;
      misses.push(dirName + '  （下载失败：' + e.message + '）');
      console.log('✗ ' + dirName + ' → 下载失败 ' + e.message + '\n');
    }
  }

  await fsp.writeFile(mapFile, JSON.stringify(map, null, 2), 'utf8');

  console.log('完成：新增 ' + ok + '，已有 ' + kept + '，未匹配 ' + failed);
  if (misses.length) {
    console.log('\n需要人工确认的专辑：');
    misses.forEach(m => console.log('  - ' + m));
    console.log('\n确认后在 ' + path.join(coverDir, 'manual.json') + ' 里写上 {"目录名":"专辑id"}，重跑即可。');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
