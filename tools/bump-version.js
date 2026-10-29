#!/usr/bin/env node
/**
 * 打包前把 package.json 的小版本号(patch) +1，并同步 package-lock.json。
 * 例：1.0.0 -> 1.0.1
 *
 * 由 npm 的 pre 钩子自动调用（predist / predist:mac / prepack:mac），
 * 也可以手动跑：npm run bump
 *
 * 想临时不涨版本打包：SKIP_BUMP=1 npm run dist
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');

if (process.env.SKIP_BUMP === '1') {
  console.log('[version] SKIP_BUMP=1，跳过版本号自增');
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(pkg.version || ''));
if (!m) {
  console.error('[version] package.json 里的 version 不是 x.y.z 格式：' + pkg.version);
  process.exit(1);
}

const next = m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1);
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.version = next;
    if (lock.packages && lock.packages['']) lock.packages[''].version = next;
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  } catch (e) {
    console.warn('[version] package-lock.json 更新失败（不影响打包）：' + e.message);
  }
}

console.log('[version] ' + m[0] + ' -> ' + next);
