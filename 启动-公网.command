#!/bin/bash
# 星海 FM · 公网隧道（macOS 版，对应 Windows 的 启动-公网.bat）
# 双击运行；或在终端里 bash "启动-公网.command"
set -u
cd "$(dirname "$0")" || exit 1

echo ""
echo "  星海 FM · 公网隧道"
echo "  需要先在本目录的 .tunnel.json 里填好 ssh.host（库列表默认读桌面端的 config.json）"
echo "  访问口令用：node tools/serve.js --set-password 设置"
echo ""

pause() {
  echo ""
  read -n 1 -s -r -p "按任意键关闭窗口"
  echo ""
}

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没找到 Node.js。先装 LTS 版：https://nodejs.org"
  pause
  exit 1
fi

if [ ! -f .tunnel.json ]; then
  echo "✗ 缺少 .tunnel.json"
  echo "  cp .tunnel.example.json .tunnel.json 然后改 ssh.host"
  pause
  exit 1
fi

if [ ! -f .auth.json ]; then
  echo "! 还没设置访问口令，先在另一个窗口执行："
  echo "    node tools/serve.js --set-password"
  echo ""
  read -n 1 -s -r -p "按任意键继续（没口令会启动失败）"
  echo ""
fi

node tools/tunnel.js

echo ""
echo "隧道已结束。"
pause
