#!/usr/bin/env node
/* ── cover-fetch.js · 抓取专辑封面（帆书官方 → 豆瓣 → 喜马拉雅） ──────
 *
 * 目录名通常就是专辑/书名，拿它去比对、下载封面，存到 <库根>/.fm-covers/，
 * 并写一份 covers.json 给播放器用。
 *
 * 取图顺序（与 fm-covers 技能一致）：
 *   1. 帆书官方 book/v100/listClassifyBook：按年份拉书单，书名相似度 ≥ 0.86 直接采信；
 *      0.60–0.86 但目录日期 MMDD 与官方 publishTime 对得上也认（如 0424 那批目录）。
 *      官方偶尔只给 168×224 的小图，量到短边不足 300 就换豆瓣。
 *   2. 豆瓣 subject_suggest：/s/public/ 换 /l/public/ 拿大图，相似度 ≥ 0.86。
 *   3. 喜马拉雅 /revision/search?core=album：按标题挑最像的，换 600×600。
 *      （唯一会继续用搜索引擎兜底的来源，--legacy 可关）
 *
 * 库布局：根目录下直接放专辑，或者「2020年/专辑」两层。根目录看到 YYYY年
 * 就自动下钻一层，索引键仍是专辑目录名（不含年份）。
 *
 * 平时不用手动跑：主进程扫描资源库后发现有新专辑，会自动调 run() 在后台补封面。
 * 命令行仍然可用，方便单独验一个目录：
 *   node cover-fetch.js                      # 默认抓 E:\迅雷下载\output
 *   node cover-fetch.js --root "D:/有声书"    # 换目录
 *   node cover-fetch.js --force              # 重抓（默认跳过已抓过的）
 *   node cover-fetch.js --only 三体           # 只抓名字含关键字的专辑
 *   （tools/fetch-covers.js 是同一个入口，老命令照样能用）
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

/* 帆书官方书目 / 豆瓣：阈值照搬 fm-covers 的实测值 */
const FANSHU_LIST_API = 'https://gateway-api.dushu365.com/fs-webtool/web/book/v100/listClassifyBook';
const FANSHU_REFERER = 'https://www.fanshu.cn/';
const FANSHU_SCORE = 0.86;   // 书名归一化后几乎一致，直接采信
const FANSHU_LOOSE = 0.60;   // 名字差一点时，还要发布日期对得上
const DOUBAN_SCORE = 0.86;
const MIN_EDGE = 300;        // 封面短边低于这个值算低清（官方 168×224 缩略图就是这么筛掉的）

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

/* 樊登/帆书的目录名常带日期前缀（0106《战安庆》），比对书名前先剥掉 */
function baseName(name) {
  const raw = String(name || '').trim();
  let s = raw.replace(/^\d{4}/, '').replace(/^[\s._-]+/, '');
  const m = s.match(/^《([^》]+)》/);
  s = (m ? m[1] + s.slice(m[0].length) : s).trim();
  return s || raw;      /* 整个名字就是四位数字（如《1984》）时别剥成空 */
}

/* 书名相似度：比 scoreOf 多认「整段包含」和「目录名覆盖官方标题」两种情况。
   官方标题常带一堆卖点尾巴，F1 被稀释后 0.86 的线会误杀。 */
function bookScore(name, title) {
  const a = norm(baseName(name));
  const b = norm(title);
  if (!a || !b) return 0;
  if (a === b) return 1;
  let s = dice(a, b);
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) s = Math.max(s, 0.9);
  const A = bigrams(a), B = bigrams(b);
  let hit = 0;
  A.forEach(function (x) { if (B.has(x)) hit++; });
  if (A.size >= 6 && hit / A.size >= 0.9) s = Math.max(s, 0.9 + 0.1 * (hit / B.size));
  return Math.min(1, s);
}

/* 目录日期（MMDD）与官方 publishTime 的月日：名不对但日期对得上，多半是同一本 */
function mmddOf(name) {
  const m = /^(\d{2})(\d{2})/.exec(String(name || '').trim());
  if (!m) return '';
  const mm = +m[1], dd = +m[2];
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 ? m[1] + m[2] : '';
}
function publishMd(ms) {
  const t = Number(ms);
  if (!t) return '';
  const d = new Date(t + 8 * 3600 * 1000);   /* 官方时间戳是 UTC，按北京时间算月日 */
  return String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
}

/* ── 网络 ── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 单张封面的大小上限：正常 600×600 也就几十 KB，超过 2MB 基本是打歪了 */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/* 只读文件头拿尺寸（jpg/png/webp）。帆书官方有 168×224 的缩略图，
   下载后按短边卡 300 才算高清；认不出的格式返回 null，当合格处理。 */
function imageSize(buf) {
  if (!buf || buf.length < 30) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return null;
      /* SOF0-SOF15 里带宽高（C4 DHT / C8 JPG / CC DAC 除外） */
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
    return null;
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

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

/* ── 帆书官方书目 ────────────────────────────────────────────────
 * 站点没有搜索接口，只能按年份把官方书目拉下来本地比对（fm-covers 的做法）。
 * 书单接口一页 30 条，不足 30 即末页；businessType:1 是「樊登讲书」。
 * 书目按年缓存到系统临时目录，24 小时过期，免得每次搜索都重拉十几页。 */
const FANSHU_CACHE = path.join(os.tmpdir(), 'fm-covers-cache', 'fanshu-catalog.json');
const FANSHU_TTL = 24 * 3600 * 1000;
let fanshuCache = null;
let fanshuLoading = null;

async function loadFanshuCache() {
  if (fanshuCache) return fanshuCache;
  if (!fanshuLoading) {
    fanshuLoading = (async function () {
      let data = null;
      try { data = JSON.parse(await fsp.readFile(FANSHU_CACHE, 'utf8')); } catch (e) {}
      fanshuCache = data && data.years ? data : { years: {} };
      return fanshuCache;
    })();
  }
  return fanshuLoading;
}

function saveFanshuCache() {
  try {
    fsp.mkdir(path.dirname(FANSHU_CACHE), { recursive: true })
      .then(function () { return fsp.writeFile(FANSHU_CACHE, JSON.stringify(fanshuCache)); })
      .catch(function () {});
  } catch (e) {}
}

function defaultFanshuYears() {
  const now = new Date().getFullYear();
  const out = [];
  for (let y = 2013; y <= now; y++) out.push(y);   /* 樊登讲书从 2013 年开始 */
  return out;
}

async function fetchFanshuYear(year) {
  const out = [];
  for (let page = 1; page <= 40; page++) {
    const r = await postJson(FANSHU_LIST_API, {
      businessType: 1, classifyIds: [], publishYear: year, sortType: 1, pageNo: page, pageSize: '30'
    }, {
      'content-type': 'application/json',
      'accept': 'application/json, text/plain, */*',
      'referer': FANSHU_REFERER,
      'origin': 'https://www.fanshu.cn'
    });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const j = JSON.parse(r.text);
    const rows = (j && j.data) || [];
    if (!Array.isArray(rows) || !rows.length) break;
    rows.forEach(function (b) {
      if (!b || !b.bookId || !b.coverImg) return;
      out.push({
        id: String(b.bookId),
        title: String(b.title || ''),
        cover: absUrl(b.coverImg),
        publishTime: Number(b.publishTime) || 0
      });
    });
    if (rows.length < 30) break;
  }
  return out;
}

/* years 传空就拉默认年份段；返回这些年里所有书（带 id/title/cover/publishTime） */
async function fanshuBooks(years) {
  const cache = await loadFanshuCache();
  const list = years && years.length
    ? Array.from(new Set(years.map(Number).filter(Boolean)))
    : defaultFanshuYears();
  const need = list.filter(function (y) {
    const e = cache.years[y];
    return !e || !Array.isArray(e.books) || Date.now() - (Number(e.at) || 0) > FANSHU_TTL;
  });
  /* 4 路并发：一次起十几个年份请求容易被网关卡住 */
  for (let i = 0; i < need.length; i += 4) {
    await Promise.all(need.slice(i, i + 4).map(async function (y) {
      try {
        cache.years[y] = { at: Date.now(), books: await fetchFanshuYear(y) };
      } catch (e) {
        /* 记下失败时间，24 小时内不再重试；已经有旧书目就继续用旧的 */
        if (!cache.years[y]) cache.years[y] = { at: Date.now(), books: [] };
      }
    }));
  }
  if (need.length) saveFanshuCache();
  const out = [];
  list.forEach(function (y) {
    const e = cache.years[y];
    if (e && Array.isArray(e.books)) e.books.forEach(function (b) { out.push(b); });
  });
  return out;
}

/* 官方匹配：分数够高直接采信；差一点就靠发布日期（MMDD）兜 */
function matchOfficial(name, books) {
  const ranked = books
    .filter(function (b) { return b && b.cover; })
    .map(function (b) { return { book: b, score: bookScore(name, b.title) }; })
    .sort(function (x, y) { return y.score - x.score; });
  if (!ranked.length) return null;
  if (ranked[0].score >= FANSHU_SCORE) return ranked[0];
  const md = mmddOf(name);
  if (md) {
    const hit = ranked.find(function (x) {
      return x.score >= FANSHU_LOOSE && publishMd(x.book.publishTime) === md;
    });
    if (hit) return hit;
  }
  return null;
}

/* 批量流程用的官方候选对象：字段与下面 doubanFor / 喜马拉雅候选保持一致 */
function officialFor(name, books) {
  const hit = matchOfficial(name, books);
  if (!hit) return null;
  return {
    source: 'fanshu', url: hit.book.cover, title: hit.book.title,
    id: hit.book.id, score: hit.score, referer: FANSHU_REFERER
  };
}

/* 豆瓣：书的封面最干净；/s/ 或 /m/ 缩略图统一换 /l/ 大图 */
async function searchDouban(query, maxN) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const r = await fetchText('https://book.douban.com/j/subject_suggest?q=' + encodeURIComponent(q), {
      'accept': 'application/json, text/plain, */*',
      'referer': 'https://book.douban.com/'
    });
    if (r.status !== 200) return [];
    const j = JSON.parse(r.text);
    if (!Array.isArray(j)) return [];
    const n = Math.max(1, Number(maxN) || 8);
    return j.filter(function (x) { return x && x.type === 'b' && x.pic; })
      .map(function (x) {
        return {
          id: String(x.id || ''),
          title: String(x.title || ''),
          url: String(x.pic).replace(/\/(?:s|m)\/public\//, '/l/public/'),
          score: +bookScore(q, x.title).toFixed(3),
          source: 'douban'
        };
      })
      .filter(function (c) { return c.score >= MIN_SCORE; })
      .sort(function (x, y) { return y.score - x.score; })
      .slice(0, n);
  } catch (e) { return []; }
}

async function doubanFor(name) {
  const q = baseName(name) || titleOf(name);
  const best = (await searchDouban(q, 5))[0];
  if (!best || best.score < DOUBAN_SCORE) return null;
  return {
    source: 'douban', url: best.url, title: best.title,
    id: best.id, score: best.score, referer: 'https://book.douban.com/'
  };
}

/* 网页里搜候选：官方书目按书名排序，返回可预览的 URL（勾选在界面做） */
async function searchFanshu(query, maxN, years) {
  const q = String(query || '').trim();
  if (!q) return [];
  let books = [];
  try { books = await fanshuBooks(years); } catch (e) { return []; }
  const n = Math.max(1, Number(maxN) || 8);
  return books
    .map(function (b) { return { b: b, s: bookScore(q, b.title) }; })
    .filter(function (x) { return x.s >= MIN_SCORE; })
    .sort(function (x, y) { return y.s - x.s || (y.b.publishTime || 0) - (x.b.publishTime || 0); })
    .slice(0, n)
    .map(function (x) {
      return { id: x.b.id, title: x.b.title, url: x.b.cover, score: +x.s.toFixed(3), source: 'fanshu' };
    });
}

/* 列出待处理的专辑目录。
   樊登/帆书这类库是「2020年/专辑」两层：根目录看到 YYYY年 就只下钻年份目录，
   索引键仍是专辑目录名（不含年份），和 fm-covers 的约定一致。 */
async function albumDirs(root, only) {
  const rows = await fsp.readdir(root, { withFileTypes: true });
  const subs = rows.filter(function (d) { return d.isDirectory() && !/^[._]/.test(d.name); })
    .map(function (d) { return d.name; });
  const years = subs.filter(function (n) { return /^\d{4}年$/.test(n); }).sort();
  const out = [];
  if (!years.length) {
    subs.sort().forEach(function (n) {
      if (!only || n.indexOf(only) >= 0) out.push({ name: n, dir: path.join(root, n), year: 0 });
    });
    return out;
  }
  for (const y of years) {
    const ydir = path.join(root, y);
    let list = [];
    try { list = await fsp.readdir(ydir, { withFileTypes: true }); } catch (e) { continue; }
    list.filter(function (d) { return d.isDirectory() && !/^[._]/.test(d.name); })
      .map(function (d) { return d.name; }).sort()
      .forEach(function (n) {
        if (only && n.indexOf(only) < 0) return;
        out.push({ name: n, dir: path.join(ydir, n), year: Number(y.slice(0, 4)) });
      });
  }
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

  const albums = await albumDirs(root, opt.only);
  say('共 ' + albums.length + ' 个专辑目录，封面存到 ' + coverDir + '\n');

  /* 帆书官方书目：目录里带年份就只拉那几年；平铺目录按默认年份段拉一次。
     拉不到（网络/接口变更）就返回空数组，后面照常走豆瓣和喜马拉雅。 */
  const years = Array.from(new Set(albums.map(a => a.year).filter(Boolean)));
  let books = [];
  try { books = await fanshuBooks(years); } catch (e) { books = []; }
  if (books.length) say('帆书官方书目 ' + books.length + ' 条\n');

  let ok = 0, kept = 0, failed = 0;
  const misses = [];

  for (const item of albums) {
    const dirName = item.name;
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
        await mergeMapEntry(coverDir, dirName, {
          file: file,
          title: dirName,
          albumId: "",
          score: 1,
          at: new Date().toISOString().slice(0, 10),
          source: manualVal
        });
        ok++;
        say("✓ 1.00  " + dirName.slice(0, 30) + "（manual.json 指定的图片）" + String.fromCharCode(10));
      } catch (e) {
        failed++;
        say("✗ " + dirName + " → 下载失败 " + e.message + String.fromCharCode(10));
      }
      continue;
    }

    /* 1. 帆书官方（目录年份已知时只比那一年，平铺目录比全部年份） */
    let picked = officialFor(dirName, books);

    /* 2. 豆瓣 */
    if (!picked) picked = await doubanFor(dirName);

    /* 3. 喜马拉雅：manual.json 写死的 id 或站内搜索 */
    let ids = manualVal && !/^https?:/.test(manualVal) ? [manualVal] : [];
    let cands = [];
    if (!picked && !ids.length) {
      for (const q of queriesOf(dirName)) {
        cands = cands.concat(await searchXm(q));
        cands = Array.from(new Map(cands.map(c => [c.id, c])).values());
        await sleep(600);
        if (cands.length >= MAX_CANDIDATES) break;
      }
    }
    if (!picked && !ids.length && !cands.length && opt.legacy) {
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

    /* 只有走到喜马拉雅这一步才逐张查详情；官方/豆瓣命中就不再打请求 */
    if (!picked) {
      for (const id of ids) {
        const info = await albumInfo(id);
        if (info && info.cover) cands.push(info);
        await sleep(300);
      }
      cands = cands.filter(c => c.cover);
      cands.forEach(c => { c.score = scoreOf(dirName, c.title); });
      cands.sort((a, b) => b.score - a.score || b.playCount - a.playCount);
      const best = cands[0];
      if (best) picked = { source: 'xmly', url: best.cover, title: best.title, id: best.id, score: best.score, referer: null };
    }

    /* manual.json 里写死的 id 直接信，不再按相似度卡 */
    if (!picked || (picked.score < MIN_SCORE && !manual[dirName])) {
      failed++;
      misses.push(dirName + (picked ? '  （最高 ' + picked.score.toFixed(2) + '：' + picked.title.slice(0, 40) + '）' : '  （没搜到候选）'));
      say('✗ ' + dirName + ' → ' + (picked ? '未匹配 ' + picked.score.toFixed(2) + ' ' + picked.title.slice(0, 28) : '没有候选') + '\n');
      continue;
    }

    /* 原图常 1MB+，喜马拉雅 CDN 走缩放参数拿 600×600；其它源原样下。
       帆书官方常给 168×224 的小图，量到短边不足 300 就换豆瓣再试一次。 */
    const fetchSized = async function (url, referer) {
      const clean = String(url).replace(/!.*$/, '');
      const dl = /xmcdn\.com/.test(clean) ? clean + '!op_type=3&columns=600&rows=600' : clean;
      const got = await fetchImage(dl, referer ? { referer: referer } : null);
      const dim = imageSize(got.buf);
      if (dim && Math.min(dim.w, dim.h) < MIN_EDGE) throw new Error('分辨率过低 ' + dim.w + '×' + dim.h);
      return got;
    };

    let saveBuf = null, saveType = '', lastErr = '';
    try {
      const got = await fetchSized(picked.url, picked.referer);
      saveBuf = got.buf;
      saveType = got.type;
    } catch (e) {
      lastErr = e.message;
      if (picked.source === 'fanshu') {
        const alt = await doubanFor(dirName);
        if (alt) {
          try {
            const got = await fetchSized(alt.url, alt.referer);
            saveBuf = got.buf;
            saveType = got.type;
            picked = alt;
          } catch (e2) { lastErr = e2.message; }
        }
      }
    }
    if (!saveBuf) {
      failed++;
      misses.push(dirName + '  （下载失败：' + lastErr + '）');
      say('✗ ' + dirName + ' → 下载失败 ' + lastErr + '\n');
      continue;
    }

    try {
      const ext = /png/i.test(saveType) ? '.png' : '.jpg';
      const file = crypto.createHash('sha1').update(dirName).digest('hex').slice(0, 16) + ext;
      await fsp.writeFile(path.join(coverDir, file), saveBuf);
      /* 抓一张存一张（中途打断也不丢）：只合并这一条，别把开跑时读的整份 map 回写，
         否则会抹掉这期间用户在界面上手动补的封面 */
      await mergeMapEntry(coverDir, dirName, {
        file: file,
        title: picked.title,
        albumId: picked.id,
        score: +picked.score.toFixed(3),
        at: new Date().toISOString().slice(0, 10),
        source: picked.source
      });
      ok++;
      say('✓ ' + picked.score.toFixed(2) + ' [' + picked.source + '] ' + dirName.slice(0, 26) + '\n     ' + picked.title.slice(0, 46) + '\n');
    } catch (e) {
      failed++;
      misses.push(dirName + '  （写入失败：' + e.message + '）');
      say('✗ ' + dirName + ' → 写入失败 ' + e.message + '\n');
    }
  }

  /* 索引已经随每张封面逐条合并过，末尾不再整份回写（会覆盖并发写入的条目） */
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
  try { dirs = await albumDirs(root, ''); } catch (e) { return 0; }
  return dirs.filter(function (item) {
    const m = map[item.name];
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

/* covers.json 是整份覆盖，必须按封面目录串行「读 → 改 → 写」。
   一键抓取是 3 路并发，两个请求同时读到旧索引、各自回写，
   后写的那个会把先写那条抹掉 —— 界面显示「已自动替换」，刷新后封面又空了。 */
const mapLocks = new Map();
function withMapLock(coverDir, fn) {
  const key = path.resolve(coverDir);
  const prev = mapLocks.get(key) || Promise.resolve();
  const job = prev.then(fn, fn);                 /* 上一棒失败不影响这一棒 */
  const tail = job.then(function () {}, function () {});
  mapLocks.set(key, tail);
  tail.then(function () { if (mapLocks.get(key) === tail) mapLocks.delete(key); });
  return job;
}

/* 只往索引里塞一条：读最新的盘上内容再写，别用调用方手里那份可能过期的 map */
function mergeMapEntry(coverDir, dirName, entry) {
  return withMapLock(coverDir, async function () {
    const map = await readMap(coverDir);
    map[dirName] = entry;
    await writeMap(coverDir, map);
    return entry;
  });
}

/* 手动保存一张封面：opt 里给 dataUrl（上传）或 url（自动获取到的候选），其余字段原样记进 covers.json */
async function saveCoverForDir(root, dirName, opt) {
  /* Alist 库不写网盘：调用方传 coverDir 指到服务端本地数据目录。
     本地库 / CLI 批量流程不传，行为不变。 */
  const coverDir = opt && opt.coverDir ? path.resolve(opt.coverDir) : path.join(path.resolve(root), COVER_DIR);
  try { await fsp.mkdir(coverDir, { recursive: true }); }
  catch (e) { throw new Error(fsErrorText(e, coverDir)); }
  /* 先探一次写权限：等写到图片才失败的话，用户只能看到一句 EACCES，不知道是目录权限问题 */
  try { await fsp.access(coverDir, fs.constants.W_OK); }
  catch (e) { throw new Error(fsErrorText(e, coverDir)); }
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
    /* 喜马拉雅 CDN 换成 600×600；其它源保持原地址 */
    if (/xmcdn\.com/.test(dl)) dl = dl.replace(/!.*$/, '') + '!op_type=3&columns=600&rows=600';
    /* 帆书/豆瓣/百度的图床都看 Referer，不带会被 403 */
    const referer = /dushu365\.com|fanshu\.cn/.test(dl) ? 'https://www.fanshu.cn/'
      : /doubanio\.com|douban\.com/.test(dl) ? 'https://book.douban.com/'
      : /baidu\.com|bdimg\.com|bdstatic\.com|bcebos\.com/.test(dl) ? 'https://image.baidu.com/'
      : null;
    const got = await fetchImage(dl, referer ? { referer: referer } : null);
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
  const target = path.join(coverDir, file);
  /* 读索引 → 清旧图 → 写新图 → 回写索引，整段串行：
     批量抓取时这里会被并发调用，各自拿着旧的 map 回写就会互相抹掉条目 */
  return withMapLock(coverDir, async function () {
    const map = await readMap(coverDir);
    /* 换图后旧文件还在 covers.json 里就清掉，免得留孤儿文件；旧值同样要过滤，别被历史脏数据带着越界删除 */
    const old = map[dirName];
    const oldFile = safeCoverName(old && old.file);
    if (oldFile && oldFile !== file) {
      try { await fsp.unlink(path.join(coverDir, oldFile)); } catch (e) {}
    }
    try {
      /* 同名文件可能属于别的用户或带只读属性：目录可写时先删掉再写，比直接覆盖稳妥 */
      try { await fsp.unlink(target); } catch (e) {}
      await fsp.writeFile(target, buf);
    } catch (e) {
      throw new Error(fsErrorText(e, coverDir));
    }
    const entry = {
      file: file,
      title: opt.title || dirName,
      albumId: opt.albumId || '',
      score: opt.source === 'xmly' ? 0.99 : 1,
      at: new Date().toISOString().slice(0, 10),
      source: opt.source || 'user'
    };
    map[dirName] = entry;
    await writeMap(coverDir, map);
    return entry;
  });
}

/* 删掉某专辑封面：covers.json 条目 + 图片文件一起清。
   Alist 库传 opt.coverDir 指到服务端本地数据目录，别去碰虚拟网盘路径。 */
async function removeCover(root, dirName, opt) {
  const coverDir = (opt && opt.coverDir)
    ? path.resolve(opt.coverDir)
    : path.join(path.resolve(root), COVER_DIR);
  /* 和 saveCoverForDir 共用一把锁：删除时的读改写同样不能被并发写入覆盖 */
  return withMapLock(coverDir, async function () {
    let map = {};
    try { map = JSON.parse(await fsp.readFile(path.join(coverDir, 'covers.json'), 'utf8')) || {}; } catch (e) {}
    const entry = map[dirName];
    /* 索引里的 file 也要过滤：即使历史上被写入过带路径的值，也不能让它越界删文件 */
    const entryFile = safeCoverName(entry && entry.file);
    if (entryFile) { try { await fsp.unlink(path.join(coverDir, entryFile)); } catch (e) {} }
    delete map[dirName];
    await writeMap(coverDir, map);
  });
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

  /* 1. 帆书官方（书封首选）+ 极客时间（技术课程最准），并行拉。
     豆瓣不放进候选池：它要求 Referer 是 book.douban.com，浏览器预览会被 418 拦掉；
     批量抓取走服务端下载（带 Referer）时仍然会用豆瓣兜底。 */
  const [fanshu, geek] = await Promise.all([
    searchFanshu(kw, want).catch(function () { return []; }),
    searchGeekbang(kw, want).catch(function () { return []; })
  ]);
  fanshu.forEach(push);
  geek.forEach(push);
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
  /* 给单测用：地址拦截规则、体积上限、文件名过滤、帆书书名匹配 */
  isBlockedIp: isBlockedIp, assertPublicUrl: assertPublicUrl, MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
  safeCoverName: safeCoverName, fsErrorText: fsErrorText,
  baseName: baseName, bookScore: bookScore, mmddOf: mmddOf, publishMd: publishMd,
  imageSize: imageSize, matchOfficial: matchOfficial, albumDirs: albumDirs };

if (require.main === module) cli();
