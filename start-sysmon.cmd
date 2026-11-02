@echo off
setlocal
set "APPDIR=%~dp0"
cd /d "%APPDIR%"
if not exist "logs" mkdir "logs"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe not found in PATH.
  echo Install Node.js or add it to PATH, then retry.
  exit /b 1
)
echo [SysMon] starting, port comes from config.json
node "%APPDIR%server.js"
echo [SysMon] exited with code %errorlevel%
endlocal
