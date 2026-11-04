/* ── 生成拼音静态表 ────────────────────────────────────────
 * 只在开发期跑：node tools/gen-pinyin.js（或 npm run gen:pinyin）
 * 产物 js/pinyin-data.js 提交进仓库，运行时零依赖、断网可用。
 *
 * 格式：window.FM.pinyinData = "三:san;体:ti;长:chang,zhang;..."
 *   - 键是单个汉字，冒号后是最多两个读音（去声调、ü 统一写成 v）
 *   - 分号分隔；运行时首次查询才解析成 Map（避免拖慢启动）
 * 只覆盖 CJK 基本区（U+4E00–U+9FFF），生僻扩展区和标点跳过。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pinyin } = require('pinyin-pro');
const DICT_VERSION = require('pinyin-pro/package.json').version;

const START = 0x4e00;
const END = 0x9fff;
const MAX_READINGS = 2;

function readingsOf(ch) {
  let list = [];
  try {
    list = pinyin(ch, { toneType: 'none', multiple: true, type: 'array' }) || [];
  } catch (e) {
    return [];
  }
  const out = [];
  list.forEach(function (r) {
    const s = String(r || '').toLowerCase().replace(/ü/g, 'v');
    if (!s || !/^[a-z]+$/.test(s) || s === ch) return;
    if (out.indexOf(s) < 0) out.push(s);
  });
  return out.slice(0, MAX_READINGS);
}

const parts = [];
for (let cp = START; cp <= END; cp++) {
  const ch = String.fromCodePoint(cp);
  const rs = readingsOf(ch);
  if (!rs.length) continue;
  parts.push(ch + ':' + rs.join(','));
}

const data = parts.join(';');
const head = '/* 生成物，勿手改。改读音规则请改 tools/gen-pinyin.js 后重新生成。\n' +
  ' * 字典：pinyin-pro ' + DICT_VERSION + '；CJK 基本区 U+4E00–U+9FFF，每字最多 2 个读音。 */\n' +
  'window.FM = window.FM || {};\n' +
  '(function (FM) {\n' +
  "  FM.pinyinData = '";

/* 单引号是拼接边界，数据里只有汉字/字母/冒号/逗号/分号，不会撞上 */
if (data.indexOf("'") >= 0) throw new Error('拼音表里出现了单引号，需要转义规则');

const tail = "';\n})(window.FM);\n";
const file = path.join(__dirname, '..', 'js', 'pinyin-data.js');
fs.writeFileSync(file, head + data + tail, 'utf8');
const kb = (Buffer.byteLength(head + data + tail, 'utf8') / 1024).toFixed(1);
console.log('[gen-pinyin] 字数 ' + parts.length + '，文件 ' + kb + ' KB → js/pinyin-data.js');
