// 最终确认：内存带宽瓶颈在哪
// 1) 用 TypedArray.set() 走 memcpy 路径，测真实硬件拷贝上限
// 2) 极小数组（L1/L2 驻留）测纯 CPU 速度，排除内存影响
import { Worker } from 'node:worker_threads';

const src = `
const { parentPort } = require('worker_threads');
parentPort.on('message', (m) => {
  if (m.mode === 'memcpy') {
    const n = (m.mb * 1024 * 1024) / 8;
    const a = new Float64Array(n);
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = i & 0xffff;
    const t0 = process.hrtime.bigint();
    b.set(a);                       // memcpy 路径，接近硬件极限
    const t1 = process.hrtime.bigint();
    const sec = Number(t1 - t0) / 1e9;
    parentPort.postMessage({ sec, bytes: n * 8 * 2 });
  } else {
    // 纯计算，数据驻留 L1/L2
    const n = 8192;                 // 64 KB，远小于 L2 的 512 KB
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = i;
    const t0 = process.hrtime.bigint();
    let acc = 0;
    const iters = m.iters;
    for (let k = 0; k < iters; k++) {
      for (let i = 0; i < n; i++) acc += a[i] * 1.0000001;
    }
    const t1 = process.hrtime.bigint();
    parentPort.postMessage({ sec: Number(t1 - t0) / 1e9, ops: n * iters });
  }
});
`;

async function run(nThreads, msg) {
  const ws = Array.from({ length: nThreads }, () => new Worker(src, { eval: true }));
  await Promise.all(ws.map((w) => new Promise((r) => w.once('online', r))));
  const t0 = process.hrtime.bigint();
  const rs = await Promise.all(
    ws.map((w) => new Promise((r) => { w.once('message', r); w.postMessage(msg); }))
  );
  const t1 = process.hrtime.bigint();
  const wall = Number(t1 - t0) / 1e9;
  await Promise.all(ws.map((w) => w.terminate()));
  return { rs, wall };
}

console.log('=== memcpy 路径带宽（硬件拷贝上限）===');
for (const nt of [1, 4, 8, 16]) {
  const { rs, wall } = await run(nt, { mode: 'memcpy', mb: 128 });
  const bytes = rs.reduce((s, r) => s + r.bytes, 0);
  console.log(`${String(nt).padStart(2)} 线程: ${(bytes / wall / 1e9).toFixed(1)} GB/s`);
}

console.log('\n=== L1/L2 驻留的计算吞吐（与内存无关）===');
for (const nt of [1, 8]) {
  const { rs, wall } = await run(nt, { mode: 'compute', iters: 6000 });
  const ops = rs.reduce((s, r) => s + r.ops, 0);
  console.log(`${String(nt).padStart(2)} 线程: ${(ops / wall / 1e9).toFixed(1)} G ops/s`);
}

console.log('\n参考：DDR4-3200 双通道理论 51.2 GB/s，实测应 30-38 GB/s');
console.log('      单通道 DDR4-3200 理论 25.6 GB/s，实测应 15-19 GB/s');
