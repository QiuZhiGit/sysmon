@echo off
setlocal
net session >nul 2>nul
if errorlevel 1 (
  echo [ERROR] This script must run as Administrator.
  exit /b 1
)
schtasks /Delete /TN "SysMon-Web" /F 2>nul && echo Task removed. || echo Task not found.
netsh advfirewall firewall delete rule name="SysMon-Web-8090" >nul 2>nul && echo Firewall rule removed.
endlocal
