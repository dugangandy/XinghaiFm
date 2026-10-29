#!/usr/bin/env node
/* 静音 node:sqlite 的 ExperimentalWarning（必须在 require db 之前） */
(function () {
  const orig = process.emitWarning;
  process.emitWarning = function (w, t) {
    const ty = typeof t === 'string' ? t : (t && t.type);
    if (ty === 'ExperimentalWarning' || /SQLite/i.test(String(w))) return;
    return orig.apply(process, arguments);
  };
})();
/* ── tunnel.js · 把本机播放器通过 SSH 反向隧道挂到服务器上 ──────────────
 *
 * 读同目录下的 .tunnel.json，然后：
 *   1. 起本地服务器（tools/serve.js，读 config.json 里的库列表）
 *   2. 用 ssh 先清掉服务器上僵死的旧端口（上次异常断开常会残留，导致新隧道静默失败）
 *   3. 起 ssh -N -R <remotePort>:127.0.0.1:<localPort> root@<host>
 *
 * 登录固定 root + 密钥（默认 ~/.ssh/id_rsa，可在 ssh.key 指定），BatchMode=yes，
 * 不会弹密码提示。访问要口令，口令存在 .auth.json 的 pbkdf2 哈希里。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const DB = require('../db');

const HERE = __dirname;
const ROOT = path.join(HERE, '..');
const CONF = path.join(ROOT, '.tunnel.json');
const SSH_USER = 'root';

/* fm.db 位置：与 serve.js / 桌面端一致 */
function desktopDataDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '星海FM');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', '星海FM');
  return path.join(home, '.config', '星海FM');
}
function dbFilePath() {
  if (process.env.FM_DATA_FILE) return path.resolve(process.env.FM_DATA_FILE);
  return path.join(desktopDataDir(), 'fm.db');
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!fs.existsSync(CONF)) {
  die([
    '缺少配置文件：' + CONF,
    '',
    '把 .tunnel.example.json 复制成 .tunnel.json，填上 ssh.host（要用另一份库列表时再填 configFile），再运行。'
  ].join(String.fromCharCode(10)));
}

let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONF, 'utf8')); }
catch (e) { die('配置文件不是合法 JSON：' + e.message); }

/* 库列表统一来自 config.json：默认桌面端那份，configFile 可指定另一份 */

const ssh = cfg.ssh || {};
if (!ssh.host) die('.tunnel.json 里缺 ssh.host');

/* 用户/密码现在存在 fm.db：没有用户就没法启动服务 */
(function checkUsers() {
  let n = 0;
  try {
    const db = DB.open(dbFilePath());
    DB.ensureSchema(db);
    n = DB.countUsers(db);
  } catch (e) {}
  if (!n) {
    die([
      '还没有任何用户，先跑一次：',
      '  node tools/init-db.js',
      '',
      '（用户名/密码存在 fm.db，不再用 .auth.json）'
    ].join(String.fromCharCode(10)));
  }
})();

const localPort = Number(cfg.localPort || 8080);
const remotePort = Number(cfg.remotePort || 8889);
const keyFile = ssh.key ? path.resolve(ssh.key) : '';

/* Windows 用 where，macOS / Linux 用 which */
function hasCommand(name) {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [name], { shell: true })
    : spawnSync('which', [name]);
  return probe.status === 0;
}
if (!hasCommand('ssh')) {
  die('找不到 ssh 命令。Windows 可在「设置 → 应用 → 可选功能」里安装 OpenSSH 客户端。');
}
if (keyFile && !fs.existsSync(keyFile)) die('ssh.key 指向的私钥不存在：' + keyFile);

const sshBase = [
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=8',
  '-p', String(ssh.port || 22)
];
if (keyFile) sshBase.push('-i', keyFile, '-o', 'IdentitiesOnly=yes');
const target = SSH_USER + '@' + ssh.host;

/* 1. 清掉远端僵死监听 */
console.log('清理服务器上残留的 ' + remotePort + ' 监听…');
const clean = spawnSync('ssh', sshBase.concat([
  target,
  'fuser -k ' + remotePort + '/tcp 2>/dev/null; echo cleaned'
]), { encoding: 'utf8' });
if (clean.status !== 0) {
  console.error('连不上服务器（ssh 退出码 ' + clean.status + '）：' + String(clean.stderr || '').trim());
  console.error('检查：密钥是否已装到 root 的 authorized_keys、ssh.host / ssh.port 是否正确。');
  process.exit(1);
}

/* 2. 本地服务 */
const serveArgs = [path.join(HERE, 'serve.js'), String(localPort), '--host', '127.0.0.1'];
if (cfg.configFile) serveArgs.push('--config', path.resolve(cfg.configFile));
/* 允许远程增删资源库是个敏感能力，必须在配置里显式打开 */
if (cfg.allowLibEdit) serveArgs.push('--allow-lib-edit');
const server = spawn(process.execPath, serveArgs, { stdio: 'inherit' });

/* 3. 反向隧道 */
const args = ['-N'].concat(sshBase.slice(0, sshBase.length), [
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-R', remotePort + ':127.0.0.1:' + localPort
]);
/* sshBase 里已经带了 -p 和 -i，这里只补目标 */
args.push(target);

/* 连续重连上限：.tunnel.json 的 maxRetries，0 = 不限；命令行 --max-retries N 可临时覆盖 */
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const rawMax = argValue('--max-retries') != null ? argValue('--max-retries') : cfg.maxRetries;
const MAX_RETRIES = Number.isFinite(Number(rawMax)) && Number(rawMax) >= 0 ? Math.floor(Number(rawMax)) : 10;

let tunnel = null;
let stopping = false;
let fails = 0;          // 连续断开次数（稳定 20 秒后清零）
let quickFails = 0;     // 连续「刚连上就断」的次数
let hinted = false;

function retryLabel(n) {
  return MAX_RETRIES > 0 ? ('第 ' + n + '/' + MAX_RETRIES + ' 次') : ('第 ' + n + ' 次（不限）');
}

function stop(code) {
  stopping = true;
  try { if (tunnel) tunnel.kill(); } catch (e) {}
  try { server.kill(); } catch (e) {}
  process.exit(code || 0);
}

/* 服务器上残留的 8889 监听会让新隧道静默失败，必要时再清一次 */
function cleanRemote() {
  const r = spawnSync('ssh', sshBase.concat([
    target,
    'fuser -k ' + remotePort + '/tcp 2>/dev/null; echo cleaned'
  ]), { encoding: 'utf8' });
  return r.status === 0;
}

function printHints() {
  console.log('  排查：');
  console.log('  1) 密钥是否已装到服务器：把 ' + (keyFile || path.join(os.homedir(), '.ssh', 'id_rsa.pub')) + ' 的内容追加到 /root/.ssh/authorized_keys');
  console.log('  2) sshd 是否允许 GatewayPorts clientspecified（否则 ' + remotePort + ' 只绑在服务器 127.0.0.1）');
  console.log('  3) 云安全组是否放行 ' + remotePort);
}

function connect() {
  if (stopping) return;
  const startedAt = Date.now();
  if (fails > 0) console.log('[tunnel] 重连' + retryLabel(fails) + '…');

  tunnel = spawn('ssh', args, { stdio: 'inherit' });

  /* 连上 20 秒没掉就算稳定，失败计数清零 */
  const wasRetry = fails > 0;
  const upTimer = setTimeout(function () {
    if (wasRetry) console.log('[tunnel] 连接稳定');
    fails = 0;
    quickFails = 0;
  }, 20000);

  tunnel.on('exit', function (code) {
    clearTimeout(upTimer);
    if (stopping) return;
    if (!code) { console.log('[tunnel] ssh 正常退出'); stop(0); return; }

    const lived = Date.now() - startedAt;
    fails++;
    quickFails = lived < 10000 ? quickFails + 1 : 0;

    console.log('');
    console.log('[tunnel] 连接断开（ssh 退出码 ' + code + '，存活 ' + Math.round(lived / 1000) + ' 秒）');
    if (!hinted) { printHints(); hinted = true; }

    if (MAX_RETRIES > 0 && fails > MAX_RETRIES) {
      console.log('');
      console.log('[tunnel] 已连续失败 ' + MAX_RETRIES + ' 次，停止重连。');
      console.log('        检查网络和密钥后，重新双击 启动-公网.bat 即可（上限可在 .tunnel.json 的 maxRetries 改，0 = 不限）。');
      stop(1);
      return;
    }

    if (quickFails >= 2) {
      console.log('[tunnel] 连续快速断开，清理服务器上残留的 ' + remotePort + ' 监听…');
      if (!cleanRemote()) console.log('[tunnel] 清理失败（可能连不上服务器），继续重试');
      quickFails = 0;
    }

    const wait = Math.min(30000, 3000 * fails);
    console.log('[tunnel] ' + Math.round(wait / 1000) + ' 秒后自动重连（' + retryLabel(fails) + '，Ctrl+C 退出）');
    setTimeout(connect, wait);
  });
}

setTimeout(function () {
  console.log('');
  console.log('  访问地址  http://' + ssh.host + ':' + remotePort + '/');
  console.log('  本地服务  http://127.0.0.1:' + localPort + '/');
  console.log('  资源库   ' + (cfg.configFile ? path.resolve(cfg.configFile) : '桌面端 config.json'));
  console.log('  远程编辑  ' + (cfg.allowLibEdit ? '已开启（网页上可增删资源库）' : '关闭（网页只能切库）'));
  console.log('  断线重连  ' + (MAX_RETRIES > 0 ? '最多 ' + MAX_RETRIES + ' 次后放弃' : '不限次数，每 30 秒试一次'));
  console.log('  登录方式  ' + target + ' · ' + (keyFile || path.join(os.homedir(), '.ssh', 'id_rsa')));
  console.log('');
  connect();
}, 900);

process.on('SIGINT', function () { console.log(''); console.log('[tunnel] 已手动停止'); stop(0); });
process.on('SIGTERM', function () { stop(0); });
server.on('exit', function (code) {
  if (code) { console.error('本地服务异常退出：' + code + '（端口被占用？）'); stop(1); }
});
