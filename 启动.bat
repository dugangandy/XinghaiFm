@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem 8080 常被占用（例如公网隧道已在跑），占了就顺延到一个空闲端口
set "PORT=8080"
set "MAXPORT=8099"
:pick
if %PORT% gtr %MAXPORT% goto noport
netstat -ano | findstr /i "LISTENING" | findstr /c:":%PORT% " >nul || goto up
set /a PORT+=1
goto pick

:up
echo.
echo   星海 FM · 本地服务
echo   库列表默认读桌面端的 config.json
echo   地址: http://localhost:%PORT%/   （关闭此窗口即停止）
echo.

rem 首次运行/升级：初始化数据库（幂等），保证 admin 用户存在
node "tools\init-db.js"

start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%/"
node "tools\serve.js" %PORT% --no-auth

echo.
pause
exit /b 0

:noport
echo.
echo   8080-%MAXPORT% 端口都被占用，请先关闭占用程序再启动。
pause
exit /b 1
