// 内存带宽深入诊断：多线程 + 不同访问模式
// 单线程 ~5.4GB/s 太低，DDR4-3200 双通道理论 51.2 GB/s。
// 需要区分：是单线程受限于延迟，还是真实带宽就这么低。
import { Worker } from 'node:worker_threads';

const src = `
const { parentPort } = require('worker_threads');
parentPort.on('message', (m) => {
  const n = (m.mb * 1024 * 1024) / 8;
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = i & 0xffff;

  const t0 = process.hrtime.bigint();
  if (m.mode === 'copy') {
    for (let i = 0; i < n; i++) b[i] = a[i];
  } else if (m.mode === 'rw') {
    for (let i = 0; i < n; i++) b[i] = a[i] * 2 + 1;
  } else if (m.mode === 'read') {
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i];
    b[0] = s;
  }
  const t1 = process.hrtime.bigint();
  parentPort.postMessage({ sec: Number(t1 - t0) / 1e9, n });
});
`;

async function run(nThreads, mb, mode) {
  const ws = Array.from({ length: nThreads }, () => new Worker(src, { eval: true }));
  await Promise.all(ws.map((w) => new Promise((r) => w.once('online', r))));
  const t0 = process.hrtime.bigint();
  const rs = await Promise.all(
    ws.map((w) => new Promise((r) => { w.once('message', r); w.postMessage({ mb, mode }); }))
  );
  const t1 = process.hrtime.bigint();
  const wall = Number(t1 - t0) / 1e9;
  await Promise.all(ws.map((w) => w.terminate()));

  const bytesPerElem = mode === 'read' ? 8 : 16; // 读或读写
  const bytes = rs.reduce((s, r) => s + r.n * bytesPerElem, 0);
  return bytes / wall / 1e9;
}

console.log('模式      线程  带宽(GB/s)');
console.log('--------------------------');
for (const mode of ['read', 'copy', 'rw']) {
  for (const nt of [1, 2, 4, 8, 16]) {
    const gbps = await run(nt, 64, mode);
    console.log(`${mode.padEnd(8)}  ${String(nt).padStart(2)}   ${gbps.toFixed(1)}`);
  }
}

console.log('\n参考值：DDR4-3200 双通道理论峰值 = 51.2 GB/s');
console.log('      实测通常达到峰值的 60-75% = 30-38 GB/s');
