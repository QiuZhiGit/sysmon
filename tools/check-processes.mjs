// 验证进程内存采集的准确性与性能影响
const snap = async () => (await fetch('http://127.0.0.1:8090/api/snapshot')).json();

const s = await snap();
const p = s.processes;

console.log('=== 数据自洽性 ===');
console.log(`系统内存利用率 : ${s.mem.usage}%`);
console.log(`进程口径利用率 : ${p.usedPercent}%`);
console.log(`差值           : ${(s.mem.usage - p.usedPercent).toFixed(2)} 个百分点`);

console.log('\n=== TOP N 份额 ===');
const sumTop = p.top.reduce((a, b) => a + b.pctOfUsed, 0);
console.log(`TOP${p.top.length} 合计占已用内存: ${sumTop.toFixed(1)}%`);

console.log('\n=== 排序正确性 ===');
let sorted = true;
for (let i = 1; i < p.top.length; i++) {
  if (p.top[i].privateMB > p.top[i - 1].privateMB) sorted = false;
}
console.log(`降序排列: ${sorted ? 'PASS' : 'FAIL'}`);

console.log('\n=== 数值合理性 ===');
const allPositive = p.top.every((x) => x.privateMB > 0 && x.count >= 1);
const pctSane = p.top.every((x) => x.pctOfUsed >= 0 && x.pctOfUsed <= 100);
console.log(`内存值为正: ${allPositive ? 'PASS' : 'FAIL'}`);
console.log(`占比在 0-100: ${pctSane ? 'PASS' : 'FAIL'}`);

console.log('\n=== 采集开销 ===');
const t0 = Date.now();
for (let i = 0; i < 5; i++) await snap();
const avg = (Date.now() - t0) / 5;
console.log(`快照接口平均响应: ${avg.toFixed(0)} ms（含 1 秒缓存刷新，非采集耗时）`);

const checks = [
  ['进程数据可用', p.available === true],
  ['TOP 数量正确', p.top.length === 10],
  ['降序排列', sorted],
  ['数值全为正', allPositive],
  ['占比范围合法', pctSane],
  ['进程/程序计数合理', p.processCount > 0 && p.groupCount > 0 && p.groupCount <= p.processCount],
  ['已用内存合理', p.usedMB > 0 && p.usedMB < p.totalMB],
  ['与系统口径接近', Math.abs(s.mem.usage - p.usedPercent) < 25],
];

console.log('');
let pass = 0;
for (const [n, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
