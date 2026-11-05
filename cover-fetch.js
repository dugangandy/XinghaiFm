#!/usr/bin/env node
/* ── cover-fetch.js · 从喜马拉雅抓取专辑封面 ─────────────────────────
 *
 * 有声书目录名通常就是喜马拉雅上的专辑标题，所以拿目录名去搜索、比对、
 * 下载封面，存到 <音频目录>/.fm-covers/ 下，并写一份 covers.json 给播放器用。
 *
 * 平时不用手动跑：主进程扫描资源库后发现有新专辑，会自动调 run() 在后台补封面。
 * 命令行仍然可用，方便单独验一个目录：
 *   node cover-fetch.js                      # 默认抓 E:\迅雷下载\output
 *   node cover-fetch.js --root "D:/有声书"    # 换目录
 *   node cover-fetch.js --force              # 重抓（默认跳过已抓过的）
 *   node cover-fetch.js --only 三体           # 只抓名字含关键字的专辑
 *   （tools/fetch-covers.js 是同一个入口，老命令照样能用）
 *
 * 搜索走喜马拉雅网页搜索框的 /revision/search（不需要登录，也不风控），
 * 命中后按标题相似度挑最像的一张，下载时统一换成 600×600。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const dns = require('node:dns').promises;

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

/* 单张封面的大小上限：正常 600×600 也就几十 KB，超过 2MB 基本是打歪了 */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/* 封面文件名只允许纯文件名（不含路径分隔符 / ..）。
   历史漏洞：saveCoverForDir 直接信任调用方传入的 opt.file，攻击者可写 "../../x.jpg" 覆盖任意文件。
   这里要求原值本身就是合法文件名，带路径的一律视为非法（回退到下面的哈希文件名）。 */
function safeCoverName(name) {
  const s = String(name == null ? '' : name);
  if (!s) return null;
  if (path.basename(s) !== s) return null;      /* 含 / \ 或 .. 等路径成分 */
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(s)) return null;
  if (/^\.+$/.test(s)) return null;             /* '.' '..' '...' */
  return s;
}

/* 本机 / 私有网段 / 链路本地 / 云元数据：这些地址一律不许服务端去碰 */
function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;                    // 链路本地（含云元数据）
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;        // CGNAT
    return p[0] >= 224;                                                // 组播 / 保留
  }
  const s = String(ip).toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.indexOf('::ffff:') === 0) return isBlockedIp(s.slice(7));
  return s.indexOf('fe80') === 0 || s.indexOf('fc') === 0 || s.indexOf('fd') === 0;
}

/* 封面地址是客户端给的，服务端不能盲取：只放行 http(s) 的公网地址，
   域名先解析一遍再逐个校验，避免解析到 127.0.0.1 / 内网。 */
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { throw new Error('图片地址无效'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https 图片地址');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error('不允许访问内网地址');
    return u;
  }
  if (/(^localhost$)|(\.local$)|(\.internal$)|(\.localhost$)/i.test(host)) throw new Error('不允许访问内网地址');
  let addrs = [];
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) { throw new Error('图片域名解析失败'); }
  if (!addrs.length) throw new Error('图片域名解析失败');
  for (const a of addrs) if (isBlockedIp(a.address)) throw new Error('不允许访问内网地址');
  return u;
}

/* 文本响应也卡体积：图片有 2MB 上限，文本同样不该整包读进内存 */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
async function readTextCapped(res, limit) {
  const lim = limit > 0 ? limit : MAX_TEXT_BYTES;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    return t.length > lim ? t.slice(0, lim) : t;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let out = '', size = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    size += step.value ? step.value.length : 0;
    out += dec.decode(step.value, { stream: true });
    if (size > lim) { try { await reader.cancel(); } catch (e) {} break; }
  }
  return out + dec.decode();
}

async function fetchText(url, headers) {
  /* 后台任务不能无限挂着：网络半死不活时 20 秒就放弃，下次扫描再试 */
  const res = await fetch(url, {
    headers: Object.assign({}, HEADERS, headers || {}),
    redirect: 'follow',
    signal: AbortSignal.timeout(20000)
  });
  return { status: res.status, text: await readTextCapped(res) };
}

/* 取图：每一跳都重新校验地址（跳转也可能被引到内网），并卡住体积 */
async function fetchImage(url, extra) {
  let cur = String(url);
  for (let hop = 0; hop < 4; hop++) {
    const target = await assertPublicUrl(cur);
    const res = await fetch(target, {
      headers: Object.assign({}, HEADERS, extra || {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(30000)
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('HTTP ' + res.status);
      cur = new URL(loc, target).toString();
      continue;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_IMAGE_BYTES) throw new Error('图片太大（上限 2MB）');
    /* 边读边数：不信任 content-length，超大响应立刻掐掉，别整包读进内存 */
    const chunks = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.length;
      if (size > MAX_IMAGE_BYTES) { try { await reader.cancel(); } catch (e) {} throw new Error('图片太大（上限 2MB）'); }
      chunks.push(Buffer.from(step.value));
    }
    return { buf: Buffer.concat(chunks), type: res.headers.get('content-type') || '' };
  }
  throw new Error('图片地址跳转过多');
}

async function postJson(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: Object.assign({}, HEADERS, headers || {}),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
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

/* 网页搜索框用的 /revision/search：不用登录也不风控，一次就给十几张专辑，
   标题、封面、播放量都在响应里，比搜索引擎稳，也省掉逐张查详情的请求。 */
async function searchXm(query, page, rows) {
  /* 上游 page 从 1 开始，rows 是单页条数；不传就是老行为（第 1 页 10 条） */
  const pn = Math.max(0, Number(page) || 0) + 1;
  const rn = Math.max(10, Math.min(30, Number(rows) || 10));
  try {
    const r = await fetchText("https://www.ximalaya.com/revision/search?kw=" + encodeURIComponent(query) + "&page=" + pn + "&rows=" + rn + "&core=album", {
      "accept": "application/json",
      "referer": "https://www.ximalaya.com/"
    });
    const j = JSON.parse(r.text);
    const docs = (j && j.data && j.data.result && j.data.result.response && j.data.result.response.docs) || [];
    return docs.map(d => ({
      id: String(d.id),
      title: d.title || "",
      cover: absUrl(d.cover_path),
      playCount: d.play || 0
    }));
  } catch (e) { return []; }
}

/* 书名号、【】和竖线在站内搜索里是噪音，去掉后按整串、书名、分词各问一次 */
function queriesOf(dirName) {
  const plain = dirName.replace(/[【】《》""'']/g, "").replace(/[丨|｜]/g, " ").replace(/\s+/g, " ").trim();
  const out = [];
  const push = q => {
    q = String(q || "").trim();
    if (q.length >= 2 && !out.includes(q)) out.push(q);
  };
  push(plain);
  push(titleOf(dirName));
  push(plain.split(/[\s：:，,、·]+/).filter(s => s.length >= 2).join(" "));
  return out;
}

/* ── 主流程 ──
   root：音频目录；quiet 时不打日志（自动模式用）；legacy 关掉就跳过搜索引擎兜底 */
async function run(rootArg, options) {
  const opt = Object.assign({ force: false, only: '', delay: 1500, legacy: true, quiet: false }, options || {});
  const root = path.resolve(rootArg);
  const say = function () { if (!opt.quiet) console.log.apply(console, arguments); };
  if (!fs.existsSync(root)) { say('目录不存在：' + root); return { ok: 0, kept: 0, failed: 0, misses: ['目录不存在'] }; }

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

  say('共 ' + dirs.length + ' 个专辑目录，封面存到 ' + coverDir + '\n');

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
        const got = await fetchImage(url);
        const buf = got.buf;
        const ext = /png/i.test(got.type) ? ".png" : ".jpg";
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
        say("✓ 1.00  " + dirName.slice(0, 30) + "（manual.json 指定的图片）" + String.fromCharCode(10));
      } catch (e) {
        failed++;
        say("✗ " + dirName + " → 下载失败 " + e.message + String.fromCharCode(10));
      }
      continue;
    }

    let ids = manualVal && !/^https?:/.test(manualVal) ? [manualVal] : [];
    let cands = [];
    if (!ids.length) {
      for (const q of queriesOf(dirName)) {
        cands = cands.concat(await searchXm(q));
        cands = Array.from(new Map(cands.map(c => [c.id, c])).values());
        await sleep(600);
        if (cands.length >= MAX_CANDIDATES) break;
      }
    }
    if (!ids.length && !cands.length && opt.legacy) {
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

    /* manual.json 写死的 id 和搜索没结果时的兜底，才需要逐张查专辑详情 */
    for (const id of ids) {
      const info = await albumInfo(id);
      if (info && info.cover) cands.push(info);
      await sleep(300);
    }
    cands = cands.filter(c => c.cover);
    cands.forEach(c => { c.score = scoreOf(dirName, c.title); });
    cands.sort((a, b) => b.score - a.score || b.playCount - a.playCount);
    const best = cands[0];

    /* manual.json 里写死的 id 直接信，不再按相似度卡 */
    if (!best || (best.score < MIN_SCORE && !manual[dirName])) {
      failed++;
      misses.push(dirName + (best ? '  （最高 ' + best.score.toFixed(2) + '：' + best.title.slice(0, 40) + '）' : '  （没搜到候选）'));
      say('✗ ' + dirName + ' → ' + (best ? '未匹配 ' + best.score.toFixed(2) + ' ' + best.title.slice(0, 28) : '没有候选') + '\n');
      continue;
    }

    try {
      /* 原图常 1MB+，走 CDN 缩放参数拿 600×600，卡片和全屏播放页都够用。
         搜索结果里的封面自带 290 的缩放参数，先剥掉再统一换成 600。 */
      const clean = best.cover.replace(/!.*$/, '');
      const dl = /xmcdn\.com/.test(clean) ? clean + '!op_type=3&columns=600&rows=600' : clean;
      const got = await fetchImage(dl);
      const buf = got.buf;
      const ext = /png/i.test(got.type) ? '.png' : '.jpg';
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
      say('✓ ' + best.score.toFixed(2) + '  ' + dirName.slice(0, 30) + '\n     ' + best.title.slice(0, 46) + '\n');
    } catch (e) {
      failed++;
      misses.push(dirName + '  （下载失败：' + e.message + '）');
      say('✗ ' + dirName + ' → 下载失败 ' + e.message + '\n');
    }
  }

  await fsp.writeFile(mapFile, JSON.stringify(map, null, 2), 'utf8');

  say('完成：新增 ' + ok + '，已有 ' + kept + '，未匹配 ' + failed);
  if (misses.length) {
    say('\n需要人工确认的专辑：');
    misses.forEach(m => say('  - ' + m));
    say('\n确认后在 ' + path.join(coverDir, 'manual.json') + ' 里写上 {"目录名":"专辑id"}，重跑即可。');
  }
  return { ok: ok, kept: kept, failed: failed, misses: misses };
}

/* ── 给主进程/服务端用：自动补封面 ──────────────────────────
 * 同一个目录同时只跑一次；已经抓过的跳过，所以反复调用很便宜。 */
const running = new Map();

function auto(root) {
  const key = path.resolve(root);
  if (running.has(key)) return running.get(key);
  const job = run(key, { quiet: true, legacy: false })
    .catch(function () { return null; })
    .then(function (r) {
      running.delete(key);
      /* 自动模式没有输出，留一份最近一次的记录，抓失败时才知道是哪几张 */
      if (r) return writeRunLog(key, r).then(function () { return r; });
      return r;
    });
  running.set(key, job);
  return job;
}

/* 本地时间，和文件管理器里看到的一致（sv-SE 刚好是 2026-10-30 16:11:42 这种格式） */
function stamp() {
  try { return new Date().toLocaleString('sv-SE'); } catch (e) { return new Date().toISOString(); }
}

async function writeRunLog(root, r) {
  const file = path.join(root, COVER_DIR, 'last-run.log');
  const lines = [
    stamp() +
      '  新增 ' + r.ok + '，已有 ' + r.kept + '，未匹配 ' + r.failed
  ];
  r.misses.forEach(function (m) { lines.push('  - ' + m); });
  try { await fsp.writeFile(file, lines.join('\n') + '\n', 'utf8'); } catch (e) {}
}

/* 还有多少张专辑没封面：扫描完据此决定要不要起后台任务 */
async function pendingOf(root) {
  let map = {};
  try { map = JSON.parse(await fsp.readFile(path.join(root, COVER_DIR, 'covers.json'), 'utf8')) || {}; } catch (e) { map = {}; }
  let dirs = [];
  try {
    dirs = (await fsp.readdir(root, { withFileTypes: true }))
      .filter(d => d.isDirectory() && !/^[._]/.test(d.name))
      .map(d => d.name);
  } catch (e) { return 0; }
  return dirs.filter(function (n) {
    const m = map[n];
    return !m || !m.file || !fs.existsSync(path.join(root, COVER_DIR, m.file));
  }).length;
}

/* 命令行入口：保留 --root/--force/--only，方便单独验一个目录 */
function cli() {
  const opt = parseArgs(process.argv);
  const root = path.resolve(opt.root);
  if (!fs.existsSync(root)) { console.error('目录不存在：' + root); process.exit(1); }
  run(root, opt).catch(function (e) { console.error(e); process.exit(1); });
}

/* ── 给网页手动编辑封面用（不再自动拉取，改由用户点「保存」才落盘） ── */

/* 文件系统错误翻成能照着做的中文。
   界面 / 服务端日志原本只有一句「保存失败」，EACCES 这种必须点名目录和当前用户，
   否则用户只能猜是网络问题还是程序问题。 */
function fsErrorText(err, dir) {
  const code = (err && err.code) || '';
  let who = '';
  try { who = (os.userInfo() && os.userInfo().username) || ''; } catch (e) {}
  if (code === 'EACCES' || code === 'EPERM') {
    return '没有权限写入 ' + dir + '（' + code + (who ? '，当前用户 ' + who : '') + '）。'
      + '常见原因是这个目录之前用 sudo 跑过程序、归了 root：'
      + '执行 sudo chown -R ' + (who || '$(whoami)') + ' "' + dir + '" 后重试';
  }
  if (code === 'EROFS') return '磁盘是只读的，写不了封面（EROFS）：' + dir;
  if (code === 'ENOSPC') return '磁盘空间不足，写不了封面（ENOSPC）';
  if (code === 'ENOENT') return '封面目录不存在或已被移走（ENOENT）：' + dir;
  return (err && err.message) || String(err || '未知错误');
}

async function readMap(coverDir) {
  const mapFile = path.join(coverDir, 'covers.json');
  let txt;
  try { txt = await fsp.readFile(mapFile, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return {};     /* 还没有索引：正常，从空开始 */
    /* 存在却读不出来（EACCES 等）不能当空 map：下一次写入会把整个封面索引覆盖掉 */
    throw new Error(fsErrorText(e, coverDir));
  }
  try { return JSON.parse(txt) || {}; } catch (e) { return {}; }
}
async function writeMap(coverDir, map) {
  try {
    await fsp.writeFile(path.join(coverDir, 'covers.json'), JSON.stringify(map, null, 2), 'utf8');
  } catch (e) {
    throw new Error(fsErrorText(e, coverDir));
  }
}

/* 手动保存一张封面：opt 里给 dataUrl（上传）或 url（自动获取到的候选），其余字段原样记进 covers.json */
async function saveCoverForDir(root, dirName, opt) {
  const coverDir = path.join(path.resolve(root), COVER_DIR);
  try { await fsp.mkdir(coverDir, { recursive: true }); }
  catch (e) { throw new Error(fsErrorText(e, coverDir)); }
  /* 先探一次写权限：等写到图片才失败的话，用户只能看到一句 EACCES，不知道是目录权限问题 */
  try { await fsp.access(coverDir, fs.constants.W_OK); }
  catch (e) { throw new Error(fsErrorText(e, coverDir)); }
  const map = await readMap(coverDir);
  let buf, ext;
  if (opt.dataUrl) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(String(opt.dataUrl));
    if (!m) throw new Error('无效的图片数据');
    /* 先按 base64 长度粗筛（省得解一份几十 MB 的串），解码后再按真实字节数卡一遍 */
    if (m[2].length > MAX_IMAGE_BYTES * 1.4) throw new Error('图片太大（上限 2MB）');
    buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片太大（上限 2MB）');
    ext = /png/i.test(m[1]) ? '.png' : /webp/i.test(m[1]) ? '.webp' : '.jpg';
  } else if (opt.url) {
    let dl = String(opt.url);
    /* 喜马拉雅 CDN 换成 600×600；百度图片保持原地址，下载时带 Referer */
    if (/xmcdn\.com/.test(dl)) dl = dl.replace(/!.*$/, '') + '!op_type=3&columns=600&rows=600';
    const isBaidu = /baidu\.com|bdimg\.com|bdstatic\.com|bcebos\.com/.test(dl);
    const got = await fetchImage(dl, isBaidu ? { referer: 'https://image.baidu.com/' } : null);
    buf = got.buf;
    ext = /png/i.test(got.type) ? '.png' : '.jpg';
  } else {
    throw new Error('没有图片来源');
  }
  /* 文件名带上图片内容指纹：换图时 URL 会跟着变，浏览器才不会继续用旧缓存。
     （之前固定用 sha1(dirName)，同一张专辑第二次换图 URL 不变，界面就一直是旧图） */
  const stamp = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
  /* 只接受纯文件名；调用方给的 file 带路径就直接丢掉，改用内容哈希命名（防路径穿越写盘） */
  const file = safeCoverName(opt.file) || (crypto.createHash('sha1').update(dirName).digest('hex').slice(0, 16) + '-' + stamp + ext);
  /* 换图后旧文件还在 covers.json 里就清掉，免得留孤儿文件；旧值同样要过滤，别被历史脏数据带着越界删除 */
  const old = map[dirName];
  const oldFile = safeCoverName(old && old.file);
  if (oldFile && oldFile !== file) {
    try { await fsp.unlink(path.join(coverDir, oldFile)); } catch (e) {}
  }
  const target = path.join(coverDir, file);
  try {
    /* 同名文件可能属于别的用户或带只读属性：目录可写时先删掉再写，比直接覆盖稳妥 */
    try { await fsp.unlink(target); } catch (e) {}
    await fsp.writeFile(target, buf);
  } catch (e) {
    throw new Error(fsErrorText(e, coverDir));
  }
  map[dirName] = {
    file: file,
    title: opt.title || dirName,
    albumId: opt.albumId || '',
    score: opt.source === 'xmly' ? 0.99 : 1,
    at: new Date().toISOString().slice(0, 10),
    source: opt.source || 'user'
  };
  await writeMap(coverDir, map);
  return map[dirName];
}

/* 删掉某专辑封面：covers.json 条目 + 图片文件一起清 */
async function removeCover(root, dirName) {
  const coverDir = path.join(path.resolve(root), COVER_DIR);
  let map = {};
  try { map = JSON.parse(await fsp.readFile(path.join(coverDir, 'covers.json'), 'utf8')) || {}; } catch (e) {}
  const entry = map[dirName];
  /* 索引里的 file 也要过滤：即使历史上被写入过带路径的值，也不能让它越界删文件 */
  const entryFile = safeCoverName(entry && entry.file);
  if (entryFile) { try { await fsp.unlink(path.join(coverDir, entryFile)); } catch (e) {} }
  delete map[dirName];
  await writeMap(coverDir, map);
}

/* 按标题去喜马拉雅搜几张候选封面（封面的勾选在网页里做，这里只返回可预览的 URL） */
/* 极客时间：/serv/v3/search 不用登录，返回课程 + 封面；技术课程优先用它 */
async function searchGeekbang(query, maxN) {
  const n = maxN || 4;
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const r = await postJson('https://time.geekbang.org/serv/v3/search',
      { keyword: q, page: 0, size: Math.min(Math.max(n * 3, 12), 40) },
      {
        'content-type': 'application/json',
        'accept': 'application/json, text/plain, */*',
        'referer': 'https://time.geekbang.org/',
        'origin': 'https://time.geekbang.org'
      });
    if (r.status !== 200) { console.warn('[cover] 极客时间返回 HTTP ' + r.status); return []; }
    let j = null;
    try { j = JSON.parse(r.text); } catch (e) { return []; }
    if (!j || j.code !== 0) return [];
    const list = (j.data && j.data.list) || [];
    const cands = [];
    for (const x of list) {
      if (!x || x.item_type !== 'product') continue;
      const p = x.product || {};
      if (!p.cover || !p.id) continue;
      const title = String(p.title || '').replace(/<[^>]+>/g, '').trim();
      const score = scoreOf(q, title);
      if (score < MIN_SCORE) continue;
      cands.push({ id: String(p.id), title: title, url: p.cover, score: +score.toFixed(3), source: 'geekbang' });
    }
    cands.sort((a, b) => b.score - a.score);
    return cands.slice(0, n);
  } catch (e) { console.warn('[cover] 极客时间请求失败：' + e.message); return []; }
}

/* 百度图片：没有官方 API，抓搜索页背后的 acjson；只在喜马拉雅没命中时兜底 */
async function searchBaidu(query, maxN, page) {
  const n = maxN || 4;
  const q = String(query || '').trim();
  if (!q) return [];
  /* 百度图片按 pn 偏移翻页，一页 30 条；rn 是这一页要几条 */
  const pn = Math.max(0, Number(page) || 0) * 30;
  const api = 'https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ct=201326592&is=&fp=result'
    + '&word=' + encodeURIComponent(q) + '&pn=' + pn + '&rn=' + Math.max(n * 3, 12);
  try {
    const r = await fetchText(api, {
      'accept': 'application/json, text/plain, */*',
      'referer': 'https://image.baidu.com/search/index?tn=baiduimage&word=' + encodeURIComponent(q)
    });
    if (r.status !== 200) { console.warn('[cover] 百度返回 HTTP ' + r.status); return []; }
    let j = null;
    try { j = JSON.parse(r.text); } catch (e) { console.warn('[cover] 百度返回不是 JSON（可能被反爬拦了）'); return []; }
    const docs = (j && j.data) || [];
    const out = [];
    for (let i = 0; i < docs.length && out.length < n; i++) {
      const d = docs[i];
      if (!d) continue;
      /* 百度偶尔给 http:// 的图，统一升到 https，否则 fm:// 安全上下文里会被当混合内容拦掉 */
      const url = String(d.middleURL || d.thumbURL || d.hoverURL || '').replace(/^http:\/\//, 'https://');
      if (!url) continue;
      const title = String(d.fromPageTitleEnc || d.di || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      /* id 带上页码，翻页时不会和前几页撞 id */
      out.push({ id: 'bd' + pn + '-' + i, title: title || q, url: url, source: 'baidu' });
    }
    return out;
  } catch (e) { console.warn('[cover] 百度请求失败：' + e.message); return []; }
}

/* 由「seed + 图片地址」算一个稳定的伪随机权重（FNV-1a）：
   同一个 seed 结果可复现，换个 seed 档内顺序就变，「换一换」才有意义 */
function noiseOf(key, seed) {
  let h = ((seed >>> 0) ^ 2166136261) >>> 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h / 4294967296;
}

/* 分页切片：seed=0 严格按相似度；seed 非 0 先把相似度按 0.1 分档、档内按 seed 打散，
   这样「换一换」能换出新面孔，又不会把明显不相关的图顶到高分结果前面 */
function slicePage(list, page, limit, seed) {
  const arr = list.slice();
  const bucket = function (c) { return Math.round((Number(c.score) || 0) * 10); };
  const byPlay = function (a, b) { return (b.playCount || 0) - (a.playCount || 0); };
  if (seed) {
    const key = function (c) { return c.url || c.id || ''; };
    arr.sort(function (a, b) {
      return bucket(b) - bucket(a) || noiseOf(key(a), seed) - noiseOf(key(b), seed);
    });
  } else {
    arr.sort(function (a, b) { return (Number(b.score) || 0) - (Number(a.score) || 0) || byPlay(a, b); });
  }
  const start = page * limit;
  return arr.slice(start, start + limit);
}

/* 候选池：极客时间 + 喜马拉雅合并排序，凑不满一屏再用百度图片补足。
   opts = { page, limit, seed }：page 从 0 开始；seed 非 0 用于「换一换」打散同分档 */
async function searchCandidates(title, maxN, opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const limit = Math.max(1, Math.min(24, Number(o.limit || maxN) || 4));
  const page = Math.max(0, Math.min(20, Number(o.page) || 0));
  const seed = Math.abs(Number(o.seed) || 0) >>> 0;
  const want = (page + 1) * limit;
  const kw = String(title || '').trim();

  const pool = [];
  const seen = new Set();
  const push = function (c) {
    if (!c || !c.url) return;
    const key = c.source + ':' + (c.id || c.url);
    if (seen.has(key)) return;
    seen.add(key);
    pool.push(c);
  };

  /* 1. 极客时间：技术课程在这儿最准 */
  (await searchGeekbang(kw, want)).forEach(push);
  /* 2. 喜马拉雅：结果更宽，靠 score 过滤噪音；query 变体按 seed 轮换起点，换一换能换词 */
  const queries = queriesOf(kw);
  if (seed && queries.length > 1) {
    const k = seed % queries.length;
    queries.push.apply(queries, queries.splice(0, k));
  }
  let xmRaw = [];
  for (let i = 0; i < queries.length; i++) {
    xmRaw = xmRaw.concat(await searchXm(queries[i], page, Math.max(limit * 2, 10)));
    xmRaw = Array.from(new Map(xmRaw.map(c => [c.id, c])).values());
    if (xmRaw.length >= want * 2) break;
    if (i < queries.length - 1) await sleep(300);
  }
  /* 站内搜索很宽松：不做相似度过滤的话，搜「全链路压测」也会返回「毛选」之类的热门专辑 */
  xmRaw.filter(c => c.cover).forEach(function (c) {
    const score = scoreOf(kw, c.title);
    if (score < MIN_SCORE) return;
    const clean = String(c.cover).replace(/!.*$/, '');
    const url = /xmcdn\.com/.test(clean) ? clean + '!op_type=3&columns=600&rows=600' : clean;
    push({ id: c.id, title: c.title, url: url, score: +score.toFixed(3), playCount: c.playCount || 0, source: 'xmly' });
  });

  /* 3. 池还不够翻到这一页 → 用百度图片把池撑大。百度是纯图搜词，score 记 0，
     排序上永远排在专辑结果后面，只在数量不够时补位 */
  if (pool.length < want) {
    const bd = await searchBaidu(kw, Math.max(limit * 2, 12), 0);
    bd.forEach(push);
  }
  return slicePage(pool, page, limit, seed);
}

module.exports = { run: run, auto: auto, pendingOf: pendingOf, titleOf: titleOf, cli: cli,
  searchCandidates: searchCandidates, saveCoverForDir: saveCoverForDir, removeCover: removeCover,
  /* 给单测用：地址拦截规则、体积上限、文件名过滤 */
  isBlockedIp: isBlockedIp, assertPublicUrl: assertPublicUrl, MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
  safeCoverName: safeCoverName, fsErrorText: fsErrorText };

if (require.main === module) cli();
