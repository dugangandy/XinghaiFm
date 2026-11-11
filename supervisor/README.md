# 星海 FM · supervisor 维护手册

用 supervisor 把「公网隧道」做成开机自启的常驻服务。以前双击 `启动-公网.command` 的活，现在由 supervisord 代管：进程崩了自动拉起，登录后自动开跑，日志落盘。

## 1. 架构

```
launchd（~/Library/LaunchAgents/com.xinghai.fm.supervisord.plist，KeepAlive）
  └─ supervisord（~/.supervisor/venv，常驻进程，unix socket 控制）
       └─ xinghai-fm = node tools/tunnel.js
            ├─ node tools/serve.js 8080 --host 127.0.0.1 --allow-lib-edit
            └─ ssh -N -R 8889:127.0.0.1:8080 root@<ssh.host>
```

- 只管 **一个** program：`xinghai-fm`。本地服务和 SSH 隧道都是 `tunnel.js` 自己拉起的子进程，不要单独再托管 `serve.js`，否则会和它的复用逻辑打架。
- 端口、远端地址、重连次数全部来自项目根目录的 `.tunnel.json`，改配置只改那一个文件。

## 2. 文件

| 路径 | 作用 |
| --- | --- |
| `supervisor/supervisord.conf` | supervisord 主配置 + `[program:xinghai-fm]` |
| `supervisor/ctl.sh` | 日常启停入口 |
| `supervisor/agent.sh` | 开机自启的安装/卸载 + 健康检查 |
| `~/Library/LaunchAgents/com.xinghai.fm.supervisord.plist` | launchd 启动项，由 `agent.sh install` 生成 |
| `~/.supervisor/venv` | supervisor 本体（Python venv，不进仓库） |
| `~/.supervisor/supervisor.sock` | supervisorctl 的本地 socket |
| `~/.supervisor/supervisord.log` | supervisord 自身日志 |
| `~/.supervisor/logs/xinghai-fm.log` | 程序输出（tunnel / serve / ssh 的全部 stdout+stderr） |
| `~/.supervisor/logs/launchd.{out,err}.log` | launchd 层兜底日志 |
| `/usr/local/bin/supervisorctl` | 软链 → `~/.supervisor/venv/bin/supervisorctl`，任何目录都能直接敲 |
| `/usr/local/etc/supervisord.conf` | 软链 → 本项目的 `supervisor/supervisord.conf`，给 supervisorctl 找 socket 用 |

## 3. 首次安装

```bash
python3 -m venv "$HOME/.supervisor/venv"
"$HOME/.supervisor/venv/bin/pip" install -i https://pypi.org/simple supervisor
bash supervisor/agent.sh install
```

> 本机 `~/.pip/pip.conf` 指向的豆瓣源已经 404，装包必须显式加 `-i https://pypi.org/simple`，否则会报 `No matching distribution found`。
> 换机器 / 换用户名不用改脚本：路径全是运行时从 `$HOME` 和脚本自身位置推出来的；但 LaunchAgent 里写死了绝对路径，换路径后要 `agent.sh uninstall && agent.sh install`。

## 4. 日常操作

```bash
bash supervisor/ctl.sh start      # 起（已装 agent 时走 launchctl kickstart）
bash supervisor/ctl.sh stop       # 停程序，supervisord 继续待命
bash supervisor/ctl.sh restart    # 重启程序
bash supervisor/ctl.sh status     # 程序状态
bash supervisor/ctl.sh log        # tail -f 程序日志
bash supervisor/ctl.sh shutdown   # supervisord 一起退（装了 agent 会先摘掉自启，否则会被拉回）
```

两个软链装好后，`supervisorctl` 在任何目录都能直接用，不必带 `-c`：

```bash
supervisorctl status                   # 所有被托管的程序
supervisorctl restart xinghai-fm       # 重启单个程序
supervisorctl start|stop xinghai-fm
supervisorctl tail -f xinghai-fm       # 跟日志（等价 ctl.sh log）
supervisorctl reread && supervisorctl update   # 改完配置后生效
supervisorctl                          # 不带参数进交互 shell，可 tab 补全
```

软链失效（项目挪位置、重建 venv）后重做：

```bash
ln -sfn "$HOME/.supervisor/venv/bin/supervisorctl" /usr/local/bin/supervisorctl
ln -sfn "<项目路径>/supervisor/supervisord.conf" /usr/local/etc/supervisord.conf
```

`ctl.sh` 只是包了一层（自动起 supervisord、找不到就提示装依赖），两种用法等价，选了哪种就一直用哪种。

健康检查（六项：LaunchAgent / supervisord / program / 本地端口 / SSH 隧道 / 公网可达），异常时退出码 1：

```bash
bash supervisor/agent.sh status
```

## 5. 日志与轮转

- 程序日志 10MB × 3 份，supervisord 日志 5MB × 2 份，自动轮转，不用手动清。
- 重启后看不到旧输出是正常的：轮转文件是 `*.log.1`、`*.log.2`。
- 排查顺序：`xinghai-fm.log`（业务）→ `supervisord.log`（为什么被重启）→ `launchd.err.log`（supervisord 自己起不来）。

## 6. 状态含义

| 状态 | 意思 | 处理 |
| --- | --- | --- |
| RUNNING | 正常 | — |
| STARTING | 启动中（`startsecs=10` 内都算） | 等 10 秒再看 |
| STOPPED | 被 `ctl.sh stop` 停掉；**不会自动起** | `ctl.sh start` |
| BACKOFF | 起得太快又退出，正在退避重试 | 看日志，多半是端口/配置问题 |
| FATAL | 连续 `startretries=5` 次失败，supervisor 放弃 | 修问题后 `ctl.sh start` |
| EXITED | 正常退出（退出码 0）且 `autorestart=unexpected` 不拉 | 一般出现在手动 Ctrl+C 后 |

## 7. 常见故障

**公网打不开，但本地 8080 正常**
先看 `agent.sh status` 的 tunnel 项。ssh 掉了 `tunnel.js` 会自己重连，最多 `.tunnel.json` 里的 `maxRetries`（当前 10）次，用尽后进程退出码 1 → supervisor 再整体拉起。连续失败基本是密钥、安全组或服务端 `GatewayPorts` 的问题，日志里会有排查提示。

**端口 8080 被占**
`agent.sh status` 的 local 项会区分两种情况：
- 占用者是 `serve.js` 且父进程就是 tunnel → 正常；
- 父进程不是 tunnel（父为 1 或别的 PID）→ 野进程，多半是之前手动 `kill -9` 留下的孤儿。处理：`ctl.sh stop` → `kill <那个 PID>` → `ctl.sh start`。

**STOPPED 之后一直不复位**
`stop` 是人工意图，supervisor 不会自动恢复。`ctl.sh start` 即可。

**launchctl 显示 running 但程序没起**
`launchctl kickstart -k gui/$(id -u)/com.xinghai.fm.supervisord` 重启 supervisord，程序会按 `autostart=true` 自动拉起。

**改完配置没生效**
supervisord 不会自动重读：

```bash
"$HOME/.supervisor/venv/bin/supervisorctl" -c supervisor/supervisord.conf reread   # 只检测变更
"$HOME/.supervisor/venv/bin/supervisorctl" -c supervisor/supervisord.conf update   # 应用到运行中的进程
```

## 8. 改托管内容

加一个 program（模板，`%(ENV_HOME)s` 展开成 `$HOME`）：

```ini
[program:名字]
command=/usr/local/bin/node tools/xxx.js
directory=/Volumes/Macintosh HD/Users/app/XinghaiFm
autostart=true
autorestart=unexpected
startsecs=10
stopasgroup=true
killasgroup=true
redirect_stderr=true
stdout_logfile=%(ENV_HOME)s/.supervisor/logs/名字.log
environment=HOME="%(ENV_HOME)s",PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
```

改完 `reread` + `update`。注意 `supervisor/` 里路径含空格（`Macintosh HD`），`directory` 可以直接写空格，`command` 里不要给脚本路径加引号。

调参几个关键项：

| 项 | 当前值 | 说明 |
| --- | --- | --- |
| `startsecs` | 10 | 撑过 10 秒才算 RUNNING，早退算启动失败 |
| `startretries` | 5 | 连续启动失败上限，超过进 FATAL |
| `stopwaitsecs` | 15 | TERM 后等多久才 KILL |
| `stopasgroup` / `killasgroup` | true | 停止时连带 ssh、serve 一起收，避免孤儿 |
| `autorestart` | unexpected | 崩了才拉；正常退出不反复重启 |

## 9. 升级 / 卸载

```bash
"$HOME/.supervisor/venv/bin/pip" install -i https://pypi.org/simple -U supervisor
bash supervisor/ctl.sh restart        # 用新版重启程序
```

彻底回退到手动模式：

```bash
bash supervisor/agent.sh uninstall    # 摘掉 LaunchAgent，supervisord 退出
bash supervisor/ctl.sh shutdown       # 若还有手动起的实例
# 之后照旧双击 启动-公网.command
```

## 10. 变更边界

- `.tunnel.json`、`.auth.json`、数据库 `~/Library/Application Support/星海FM/fm.db` 都不归 supervisor 管，不在这套配置里读写。
- 机器睡眠唤醒后，ssh 断线由 `tunnel.js` 自己重连，supervisord 只在进程真的退出时才介入。
- 日志不写进仓库，`supervisor/` 目录里只有 4 个文件（配置 + 两个脚本 + 本手册）该进版本库。
