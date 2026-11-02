// 生成 ASCII + CRLF 的提权配置脚本
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(process.argv[2] || process.cwd());

const files = {
  // 用 S-1-5-18(SYSTEM) 注册开机任务，网络就绪后再启动，失败自动重试
  'setup-autostart.cmd': [
    '@echo off',
    'setlocal',
    'set "HERE=%~dp0"',
    'if "%HERE:~-1%"=="\\" set "HERE=%HERE:~0,-1%"',
    'set "TASK=SysMon-Web"',
    '',
    'net session >nul 2>nul',
    'if errorlevel 1 (',
    '  echo [ERROR] This script must run as Administrator.',
    '  echo Right-click it and choose "Run as administrator".',
    '  exit /b 1',
    ')',
    '',
    'echo [1/3] Checking node.exe ...',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo [ERROR] node.exe not found in PATH. Install Node.js first.',
    '  exit /b 1',
    ')',
    'for /f "delims=" %%i in (\'where node\') do (set "NODE=%%i" & goto :gotnode)',
    ':gotnode',
    'echo       node = %NODE%',
    '',
    'echo [2/3] Registering scheduled task "%TASK%" (run as SYSTEM at boot) ...',
    'schtasks /Delete /TN "%TASK%" /F >nul 2>nul',
    'schtasks /Create /TN "%TASK%" /TR "\"%NODE%\" \"%HERE%\\server.js\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /DELAY 0000:30 /F',
    'if errorlevel 1 (',
    '  echo [ERROR] Failed to create scheduled task.',
    '  exit /b 1',
    ')',
    '',
    'echo [3/3] Adding firewall rule for TCP 8090 ...',
    'netsh advfirewall firewall delete rule name="SysMon-Web-8090" >nul 2>nul',
    'netsh advfirewall firewall add rule name="SysMon-Web-8090" dir=in action=allow protocol=TCP localport=8090 profile=any',
    'if errorlevel 1 echo [WARN] Firewall rule failed; LAN access may be blocked.',
    '',
    'echo.',
    'echo Done. The monitor will start automatically after next boot.',
    'echo Start it now with: schtasks /Run /TN "%TASK%"',
    'echo.',
    'echo Current LAN addresses:',
    'for /f "tokens=2 delims=:" %%a in (\'ipconfig ^| findstr /c:"IPv4"\') do echo   http://%%a:8090/',
    'endlocal',
  ],

  'remove-autostart.cmd': [
    '@echo off',
    'setlocal',
    'net session >nul 2>nul',
    'if errorlevel 1 (',
    '  echo [ERROR] This script must run as Administrator.',
    '  exit /b 1',
    ')',
    'schtasks /Delete /TN "SysMon-Web" /F 2>nul && echo Task removed. || echo Task not found.',
    'netsh advfirewall firewall delete rule name="SysMon-Web-8090" >nul 2>nul && echo Firewall rule removed.',
    'endlocal',
  ],

  // 无需提权：当前用户登录后自动启动（隐藏窗口）
  'start-sysmon-hidden.vbs': [
    "' Launch SysMon without a console window.",
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'base = fso.GetParentFolderName(WScript.ScriptFullName)',
    'sh.CurrentDirectory = base',
    'sh.Run "cmd.exe /c """ & base & "\\start-sysmon.cmd""", 0, False',
  ],
};

for (const [name, lines] of Object.entries(files)) {
  const target = path.join(DIR, name);
  fs.writeFileSync(target, lines.join('\r\n') + '\r\n', 'ascii');
  console.log(`wrote ${name} (${fs.statSync(target).size} bytes, CRLF+ASCII)`);
}
