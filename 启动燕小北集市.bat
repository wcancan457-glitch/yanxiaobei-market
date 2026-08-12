@echo off
chcp 65001 >nul 2>&1
setlocal

set "PROJECT_DIR=%~dp0mobile-web-demo"
set "PORT=5177"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js first.
  pause
  exit /b 1
)

cd /d "%PROJECT_DIR%" || exit /b 1

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$port=%PORT%; if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%PROJECT_DIR%' -WindowStyle Hidden }"

timeout /t 1 /nobreak >nul
start "" "http://localhost:%PORT%"

echo Yanxiaobei Market is available at http://localhost:%PORT%
endlocal
