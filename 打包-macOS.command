#!/bin/bash
# 星海FM · 在 macOS 上一键打包（出 dmg + zip，arm64/x64）
set -e
cd "$(dirname "$0")"

echo "== 星海FM · macOS 打包 =="
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没找到 Node.js。先装 LTS 版：https://nodejs.org"
  echo "  装完重新双击本脚本。"
  read -n 1 -s -r -p "按任意键退出"
  exit 1
fi

echo "Node $(node -v) / npm $(npm -v)"
echo ""

# 国内网络下载 Electron 慢时走镜像（不需要可注释掉）
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

echo "→ 安装依赖（首次约 1-2 分钟，会下载 Electron）"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo ""
echo "→ 打包（dmg + zip）"
npm run dist:mac

echo ""
echo "✓ 完成，产物在 dist/ 里：星海FM-<版本>-arm64.dmg / -x64.dmg 等"
open dist 2>/dev/null || true
read -n 1 -s -r -p "按任意键退出"
