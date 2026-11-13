#!/usr/bin/env node
/* ── launch.js · 让 launchd 的启动程序是 node，而不是 Apple 的 Python ─────
 *
 * macOS 的 TCC 只按启动链的「责任进程」判权限，不看子进程自己有没有授权。
 * LaunchAgent 直接跑 supervisord 时，责任进程是 /Library/Developer/CommandLineTools/
 * …/Python.app；它下面的 serve.js 读 NAS / 网络卷会被拒成 EPERM——表现很隐蔽：
 * 扫得到文件、能 stat 到大小，一读就 Operation not permitted。
 *
 * 换成 launchd → node launch.js → supervisord，责任进程就是 node；给 node 开一次
 * 「完全磁盘访问权限」，整棵子进程树（supervisord、tunnel.js、serve.js）都能读。
 * supervisorctl 照常可用：socket、配置、日志都没变。
 *
 * 这个文件只做一件事：原样起 supervisord，转发信号，退出码跟着它。
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const CONF = path.join(ROOT, 'supervisor', 'supervisord.conf');
const SUP = path.join(os.homedir(), '.supervisor', 'venv', 'bin', 'supervisord');

if (!fs.existsSync(SUP)) {
  console.error('找不到 supervisord：' + SUP);
  console.error('先装：python3 -m venv "$HOME/.supervisor/venv" && "$HOME/.supervisor/venv/bin/pip" install -i https://pypi.org/simple supervisor');
  process.exit(1);
}

const child = spawn(SUP, ['-n', '-c', CONF], { stdio: 'inherit' });

/* launchd 发来的 TERM 转给 supervisord，让它按自己的流程收子进程 */
['SIGTERM', 'SIGINT', 'SIGHUP'].forEach(function (sig) {
  process.on(sig, function () { try { child.kill(sig); } catch (e) {} });
});

child.on('exit', function (code, signal) {
  if (signal) {
    console.log('[launch] supervisord 被信号 ' + signal + ' 结束');
    process.exit(1);
  }
  process.exit(code == null ? 1 : code);
});
