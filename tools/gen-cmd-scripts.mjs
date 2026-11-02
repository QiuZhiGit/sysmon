// 生成 ASCII + CRLF 的启停脚本（含真实的结果校验）
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(process.argv[2] || process.cwd());

const files = {
  'start-sysmon.cmd': [
    '@echo off',
    'setlocal',
    'set "APPDIR=%~dp0"',
    'cd /d "%APPDIR%"',
    'if not exist "logs" mkdir "logs"',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo [ERROR] node.exe not found in PATH.',
    '  echo Install Node.js or add it to PATH, then retry.',
    '  exit /b 1',
    ')',
    'echo [SysMon] starting, port comes from config.json',
    'node "%APPDIR%server.js"',
    'echo [SysMon] exited with code %errorlevel%',
    'endlocal',
  ],

  'stop-sysmon.cmd': [
    '@echo off',
    'setlocal enabledelayedexpansion',
    'set "PORT=8090"',
    'if not "%~1"=="" set "PORT=%~1"',
    'set "FOUND="',
    'for /f "tokens=5" %%p in (\'netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"\') do (',
    '  set "FOUND=1"',
    '  taskkill /PID %%p /F',
    '  if errorlevel 1 (',
    '    echo [ERROR] Failed to kill PID %%p. Run this script as Administrator.',
    '  ) else (',
    '    echo [SysMon] killed PID %%p',
    '  )',
    ')',
    'if not defined FOUND echo [SysMon] no process listening on port %PORT%.',
    '',
    'rem Verify the port is really released before claiming success',
    'for /l %%i in (1,1,10) do (',
    '  netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>nul || goto :released',
    '  ping -n 2 127.0.0.1 >nul',
    ')',
    'echo [ERROR] port %PORT% is still listening after stop attempt.',
    'exit /b 1',
    ':released',
    'echo [SysMon] stop done, port %PORT% is free.',
    'endlocal',
  ],

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
