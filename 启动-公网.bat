@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   星海 FM · 公网隧道
echo   需要先在 .tunnel.json 里填好 ssh.host（库列表默认读桌面端的 config.json）
echo   访问口令用：node tools\serve.js --set-password 设置
echo.

node "tools\tunnel.js"

echo.
pause
