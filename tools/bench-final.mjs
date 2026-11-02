// 最终交叉验证：用 C 无法做，改用 Node 的 Atomics + SharedArrayBuffer 规避 JS 循环开销
// 并测满载时的实际频率与 VBS/Hyper-V 开销影响
import { Worker } from 'node:worker_threads';

const src = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (m) => {
  if (m.kind === 'sum') {
    // 共享数组，避免浮点数组装箱开销
    const n = m.n;
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = i & 0xffff;
    let best = Infinity;
    for (let rep = 0; rep < 3; rep++) {
      const t0 = process.hrtime.bigint();
      let s = 0;
      for (let i = 0; i < n; i++) s += a[i];
      const t1 = process.hrtime.bigint();
      best = Math.min(best, Number(t1 - t0) / 1e9);
    }
    parentPort.postMessage({ gbps: (n * 8) / best });
  } else {
    // 满载，用于观察频率
    const end = Date.now() + m.ms;
    let x = 1.000001;
    while (Date.now() < end) { for (let i = 0; i < 50000; i++) x = x * 1.0000001 + 0.0000001; }
    parentPort.postMessage({ x });
  }
});
`;

async function run(n, msg) {
  const ws = Array.from({ length: n }, () => new Worker(src, { eval: true }));
  await Promise.all(ws.map((w) => new Promise((r) => w.once('online', r))));
  const rs = await Promise.all(ws.map((w) => new Promise((r) => { w.once('message', r); w.postMessage(msg); })));
  await Promise.all(ws.map((w) => w.terminate()));
  return rs;
}

console.log('=== 单线程顺序读带宽（多次取最优）===');
const N = (256 * 1024 * 1024) / 8;
const r1 = await run(1, { kind: 'sum', n: N });
console.log(`  ${r1[0].gbps.toFixed(1)} GB/s`);

console.log('\n=== 16 线程满载 5 秒，观察实际频率 ===');
await run(8, { kind: 'spin', ms: 5000 });
console.log('  (满载中，读取频率...)');

// 在满载期间读频率
const { execSync } = await import('node:child_process');
const busy = run(16, { kind: 'spin', ms: 6000 });
await new Promise((r) => setTimeout(r, 2500));

try {
  const out = execSync(
    'powershell -NoProfile -Command "(Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation | Where-Object {$_.Name -eq \'_Total\'}).PercentProcessorPerformance"',
    { encoding: 'utf8', timeout: 15000 }
  ).trim();
  console.log(`  满载时 PercentProcessorPerformance: ${out}%  (100% = 满频 3.0GHz)`);
} catch (e) {
  console.log('  频率读取失败:', e.message.slice(0, 60));
}

await busy;
console.log('\n完成');
