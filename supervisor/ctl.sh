#!/bin/bash
# 星海 FM · supervisor 控制入口
# 用法: supervisor/ctl.sh {start|stop|restart|status|log}
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$ROOT/supervisor/supervisord.conf"
BIN="$HOME/.supervisor/venv/bin"
SOCK="$HOME/.supervisor/supervisor.sock"
PROG="xinghai-fm"

if [ ! -x "$BIN/supervisord" ]; then
  echo "✗ 没装 supervisor，先执行："
  echo "  python3 -m venv \"$HOME/.supervisor/venv\" && \"$HOME/.supervisor/venv/bin/pip\" install -i https://pypi.org/simple supervisor"
  exit 1
fi

running() { [ -S "$SOCK" ] && "$BIN/supervisorctl" -c "$CONF" pid >/dev/null 2>&1; }
agent_plist() { echo "$HOME/Library/LaunchAgents/com.xinghai.fm.supervisord.plist"; }

case "${1:-status}" in
  start)
    mkdir -p "$HOME/.supervisor/logs"
    if running; then
      "$BIN/supervisorctl" -c "$CONF" start "$PROG"
    elif [ -f "$(agent_plist)" ]; then
      # 装了 LaunchAgent 就交给 launchd 拉，别手动再起一个 supervisord
      launchctl kickstart -k "gui/$(id -u)/com.xinghai.fm.supervisord"
      sleep 3
    else
      "$BIN/supervisord" -c "$CONF"
      sleep 1
    fi
    "$BIN/supervisorctl" -c "$CONF" status "$PROG"
    ;;
  stop)
    if running; then
      "$BIN/supervisorctl" -c "$CONF" stop "$PROG"
    else
      echo "supervisord 没在运行"
    fi
    ;;
  shutdown)
    # 装了 LaunchAgent 时，只 shutdown 会被 launchd 立刻拉回来，先摘掉自启
    if [ -f "$(agent_plist)" ]; then launchctl bootout "gui/$(id -u)/com.xinghai.fm.supervisord" 2>/dev/null; fi
    running && "$BIN/supervisorctl" -c "$CONF" shutdown
    ;;
  restart)
    "$0" stop >/dev/null 2>&1
    "$0" start
    ;;
  status)
    if running; then "$BIN/supervisorctl" -c "$CONF" status; else echo "supervisord 没在运行（$SOCK 不存在）"; fi
    ;;
  log)
    tail -n 80 -f "$HOME/.supervisor/logs/$PROG.log"
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|log|shutdown}"
    exit 1
    ;;
esac
