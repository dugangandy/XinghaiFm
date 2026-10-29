@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "PORT=8080"
set "MAXPORT=8099"

rem 8080 经常被别的服务占着（旧进程/其他工具），占了就往后顺延找一个空闲端口
:pickport
if %PORT% gtr %MAXPORT% goto no-port
netstat -ano | findstr /i "LISTENING" | findstr /c:":%PORT% " >nul || goto got-port
set /a PORT+=1
goto pickport

:got-port
echo.
echo   星海 FM 正在启动...
echo   地址: http://localhost:%PORT%/index.html
echo   关闭此窗口即可停止服务
if not "%PORT%"=="8080" echo   [提示] 8080 已被占用，自动改用 %PORT% 端口
echo.

rem 优先用 Python 3（系统自带 http.server，不需要装依赖）
set "PY="
where py >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  where python >nul 2>nul
  if not errorlevel 1 python -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY=python"
)

if defined PY goto use-python

rem 没有 Python 就用 Node
where node >nul 2>nul
if errorlevel 1 goto no-runtime
start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%/index.html"
node "tools\serve.js" %PORT% --no-auth
goto done

:use-python
start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%/index.html"
%PY% -m http.server %PORT% --bind 127.0.0.1
goto done

:no-port
echo.
echo   [提示] 8080-%MAXPORT% 端口全被占用了，先关掉占用端口的程序再启动。
echo   查占用：netstat -ano ^| findstr LISTENING
echo.
pause
exit /b 1

:no-runtime
echo.
echo   [提示] 没找到可用的 Python 3 或 Node.js，起不了本地服务。
echo   - 装 Python 3 或 Node.js 后重新双击本文件
echo   - 也可以直接双击 index.html：功能一样，只是每次要重新选一次音频目录
echo.
pause
exit /b 1

:done
echo.
echo   服务已停止。
pause
