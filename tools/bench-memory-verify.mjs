// 内存带宽复核：用三种互相独立的方法交叉验证，避免单一测量方法出错
import fs from 'node:fs';

function timeIt(fn, label) {
  // 预热，让 JIT 完成编译
  fn(1);
  const t0 = process.hrtime.bigint();
  const r = fn(3);
  const t1 = process.hrtime.bigint();
  const sec = Number(t1 - t0) / 1e9 / 3;
  console.log(`  ${label.padEnd(38)} ${(r / sec / 1e9).toFixed(2)} GB/s   (${(sec * 1000).toFixed(1)} ms/次)`);
  return r / sec / 1e9;
}

const MB = 256;
const N = (MB * 1024 * 1024) / 8; // float64 个数

console.log(`=== 方法1：Float64Array 顺序读（${MB} MB）===`);
const arr = new Float64Array(N);
for (let i = 0; i < N; i++) arr[i] = i & 0xffff;
timeIt(() => {
  let s = 0;
  for (let i = 0; i < N; i++) s += arr[i];
  return N * 8; // 只计读
}, '顺序读 sum');

console.log(`\n=== 方法2：Buffer.copy（memcpy，Windows 原生路径）===`);
const bufA = Buffer.allocUnsafe(MB * 1024 * 1024);
const bufB = Buffer.allocUnsafe(MB * 1024 * 1024);
bufA.fill(0x5a);
timeIt(() => {
  bufB.set(bufA);
  return bufA.length * 2; // 读 + 写
}, 'Buffer.copy 256MB');

console.log(`\n=== 方法3：Uint8Array 逐字节写（对照组，受循环开销限制）===`);
const u8 = new Uint8Array(MB * 1024 * 1024);
timeIt(() => {
  for (let i = 0; i < u8.length; i++) u8[i] = i & 0xff;
  return u8.length;
}, '逐字节写（应明显低于前两者）');

console.log(`\n=== 方法4：多线程 memcpy 叠加（看是否线性增长）===`);
import('node:worker_threads').then(async ({ Worker }) => {
  const src = `
  const { parentPort } = require('worker_threads');
  parentPort.on('message', (mb) => {
    const a = Buffer.allocUnsafe(mb * 1024 * 1024);
    const b = Buffer.allocUnsafe(mb * 1024 * 1024);
    a.fill(1);
    b.set(a); // 预热
    const t0 = process.hrtime.bigint();
    for (let k = 0; k < 3; k++) b.set(a);
    const t1 = process.hrtime.bigint();
    parentPort.postMessage({ sec: Number(t1 - t0) / 1e9 / 3, bytes: mb * 1024 * 1024 * 2 });
  });
  `;
  for (const nt of [1, 4, 8]) {
    const ws = Array.from({ length: nt }, () => new Worker(src, { eval: true }));
    await Promise.all(ws.map((w) => new Promise((r) => w.once('online', r))));
    const t0 = process.hrtime.bigint();
    const rs = await Promise.all(ws.map((w) => new Promise((r) => { w.once('message', r); w.postMessage(64); })));
    const t1 = process.hrtime.bigint();
    const wall = Number(t1 - t0) / 1e9;
    const bytes = rs.reduce((s, r) => s + r.bytes / r.sec * r.sec, 0);
    // 每个 worker 每秒搬运的字节数相加
    const perSec = rs.reduce((s, r) => s + r.bytes / r.sec, 0);
    console.log(`  ${String(nt).padStart(2)} 线程合计: ${(perSec / 1e9).toFixed(2)} GB/s`);
    await Promise.all(ws.map((w) => w.terminate()));
  }

  console.log('\n=== 判定 ===');
  console.log('  单线程顺序读通常应为 8-15 GB/s（现代 x86）');
  console.log('  memcpy 应考虑读写合计，DDR4-3200 双通道应 30-38 GB/s');
});
