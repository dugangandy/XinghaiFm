# 星海 FM · supervisor 维护手册

用 supervisord 把「公网隧道」做成开机自启的常驻服务：进程崩了自动拉起，登录后自动开跑，日志落盘，日常用 `supervisorctl` / `ctl.sh` 管理。

## 1. 架构

```
launchd（~/Library/LaunchAgents/com.xinghai.fm.supervisord.plist，KeepAlive）
  └─ node supervisor/launch.js          ← 只为把「责任进程」换成 node，见第 2 节
       └─ supervisord（~/.supervisor/venv，unix socket 控制）
            └─ xinghai-fm = node tools/tunnel.js
                 ├─ node tools/serve.js 8080 --host 127.0.0.1 --allow-lib-edit
                 └─ ssh -N -R 8889:127.0.0.1:8080 root@<ssh.host>
```

- 只管 **一个** program：`xinghai-fm`。本地服务和 SSH 隧道都是 `tunnel.js` 自己拉起的子进程，不要单独再托管 `serve.js`，否则会和它的复用逻辑打架。
- 端口、远端地址、重连次数全部来自项目根目录的 `.tunnel.json`。
- 同一个 supervisord 还通过 `~/.supervisor/conf.d/*.conf` 管着别的项目（如 gk-reader），本项目的改动不影响它们。

## 2. 为什么 supervisord 外面还要包一层 node

macOS 的 TCC（隐私权限）只按启动链的**责任进程**判权限，不看子进程自己有没有授权：

```
launchd → supervisord（Apple 的 Python.app）→ serve.js 读 NAS → Operation not permitted（EPERM）
launchd → node launch.js → supervisord → serve.js 读 NAS → 正常（node 有完全磁盘访问权限）
```

直接让 launchd 跑 supervisord 时，责任进程是 `/Library/Developer/CommandLineTools/…/Python.app`，给 node 授权也没用。`supervisor/launch.js` 只做一件事：用 node 起 supervisord、转发信号、退出码跟着走。这样责任进程变成 node，只要给 node 开一次完全磁盘访问权限，整棵子进程树都能读 NAS，`supervisorctl` 的用法一点没变。

> 直接命令行 `supervisord -c …` 调试时（没经过 node），读 NAS 仍会 EPERM，这是预期行为。

## 3. 前提：给 node 完全磁盘访问权限

系统设置 → 隐私与安全性 → 完全磁盘访问权限 → `+` → `⌘⇧G` → `/usr/local/bin/node` → 打开，确认开关是开的。

没授权时的典型表现：

- 日志：`[media] 读取失败 <文件> · EPERM`、`[scan] 根目录不可用，保留上次缓存`
- 封面：`[cover] 保存失败：没有权限写入 .../.fm-covers（EPERM）`
- 页面：专辑能打开、曲目能列出来，一点播放就失败（NAS 库才有，本地盘库正常）

> node 升级（brew / pkg 换二进制）后授权可能失效，重新拖一次即可。

## 4. 文件

| 路径 | 作用 |
| --- | --- |
| `supervisor/supervisord.conf` | supervisord 主配置 + `[program:xinghai-fm]` |
| `supervisor/launch.js` | LaunchAgent 的入口：用 node 起 supervisord（TCC 责任进程） |
| `supervisor/ctl.sh` | 日常启停入口 |
| `supervisor/agent.sh` | 开机自启的安装/卸载 + 健康检查 |
| `~/Library/LaunchAgents/com.xinghai.fm.supervisord.plist` | launchd 启动项，由 `agent.sh install` 生成 |
| `~/.supervisor/venv` | supervisor 本体（Python venv，不进仓库） |
| `~/.supervisor/supervisor.sock` | supervisorctl 的本地 socket |
| `~/.supervisor/logs/xinghai-fm.log` | 程序输出（tunnel / serve / ssh 的 stdout+stderr） |
| `~/.supervisor/logs/launchd.{out,err}.log` | launchd 层兜底日志 |

## 5. 首次安装

```bash
python3 -m venv "$HOME/.supervisor/venv"
"$HOME/.supervisor/venv/bin/pip" install -i https://pypi.org/simple supervisor
bash supervisor/agent.sh install
```

> 本机 `~/.pip/pip.conf` 指的豆瓣源已 404，装包必须显式加 `-i https://pypi.org/simple`。
> 换机器或项目路径变了要 `agent.sh uninstall && agent.sh install`：plist 里写的是绝对路径。

## 6. 日常操作

```bash
bash supervisor/ctl.sh start|stop|restart|status|log
bash supervisor/agent.sh status     # 六项体检，异常退出码 1
supervisorctl status                # 所有 program（含别的项目）
supervisorctl restart xinghai-fm
supervisorctl tail -f xinghai-fm    # 等价 ctl.sh log
supervisorctl reread && supervisorctl update   # 改完配置后生效
```

改判定规则：改 `supervisord.conf` 要 `reread && update`；改 `tools/*.js`、`.tunnel.json` 要 `ctl.sh restart`；只改前端刷新浏览器即可。

## 7. 常见故障

**公网打不开，本地 8080 正常**
看 `agent.sh status` 的 tunnel / public 两项。ssh 掉了 `tunnel.js` 会自己重连，最多 `.tunnel.json` 里的 `maxRetries`（当前 10）次，用尽后退出码 1 → supervisor 整体拉起。连续失败基本是密钥、安全组或服务端 `GatewayPorts` 问题。

**播放失败 / 视频转圈，日志有 EPERM**
回第 2、3 节：确认 LaunchAgent 跑的是 `node supervisor/launch.js`（`ps -o command -p $(pgrep -f launch.js)`），以及 node 的完全磁盘访问权限；顺带确认 `/Volumes/公共空间` 还挂着。

**端口 8080 被占**
`agent.sh status` 的 local 项会区分：占用者是 `serve.js` 且父进程是 tunnel → 正常；父进程不是 tunnel → 野进程，多半是手动 `kill -9` 留下的孤儿。处理：`ctl.sh stop` → `kill <PID>` → `ctl.sh start`。

**`ctl.sh stop` 报「15 秒内没停下」**
`tunnel.js` 收到 TERM 会先收 ssh / serve；偶尔 ssh 卡住。直接 `kill -9 <pid>` 后 `ctl.sh start`。supervisord 自己停程序时是 `stopwaitsecs=15` 后 KILL，不会留孤儿。

**launchctl 显示 running 但程序没起**
`launchctl kickstart -k gui/$(id -u)/com.xinghai.fm.supervisord`，程序按 `autostart=true` 自动拉起。

## 8. 日志与轮转

- 程序日志 10MB × 3 份、supervisord 日志 5MB × 2 份，自动轮转。
- 重启后看不到旧输出是正常的：轮转文件是 `*.log.1`、`*.log.2`。
- 排查顺序：`xinghai-fm.log`（业务）→ `supervisord.log`（为什么被重启）→ `launchd.err.log`（node / supervisord 起不来）。

## 9. 状态含义

| 状态 | 意思 | 处理 |
| --- | --- | --- |
| RUNNING | 正常 | — |
| STARTING | 启动中（`startsecs=10` 内） | 等 10 秒 |
| STOPPED | 被 `ctl.sh stop` 停掉，不会自动起 | `ctl.sh start` |
| BACKOFF | 起得太快又退出，正在退避 | 看日志，多半端口/配置 |
| FATAL | 连续 `startretries=5` 次失败 | 修问题后 `ctl.sh start` |

## 10. 变更边界

- `.tunnel.json`、`.auth.json`、数据库 `~/Library/Application Support/星海FM/fm.db` 不归 supervisor 管。
- 换托管方式（比如不再用 supervisord）时，先 `agent.sh uninstall` 摘掉 LaunchAgent，再动配置，避免两套抢 8080。
