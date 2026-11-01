@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem Pick the first free port from 8080 up (8080 may already be taken by the tunnel).
set "PORT=8080"
set "MAXPORT=8099"
:pick
if %PORT% gtr %MAXPORT% goto noport
netstat -ano | findstr /i "LISTENING" | findstr /c:":%PORT% " >nul || goto up
set /a PORT+=1
goto pick

:up
echo.
echo   Xinghai FM - local server
echo   Library list: desktop config.json
echo   URL: http://localhost:%PORT%/  (use this PC's LAN IP for other devices)
echo.

rem Create/upgrade the database (idempotent) so an admin user always exists.
node "tools\init-db.js"

start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%/"
node "tools\serve.js" %PORT% --no-auth

echo.
pause
exit /b 0

:noport
echo.
echo   Ports 8080-%MAXPORT% are all in use. Close the program using them and retry.
pause
exit /b 1
