@echo off
setlocal enabledelayedexpansion
set "PORT=8090"
if not "%~1"=="" set "PORT=%~1"
set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  set "FOUND=1"
  taskkill /PID %%p /F
  if errorlevel 1 (
    echo [ERROR] Failed to kill PID %%p. Run this script as Administrator.
  ) else (
    echo [SysMon] killed PID %%p
  )
)
if not defined FOUND echo [SysMon] no process listening on port %PORT%.

rem Verify the port is really released before claiming success
for /l %%i in (1,1,10) do (
  netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>nul || goto :released
  ping -n 2 127.0.0.1 >nul
)
echo [ERROR] port %PORT% is still listening after stop attempt.
exit /b 1
:released
echo [SysMon] stop done, port %PORT% is free.
endlocal
