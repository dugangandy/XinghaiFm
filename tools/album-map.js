/* ── album-map.js · 扫描结果 → 曲目 / 专辑 id 映射（纯函数） ─────────
 * 只给一次性重算脚本用：不碰数据库、不读盘、不发请求。
 *
 * 【同步来源】下面三段必须与前端逐字同构，任何一边改了都要三处一起改：
 *   js/util.js:102-111      U.hash / U.uid（FNV-1a 32 位 + base36）
 *   js/library.js:182-266   VOLUME_RE / CHAPTER_RE / ALBUM_TAG_RE / groupFiles
 *   js/library.js:343-346   albumIdOf（__root__ 用目录名，否则用分组 key）
 *
 * 算错 albumId 不会报错，只会把时长写到另一张专辑上，所以
 * test/recalc-album-top.test.js 用 flat / cat / auto 三档样例守住这层。
 */
'use strict';

/* 与 U.hash / U.uid 同构：FNV-1a 32 位，输出 base36 */
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function uid(prefix, s) { return prefix + hash(String(s)).toString(36); }

/* 分卷 / 容器目录名：这些层不单独成专辑，音频要往上收一层 */
const VOLUME_RE = /^(cd|disc|disk|dvd|part|pt|vol|volume)\s*[-_.]?\s*\d{1,3}$|^\d{1,3}$|^(上|中|下)(卷|册|部|篇|集)?$|^第\s*[0-9一二三四五六七八九十百]{1,3}\s*[部卷册集辑篇章]|^(mp3|m4a|m4b|flac|wav|aac|ogg|audio|voice|music|media|音频|录音|音轨|声音|md|html|pdf|reader|assets|doc|docs|文档|资料|图片|image|images|covers?)$/i;
/* 章节目录名：01-开篇词 (1讲)、第03章、08【战略篇】第8章：说服高手进阶技巧 */
const CHAPTER_RE = /^\d{1,3}\s*(?:[-_.、:：)）\]】]|[【\[（(《]|[讲章节课回])|[(（]\s*\d+\s*讲\s*[)）]|第\s*[0-9一二三四五六七八九十百]{1,3}\s*[讲章节回课]/i;
/* 编号 + 方括号标签 + 横线：07 [易经] -易经的奥秘（系列专辑，不能并进作者合集） */
const ALBUM_TAG_RE = /^\d{1,3}\s*[\[【（(][^\]】）)篇章节讲课回]{1,12}[\]】）)]\s*[-–—－~～]\s*\S/;

/* 与 js/library.js 的 groupFiles 同构。files 只要求 [{rel}]，多余字段忽略。
   返回 [{ key, dirName, cat, files }]。 */
function groupFiles(files, mode) {
  const m = (mode === true || mode === 'cat') ? 'cat' : (mode === 'auto' ? 'auto' : 'flat');
  const groups = new Map();
  const list = files || [];

  if (m === 'auto') {
    /* 哪些目录里直接躺着音频。''（根目录）也算一个 */
    const hasAudio = new Set();
    list.forEach(function (f) {
      const segs = String((f && f.rel) || '').split('/');
      segs.pop();
      hasAudio.add(segs.join('/'));
    });
    list.forEach(function (f) {
      const segs = String((f && f.rel) || '').split('/');
      segs.pop();
      let key, dirName = '', cat = null;
      if (!segs.length) {
        key = '__root__';
      } else {
        /* 从一级往下找第一个「直接含音频」的目录，只在前三层里找 */
        const top = Math.min(segs.length, 3);
        let at = top - 1;
        for (let i = 1; i <= top; i++) {
          if (hasAudio.has(segs.slice(0, i).join('/'))) { at = i - 1; break; }
        }
        /* 落点本身是 CD1 / 上卷 / MP3 / 01-开篇词 这类容器或章节：往上收一层 */
        while (at > 0 && !ALBUM_TAG_RE.test(segs[at]) &&
            (VOLUME_RE.test(segs[at]) || CHAPTER_RE.test(segs[at]))) at--;
        key = segs.slice(0, at + 1).join('/');
        dirName = segs[at];
        /* 专辑不是一级目录时，一级目录就是分类 */
        if (at > 0) cat = segs[0];
      }
      const hit = groups.get(key);
      if (hit) hit.files.push(f);
      else groups.set(key, { key, dirName, cat, files: [f] });
    });
    return Array.from(groups.values());
  }

  const dirGroup = m === 'cat';
  list.forEach(function (f) {
    const segs = String((f && f.rel) || '').split('/');
    let key, dirName = '', cat = null;
    if (!dirGroup) {
      key = segs.length > 1 ? segs[0] : '__root__';
    } else if (segs.length <= 1) {
      key = '__root__';
    } else if (segs.length === 2) {
      key = segs[0];
      cat = segs[0];
      dirName = segs[0];
    } else {
      key = segs[0] + '/' + segs[1];
      cat = segs[0];
      dirName = segs[1];
    }
    const hit = groups.get(key);
    if (hit) hit.files.push(f);
    else groups.set(key, { key, dirName, cat, files: [f] });
  });
  return Array.from(groups.values());
}

/* 与 js/library.js:343-346 的 albumIdOf 同构 */
function albumIdOf(group, rootName) {
  const dirName = group.dirName || (group.key === '__root__' ? (rootName || '未分类单集') : group.key);
  return uid('a', group.key === '__root__' ? dirName : group.key);
}

/* 扫描结果 → Map<trackId, { albumId, title, key }>。
   scanData 结构同 /api/scan 响应或 settings 里的 scan:<lib> 缓存：
     { root?, rootName?, files: [{ rel }] }
   mode 可取 'flat' | 'cat' | 'auto'（也兼容老布尔 false/true）。
   title 只是目录名兜底；调用方应优先用 album_meta / album_listen 里的标题快照。 */
function buildTrackAlbumMap(scanData, mode, rootName) {
  const files = (scanData && scanData.files) || [];
  const root = rootName || (scanData && scanData.rootName) || '';
  const out = new Map();
  groupFiles(files, mode).forEach(function (g) {
    const albumId = albumIdOf(g, root);
    const title = g.dirName || (g.key === '__root__' ? root : '');
    g.files.forEach(function (f) {
      const rel = String((f && f.rel) || '');
      if (!rel) return;
      out.set(uid('t', rel), { albumId: albumId, title: title, key: g.key });
    });
  });
  return out;
}

module.exports = {
  hash, uid,
  VOLUME_RE, CHAPTER_RE, ALBUM_TAG_RE,
  groupFiles, albumIdOf, buildTrackAlbumMap
};
