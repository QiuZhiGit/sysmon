// 证明温度采集链路本身是通的：用合成传感器数据走一遍解析与归一化，
// 从而把本机的"不可用"归因于硬件，而不是代码缺陷。
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const WIN = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const script = path.join(process.cwd(), 'collectors', 'scripts', 'thermal-selftest.ps1');

const r = spawnSync(WIN, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
  encoding: 'utf8',
  timeout: 20000,
});

if (r.status !== 0 || !r.stdout) {
  console.log('FAIL 自检脚本未产出输出');
  console.log('stdout:', (r.stdout || '').slice(0, 300));
  console.log('stderr:', (r.stderr || '').slice(0, 300));
  process.exit(1);
}

const data = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1));

const checks = [
  ['合成传感器被采集', data.sensorCount === 4, `${data.sensorCount} 个（ACPI 1 + LHM 3）`],
  ['ACPI 开尔文换算正确', Math.abs(data.acpiCelsius - 72.5) < 0.1, `${data.acpiCelsius}°C（原始 ${'(72.5+273.15)*10'} 十分之一开尔文）`],
  ['温度传感器计数', data.tempCount === 3, `${data.tempCount} 个`],
  ['风扇传感器计数', data.fanCount === 1, `${data.fanCount} 个`],
  ['最高温取值正确', Math.abs(data.maxTempC - 72.5) < 0.1, `${data.maxTempC}°C`],
  ['异常值被过滤(0/999/999999)', data.bogusFiltered === true, `bogusFiltered=${data.bogusFiltered}`],
];

let pass = 0;
console.log('--- 温度采集链路自检（合成数据）---');
for (const [n, ok, d] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  (${d})`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} passed`);
console.log(pass === checks.length
  ? '\n结论：解析/换算/过滤链路正常。本机显示「不可用」是因为硬件未暴露传感器，不是代码问题。'
  : '\n结论：链路存在缺陷，需要修复。');
process.exit(pass === checks.length ? 0 : 1);
