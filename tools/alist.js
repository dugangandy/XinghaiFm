/* ── alist.js · OpenList / AList REST API 客户端 ─────────────────────
 *
 *  P1 骨架：只做「元数据」侧，不读媒体字节、不落库、不写网盘文件。
 *  实测契约（见 doc/alist-integration-design.md §1.4）：
 *    POST /api/auth/login   {username,password} → data.token（裸值放 Authorization，48h）
 *    POST /api/fs/list      {path,password,page,per_page,refresh} → data.content[]/total
 *    POST /api/fs/get       {path,password} → data.raw_url（带 sign 的临时直链）
 *    /d/<path> 不是直链入口（返回前端 HTML），不要用它取流。
 *
 *  所有请求走 requestJson：先校验目标为公网地址（SSRF），再把解析出的 IP
 *  固定用于连接；UTF-8 JSON body；不跟随跳转；有超时与响应体上限。
 */
'use strict';
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const net = require('node:net');
const crypto = require('node:crypto');
const DB = require('../db');
const { isBlockedIp } = require('../cover-fetch');

const DEFAULT_CDN = ['*.drive.quark.cn'];
const DEFAULT_TIMEOUT = 8000;
const LIST_TIMEOUT = 30000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 100;
const TOKEN_TTL = (48 * 3600 - 300) * 1000;   // OpenList 默认 48h，提前 5 分钟过期
const TOKEN_CACHE = new Map();
/* 扫描一个库要逐层列目录，每层都 lookup 一次太浪费；短 TTL 缓存已校验过的解析结果，
   过期后重新解析并重新过滤内网地址（仍保留 DNS pin 语义） */
const DNS_TTL = 60000;
const DNS_CACHE = new Map();   // host -> { addrs, exp }

function alistError(code, message, status) {
  const e = new Error(code + ': ' + message);
  e.code = code;
  e.status = status || 502;
  return e;
}

/* 曲目标识 / 网盘内相对路径：保留中文原文，严禁 .. / 空段 / 绝对路径 */
function normalizeRel(rel) {
  const s = String(rel == null ? '' : rel).trim();
  if (!s || s[0] === '/' || s.indexOf('\\') >= 0 || s.indexOf('\0') >= 0) {
    throw alistError('BAD_PATH', '非法相对路径', 400);
  }
  const parts = s.split('/');
  if (parts.some(function (x) { return !x || x === '.' || x === '..'; })) {
    throw alistError('BAD_PATH', '路径含空段或穿越', 400);
  }
  return s;
}

/* URL 路径逐段编码（JSON body 里仍用 Unicode 原文，这里只给拼 URL 用） */
function encodeAlistPath(p) {
  return String(p || '').split('/').map(function (seg) { return encodeURIComponent(seg); }).join('/');
}

function joinPath(base, name) {
  const b = String(base || '/').replace(/\/+$/, '');
  return (b || '') + '/' + String(name || '').replace(/^\/+/, '');
}

/* 公网地址校验 + DNS pin：返回 {url, address, family}，避免 DNS rebinding */
async function resolvePublicTarget(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch (e) { throw alistError('BAD_HOST', '上游地址无效', 400); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw alistError('BAD_HOST', '只支持 http/https 上游地址', 400);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/(^localhost$)|(\.local$)|(\.internal$)|(\.localhost$)/i.test(host)) {
    throw alistError('BAD_HOST', '不允许访问内网地址', 400);
  }
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw alistError('BAD_HOST', '不允许访问内网地址', 400);
    return { url: u, address: host, family: net.isIPv4(host) ? 4 : 6 };
  }
  let addrs = [];
  const ck = host.toLowerCase();
  const cached = DNS_CACHE.get(ck);
  if (cached && cached.exp > Date.now()) {
    addrs = cached.addrs;
  } else {
    try { addrs = await dns.lookup(host, { all: true }); } catch (e) {
      throw alistError('BAD_HOST', '上游域名解析失败', 400);
    }
    if (!addrs.length) throw alistError('BAD_HOST', '上游域名解析失败', 400);
    if (DNS_CACHE.size > 256) DNS_CACHE.clear();
    DNS_CACHE.set(ck, { addrs: addrs, exp: Date.now() + DNS_TTL });
  }
  /* 缓存命中也要再过滤一遍：多一层防线，成本可以忽略 */
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw alistError('BAD_HOST', '不允许访问内网地址', 400);
  }
  return { url: u, address: addrs[0].address, family: addrs[0].family };
}

function mapUpstream(status, body) {
  const msg = String((body && body.message) || '');
  if (status === 401 || status === 403) return alistError('ALIST_AUTH_FAILED', msg || '凭据失效', 502);
  if (status === 404) return alistError('NOT_FOUND', msg || '文件不存在', 404);
  if (status === 429) return alistError('RATE_LIMIT', msg || '上游限流', 429);
  if (status >= 500 && /storage not found|path not found/i.test(msg)) {
    return alistError('BAD_ENCODING', msg || '路径编码异常', 400);
  }
  if (status >= 500) return alistError('ALIST_UNREACHABLE', msg || '上游错误', 502);
  return alistError('ALIST_UNREACHABLE', msg || '上游返回 ' + status, 502);
}

/* 统一的 JSON 出站请求：不跟随 3xx、不缓冲媒体、不记录 token/sign */
function requestJson(cfg, apiPath, payload, opts) {
  const o = opts || {};
  const base = String((cfg && cfg.host) || '').replace(/\/+$/, '');
  if (!base) return Promise.reject(alistError('BAD_HOST', '缺少上游地址', 400));
  const resolver = o.resolve || resolvePublicTarget;
  return resolver(base + apiPath).then(function (target) {
    return new Promise(function (resolve, reject) {
      const u = target.url;
      const secure = u.protocol === 'https:';
      const headers = { host: u.host, accept: 'application/json' };
      let data = null;
      if (payload !== null && payload !== undefined) {
        data = Buffer.from(JSON.stringify(payload), 'utf8');
        headers['content-type'] = 'application/json; charset=utf-8';
        headers['content-length'] = String(data.length);
      }
      if (o.token) headers.authorization = String(o.token);
      if (o.headers) Object.assign(headers, o.headers);
      const reqOpts = {
        host: target.address,
        port: Number(u.port) || (secure ? 443 : 80),
        path: u.pathname + u.search,
        method: o.method || (data ? 'POST' : 'GET'),
        headers: headers,
        timeout: o.timeout || DEFAULT_TIMEOUT
      };
      /* 固定 IP 连公网时，TLS SNI / HTTP Host 仍要用原域名 */
      if (secure && !net.isIP(u.hostname)) reqOpts.servername = u.hostname;
      const mod = secure ? https : http;
      let settled = false;
      function fail(e) { if (!settled) { settled = true; reject(e); } }
      const req = mod.request(reqOpts, function (res) {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return fail(alistError('ALIST_UNEXPECTED_REDIRECT', '上游意外跳转', 502));
        }
        const chunks = [];
        let size = 0;
        const limit = o.maxBytes || MAX_JSON_BYTES;
        res.on('data', function (c) {
          size += c.length;
          if (size > limit) { req.destroy(); return fail(alistError('ALIST_BAD_RESPONSE', '响应过大', 502)); }
          chunks.push(c);
        });
        res.on('end', function () {
          if (settled) return;
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch (e) { return fail(alistError('ALIST_BAD_RESPONSE', '响应不是 JSON', 502)); }
          if (status >= 400) return fail(mapUpstream(status, parsed));
          settled = true;
          resolve(parsed);
        });
      });
      req.on('timeout', function () { req.destroy(alistError('ALIST_TIMEOUT', '上游超时', 504)); });
      req.on('error', function (e) {
        if (e && e.code === 'ALIST_TIMEOUT') fail(e);
        else fail(alistError('ALIST_UNREACHABLE', (e && e.message) || '网络错误', 502));
      });
      if (data) req.write(data);
      req.end();
    });
  });
}

/* Range 探测：只读响应头，不下载媒体内容 */
function requestRange(rawUrl, opts) {
  const o = opts || {};
  const resolver = o.resolve || resolvePublicTarget;
  return resolver(rawUrl).then(function (target) {
    return new Promise(function (resolve, reject) {
      const u = target.url;
      const secure = u.protocol === 'https:';
      const reqOpts = {
        host: target.address,
        port: Number(u.port) || (secure ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: { host: u.host, range: 'bytes=0-0' },
        timeout: o.timeout || DEFAULT_TIMEOUT
      };
      if (secure && !net.isIP(u.hostname)) reqOpts.servername = u.hostname;
      const req = (secure ? https : http).request(reqOpts, function (res) {
        resolve({
          status: res.statusCode || 0,
          contentRange: String(res.headers['content-range'] || ''),
          acceptRanges: String(res.headers['accept-ranges'] || ''),
          acao: String(res.headers['access-control-allow-origin'] || '')
        });
        res.resume();
      });
      req.on('timeout', function () { req.destroy(alistError('ALIST_TIMEOUT', 'Range 探测超时', 504)); });
      req.on('error', function (e) {
        reject(e && e.code === 'ALIST_TIMEOUT' ? e : alistError('ALIST_UNREACHABLE', (e && e.message) || '网络错误', 502));
      });
      req.end();
    });
  });
}

function tokenKey(cfg) { return String(cfg.host || '') + '|' + String(cfg.username || '') + '|' + (cfg.token ? 't' : 'p'); }
/* 传 host 只清这个上游的 token：改一个库不该把其它库的会话一起踢掉 */
function clearTokenCache(host) {
  const h = String(host || '').replace(/\/+$/, '');
  if (!h) { TOKEN_CACHE.clear(); return; }
  const pre = h + '|';
  for (const k of Array.from(TOKEN_CACHE.keys())) if (k.indexOf(pre) === 0) TOKEN_CACHE.delete(k);
}

/* token 模式优先（不托管密码）；密码模式登录换 48h token，只存内存 */
function login(cfg, opts) {
  if (cfg.token) return Promise.resolve({ token: cfg.token, fromToken: true });
  const key = tokenKey(cfg);
  const hit = TOKEN_CACHE.get(key);
  if (hit && hit.exp > Date.now()) return Promise.resolve({ token: hit.token, fromToken: false });
  const body = { username: String(cfg.username || ''), password: String(cfg.password || '') };
  if (cfg.otpCode) body.otp_code = String(cfg.otpCode);
  return requestJson(cfg, '/api/auth/login', body, opts).then(function (r) {
    const data = (r && r.data) || {};
    if (!data.token) {
      if (/otp|two.?factor|验证码/i.test(String(r && r.message))) {
        throw alistError('TWO_FACTOR_REQUIRED', '上游开启二步验证，请改用 token 模式', 400);
      }
      throw alistError('INVALID_CRED', String((r && r.message) || '登录失败'), 400);
    }
    TOKEN_CACHE.set(key, { token: data.token, exp: Date.now() + TOKEN_TTL });
    return { token: data.token, fromToken: false };
  });
}

/* 401 时清缓存重新登录一次，再不行就抛给上层 */
function withToken(cfg, opts, fn) {
  return login(cfg, opts).then(function (auth) {
    return fn(auth.token).catch(function (e) {
      if (e && e.code === 'ALIST_AUTH_FAILED' && !cfg.token) {
        TOKEN_CACHE.delete(tokenKey(cfg));
        return login(cfg, opts).then(function (again) { return fn(again.token); });
      }
      throw e;
    });
  });
}

function listDir(cfg, token, dirPath, opts) {
  const o = opts || {};
  const items = [];
  let provider = '', total = 0, write = false, pages = 0;
  function page(n) {
    const body = {
      path: String(dirPath || '/'),
      password: String(cfg.dirPassword || ''),
      page: n,
      per_page: 200,
      refresh: !!o.refresh
    };
    return requestJson(cfg, '/api/fs/list', body,
      Object.assign({}, o, { token: token, timeout: o.timeout || LIST_TIMEOUT })).then(function (r) {
      const d = (r && r.data) || {};
      const chunk = Array.isArray(d.content) ? d.content : [];
      chunk.forEach(function (x) { items.push(x); });
      provider = d.provider || provider;
      total = Number(d.total) || total;
      write = !!d.write;
      pages = n;
      if (!chunk.length || (total && items.length >= total) || n >= MAX_PAGES) return null;
      return page(n + 1);
    });
  }
  return page(1).then(function () { return { items: items, total: total, provider: provider, write: write, pages: pages }; });
}

function getFile(cfg, token, filePath, opts) {
  const o = opts || {};
  return requestJson(cfg, '/api/fs/get',
    { path: String(filePath || ''), password: String(cfg.dirPassword || '') },
    Object.assign({}, o, { token: token })).then(function (r) {
    const d = (r && r.data) || {};
    const raw = String(d.raw_url || '');
    if (!raw) throw alistError('NO_DIRECT_LINK', '上游未返回 raw_url', 502);
    const loc = safeDirectLink(raw);
    const patterns = cfg.cdn || DEFAULT_CDN;
    if (!isAllowedRawHost(loc, cfg.host, patterns)) {
      throw alistError('BAD_RAW_HOST', 'raw_url 域名不在白名单', 502);
    }
    return { rawUrl: loc, provider: d.provider || '', size: Number(d.size) || 0, data: d };
  });
}

/* 上游 raw_url 偶尔带未编码的中文路径：res.setHeader('location') 遇到非 latin1
   会直接抛 ERR_INVALID_CHAR。统一走一次 URL 规范化（已编码的 %xx 不会被重复编码）。 */
function safeDirectLink(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (e) {
    throw alistError('NO_DIRECT_LINK', '直链地址无效', 502);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw alistError('NO_DIRECT_LINK', '直链只支持 http/https', 502);
  }
  return u.toString();
}

function isAllowedRawHost(rawUrl, cfgHost, patterns) {
  let u, c;
  try { u = new URL(String(rawUrl)); c = new URL(String(cfgHost)); }
  catch (e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.host === c.host) return true;                 // OpenList 自身（Local 驱动 /p/…?sign=）
  const host = u.hostname.toLowerCase();
  return (patterns || []).some(function (pat) {
    const p = String(pat).toLowerCase();
    if (p.indexOf('*.') === 0) {
      const suffix = p.slice(2);
      return host.endsWith('.' + suffix);
    }
    return host === p;
  });
}

function suggestCdn(rawUrl, cfgHost) {
  let u, c;
  try { u = new URL(String(rawUrl)); c = new URL(String(cfgHost)); }
  catch (e) { return []; }
  if (u.host === c.host) return [];
  const host = u.hostname.toLowerCase();
  /* 已知 CDN 只建议对应的通配域；其它驱动给精确 host。
     不按「末三段」猜二级域——那等于建议管理员放行整个域。 */
  for (const pat of DEFAULT_CDN) {
    const suffix = pat.indexOf('*.') === 0 ? pat.slice(2) : pat;
    if (host === suffix || host.endsWith('.' + suffix)) return [pat];
  }
  return [host];
}

/* 连接测试：只读，不落库、不写网盘。 Range 探测失败不阻断。 */
function probe(cfg, opts) {
  const o = opts || {};
  const base = String(cfg.base || '/');
  let publicInfo = {}, auth = null, dir = null, storages = [], rawInfo = null, rangeOk = false, corsOk = false;
  return (o.resolve || resolvePublicTarget)(String(cfg.host || ''))
    .then(function () {
      return requestJson(cfg, '/api/public/settings', null,
        Object.assign({}, o, { method: 'GET' })).then(function (r) { publicInfo = (r && r.data) || {}; })
        .catch(function () { publicInfo = {}; });
    })
    .then(function () { return withToken(cfg, o, function (token) {
      auth = { token: token };
      return listDir(cfg, token, base, o);
    }); })
    .then(function (d) {
      dir = d;
      return requestJson(cfg, '/api/admin/storage/list', null,
        Object.assign({}, o, { method: 'GET', token: auth.token })).then(function (r) {
        storages = (((r && r.data) || {}).content || []).map(function (x) {
          return { mount: x.mount_path || '', driver: x.driver || '' };
        });
      }).catch(function () { storages = []; });
    })
    .then(function () {
      const first = (dir.items || []).find(function (x) { return !x.is_dir; });
      if (!first) return null;
      return getFile(cfg, auth.token, joinPath(base, first.name), o).then(function (r) { rawInfo = r; })
        .catch(function () { rawInfo = null; });
    })
    .then(function () {
      if (!rawInfo || o.probeRange === false) return null;
      return requestRange(rawInfo.rawUrl, o).then(function (r) {
        /* 200 = 服务器忽略 Range 直接回全量，不能算「支持拖动」 */
        rangeOk = r.status === 206 && /^bytes\b/i.test(String(r.contentRange || ''));
        corsOk = !!r.acao;
      }).catch(function () { rangeOk = false; corsOk = false; });
    })
    .then(function () {
      return {
        ok: true,
        serverTitle: String(publicInfo.site_title || ''),
        version: String(publicInfo.version || ''),
        basePath: base,
        hasToken: !!auth,
        storages: storages,
        sample: (dir.items || []).slice(0, 10).map(function (x) {
          return { name: String(x.name || ''), isDir: !!x.is_dir, size: Number(x.size) || 0 };
        }),
        sampleCount: (dir.items || []).length,
        cdnSuggest: rawInfo ? suggestCdn(rawInfo.rawUrl, cfg.host) : [],
        rangeOk: rangeOk,
        corsOk: corsOk
      };
    });
}

/* ── 连接配置：全部放 settings 键值表，凭据用 settings.secret 派生密钥 AES-256-GCM 加密 ──
   P2 只落存储层（扫描要用）；HTTP 配置接口与 UI 属于 P4。 */
function cfgPrefix(id) { return 'alist:' + String(id || '') + ':'; }
function cipherKey(secret) { return crypto.createHash('sha256').update(String(secret || ''), 'utf8').digest(); }

function encryptCred(secret, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cipherKey(secret), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj || {}), 'utf8'), c.final()]);
  return JSON.stringify({
    v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64')
  });
}
function decryptCred(secret, text) {
  try {
    const j = JSON.parse(String(text || ''));
    if (j.v !== 1) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', cipherKey(secret), Buffer.from(j.iv, 'base64'));
    d.setAuthTag(Buffer.from(j.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(j.data, 'base64')), d.final()]).toString('utf8'));
  } catch (e) { return null; }
}

function saveConfig(db, id, cfg) {
  const p = cfgPrefix(id);
  const c = cfg || {};
  DB.setSetting(db, p + 'host', String(c.host || '').trim().replace(/\/+$/, ''));
  DB.setSetting(db, p + 'user', String(c.username || ''));
  DB.setSetting(db, p + 'base', String(c.base || '/'));
  DB.setSetting(db, p + 'cdn', JSON.stringify(c.cdn || DEFAULT_CDN));
  /* 只加密敏感字段：密码 / token / 目录密码；host/user/base/cdn 可明文便于排查 */
  DB.setSetting(db, p + 'cred', encryptCred(DB.secret(db), {
    password: String(c.password || ''), token: String(c.token || ''), dirPassword: String(c.dirPassword || '')
  }));
}
function readConfig(db, id) {
  const p = cfgPrefix(id);
  const host = String(DB.getSetting(db, p + 'host', '') || '');
  const enc = String(DB.getSetting(db, p + 'cred', '') || '');
  if (!host || !enc) return null;
  const c = decryptCred(DB.secret(db), enc);
  if (!c) return null;
  let cdn = [];
  try { cdn = JSON.parse(String(DB.getSetting(db, p + 'cdn', '[]') || '[]')); } catch (e) { cdn = []; }
  return {
    host: host,
    username: String(DB.getSetting(db, p + 'user', '') || ''),
    password: String(c.password || ''),
    token: String(c.token || ''),
    dirPassword: String(c.dirPassword || ''),
    base: String(DB.getSetting(db, p + 'base', '/') || '/'),
    cdn: (cdn.length ? cdn : DEFAULT_CDN.slice())
  };
}
function deleteConfig(db, id) {
  const p = cfgPrefix(id);
  ['host', 'user', 'base', 'cdn', 'cred', 'status'].forEach(function (k) { DB.setSetting(db, p + k, ''); });
}

/* ── 网盘目录扫描：产出与本地 walkAndCache 同结构的 {rootName,root,scannedAt,files[]} ──
   files[] 每项 {rel,name,ext,size,mtime,depth}；rel 为相对 basePath 的 Unicode 路径，
   不带挂载点前缀（这样 js/library.js 的「目录即专辑」分组与本地库一致）。 */
function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i > 0 ? String(name).slice(i + 1).toLowerCase() : '';
}
function toMtime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : Math.round(v * 1000);
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : 0;
}

async function scanFolderAlist(lib, cfg, opts) {
  const o = opts || {};
  const root = String(lib.path || ('alist:' + lib.id));
  const base = String(cfg.base || lib.basePath || '/').replace(/\/+$/, '') || '/';
  const maxDepth = Number(o.maxDepth) || 6;
  const mediaExt = o.mediaExt || new Set(['mp3', 'mp4', 'm4a', 'flac', 'wav', 'ogg']);
  const skipDir = o.skipDir || /^[._]/;
  const listOpts = { resolve: o.resolve, timeout: o.timeout, refresh: false };
  const files = [];
  let dirs = 0;

  function relPrefix(dir) {
    const d = String(dir || '');
    if (d === base) return '';
    return d.slice(base.length).replace(/^\/+/, '');
  }
  async function walk(dir, depth, token) {
    /* 串行递归：网盘列目录比本地 readdir 慢得多，并发会打爆上游限流 */
    const r = await listDir(cfg, token, dir, listOpts);
    dirs++;
    if (dirs > 5000) throw alistError('ALIST_SCAN_TOO_BIG', '目录数量超过上限，请缩小 basePath', 502);
    for (const it of (r.items || [])) {
      const name = String((it && it.name) || '');
      if (!name) continue;
      if (it.is_dir) {
        if (skipDir.test(name) || depth >= maxDepth) continue;
        await walk(joinPath(dir, name), depth + 1, token);
        continue;
      }
      const ext = extOf(name);
      if (!mediaExt.has(ext)) continue;
      const pre = relPrefix(dir);
      files.push({
        rel: pre ? pre + '/' + name : name,
        name: name,
        ext: ext,
        size: Number(it.size) || 0,
        mtime: toMtime(it.modified),
        depth: depth
      });
    }
  }
  /* 任一层列目录失败都向上抛：调用方保留旧快照，不把「半份结果」写成新缓存 */
  await withToken(cfg, listOpts, function (token) { return walk(base, 1, token); });
  return {
    rootName: String(lib.name || '网盘库'),
    root: root,
    scannedAt: Date.now(),
    files: files,
    source: 'alist',
    dirs: dirs
  };
}

module.exports = {
  DEFAULT_CDN: DEFAULT_CDN,
  alistError: alistError,
  normalizeRel: normalizeRel,
  encodeAlistPath: encodeAlistPath,
  joinPath: joinPath,
  isBlockedIp: isBlockedIp,
  resolvePublicTarget: resolvePublicTarget,
  mapUpstream: mapUpstream,
  requestJson: requestJson,
  requestRange: requestRange,
  clearTokenCache: clearTokenCache,
  login: login,
  withToken: withToken,
  listDir: listDir,
  getFile: getFile,
  safeDirectLink: safeDirectLink,
  isAllowedRawHost: isAllowedRawHost,
  suggestCdn: suggestCdn,
  probe: probe,
  encryptCred: encryptCred,
  decryptCred: decryptCred,
  saveConfig: saveConfig,
  readConfig: readConfig,
  deleteConfig: deleteConfig,
  scanFolderAlist: scanFolderAlist
};
