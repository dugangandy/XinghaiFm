#!/bin/bash
# 星海 FM · 让 supervisord 开机（登录）自启
# 用法: supervisor/agent.sh install|uninstall|status
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$ROOT/supervisor/supervisord.conf"
BIN="$HOME/.supervisor/venv/bin"
SOCK="$HOME/.supervisor/supervisor.sock"
LABEL="com.xinghai.fm.supervisord"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
PROG="xinghai-fm"

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

case "${1:-status}" in
  install)
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.supervisor/logs"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN/supervisord</string>
    <string>-n</string>
    <string>-c</string>
    <string>$CONF</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>zh_CN.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/.supervisor/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/.supervisor/logs/launchd.err.log</string>
</dict>
</plist>
PLIST_EOF

    # 现在这份是手动起的，先收掉，避免两个 supervisord 抢 socket
    if [ -S "$SOCK" ] && "$BIN/supervisorctl" -c "$CONF" pid >/dev/null 2>&1; then
      echo "停止当前手动运行的 supervisord…"
      "$BIN/supervisorctl" -c "$CONF" shutdown >/dev/null 2>&1
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        [ -S "$SOCK" ] || break
        sleep 0.3
      done
    fi
    loaded && launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
    launchctl bootstrap "$DOMAIN" "$PLIST" || exit 1
    launchctl enable "$DOMAIN/$LABEL"
    sleep 3
    "$BIN/supervisorctl" -c "$CONF" status
    echo "已设置开机自启：$PLIST"
    ;;
  uninstall)
    loaded && launchctl bootout "$DOMAIN/$LABEL"
    rm -f "$PLIST"
    echo "已取消开机自启（supervisord 进程也随之退出）"
    ;;
  status)
    FAIL=0
    mark() { printf '  %s %-13s %s\n' "$1" "$2" "$3"; }
    ok()  { mark '✓' "$1" "$2"; }
    bad() { mark '✗' "$1" "$2"; FAIL=1; }

    # 端口从 .tunnel.json 读，读不到就用默认值
    LPORT=8080; RPORT=8889; HOST=""
    if [ -f "$ROOT/.tunnel.json" ]; then
      IFS='|' read -r LPORT RPORT HOST < <(node -e 'const c=require(process.argv[1]);process.stdout.write([c.localPort||8080,c.remotePort||8889,(c.ssh&&c.ssh.host)||""].join("|"))' "$ROOT/.tunnel.json" 2>/dev/null)
    fi

    echo "星海 FM · 服务检查"
    echo ""

    # 1. LaunchAgent
    if loaded; then
      ok LaunchAgent "已加载"
    elif [ -f "$PLIST" ]; then
      bad LaunchAgent "plist 在但没加载：launchctl bootstrap gui/$(id -u) $PLIST"
    else
      ok LaunchAgent "未安装（手动模式，重启后不会自启）"
    fi

    # 2. supervisord
    SUP_PID=$("$BIN/supervisorctl" -c "$CONF" pid 2>/dev/null)
    case "$SUP_PID" in
      ''|0) bad supervisord "没在运行：supervisor/ctl.sh start"; SUP_PID="" ;;
      *)    ok supervisord "运行中（pid ${SUP_PID}）" ;;
    esac

    # 3. 被托管的程序
    LINE=""
    [ -n "$SUP_PID" ] && LINE=$("$BIN/supervisorctl" -c "$CONF" status "$PROG" 2>/dev/null | head -1)
    P_STATE=UNKNOWN; P_PID=""; P_UP=""
    if [ -n "$LINE" ]; then
      set -- $LINE
      [ $# -ge 2 ] && P_STATE=$2
      [ "$P_STATE" = "RUNNING" ] && [ $# -ge 4 ] && P_PID=$(echo "$4" | tr -d ',')
      [ $# -ge 6 ] && P_UP=$6
    fi
    if [ "$P_STATE" = "RUNNING" ]; then
      ok program "RUNNING（pid ${P_PID}，uptime ${P_UP}）"
    elif [ -n "$LINE" ]; then
      NOTE=""
      [ -n "$P_PID" ] && NOTE="（pid ${P_PID}）"
      bad program "$P_STATE$NOTE"
    else
      bad program "拿不到状态（supervisord 未运行？）"
    fi
    [ "$P_STATE" = "RUNNING" ] || P_PID=""

    # 4. 本地服务端口 + 是否真挂在 supervisor 的进程树里
    S_PID=$(lsof -nP -iTCP:$LPORT -sTCP:LISTEN -t 2>/dev/null | head -1)
    if [ -z "$S_PID" ]; then
      bad local "127.0.0.1:$LPORT 没在听"
    elif ! ps -o args= -p "$S_PID" 2>/dev/null | grep -q 'serve\.js'; then
      bad local "127.0.0.1:$LPORT 被别的进程占用（pid ${S_PID}）"
    else
      S_PPID=$(ps -o ppid= -p "$S_PID" 2>/dev/null | tr -d ' ')
      if [ -n "$P_PID" ] && [ "$S_PPID" = "$P_PID" ]; then
        ok local "127.0.0.1:$LPORT 在听（serve.js pid ${S_PID}，父进程即 tunnel）"
      else
        bad local "127.0.0.1:$LPORT 是野进程（pid ${S_PID}，父 ${S_PPID}），不是 supervisor 拉起的"
      fi
    fi

    # 5. SSH 反向隧道
    T_PID=$(pgrep -f "ssh .*-R $RPORT:127.0.0.1:$LPORT" 2>/dev/null | head -1)
    if [ -n "$T_PID" ]; then
      ok tunnel "-R $RPORT → 127.0.0.1:${LPORT}（ssh pid ${T_PID}）"
    else
      bad tunnel "没有到 $RPORT 的 ssh 反向隧道"
    fi

    # 6. 公网可达性
    if [ -n "$HOST" ]; then
      CODE=$(curl -sS -o /dev/null -m 6 -w '%{http_code}' "http://$HOST:$RPORT/" 2>/dev/null)
      case "$CODE" in
        200|302|401|403) ok public "http://$HOST:$RPORT/ 返回 $CODE" ;;
        000|'')          bad public "http://$HOST:$RPORT/ 连不上（隧道 / 安全组 / 网络）" ;;
        *)               bad public "http://$HOST:$RPORT/ 返回 ${CODE}（应为 200/302/401）" ;;
      esac
    else
      bad public ".tunnel.json 里没有 ssh.host"
    fi

    echo ""
    if [ "$FAIL" -eq 0 ]; then
      echo "  全部正常"
    else
      echo "  有异常项，看日志：supervisor/ctl.sh log"
      exit 1
    fi
    ;;
  *)
    echo "用法: $0 {install|uninstall|status}"
    exit 1
    ;;
esac
