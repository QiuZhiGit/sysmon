// CPU 基准测试：单核 / 多核 / 内存带宽
// 用固定工作量的可复现算法，输出绝对值与相对倍率。
import { Worker } from 'node:worker_threads';
import os from 'node:os';

const CORES = os.cpus().length;

// ---------------- 单核基准：整数 + 浮点 + 分支/内存混合 ----------------

function benchInt(iterations) {
  // 整数运算：整数除法/取模是 x86 上相对慢的操作，能区分微架构
  let h = 2166136261;
  for (let i = 0; i < iterations; i++) {
    h ^= i;
    h = Math.imul(h, 16777619);
    h = (h >>> 13) ^ (h << 7);
    h |= 0;
  }
  return h;
}

function benchFloat(iterations) {
  // 浮点：依赖链上的乘加，测 FMA/流水线延迟
  let x = 1.000001;
  let y = 0.999999;
  for (let i = 0; i < iterations; i++) {
    x = x * 1.0000001 + 0.0000001;
    y = y * 0.9999999 - 0.0000001;
    if (x > 1e10) x = 1.000001;
    if (y < 0) y = 0.999999;
  }
  return x + y;
}

function benchMem(sizeMB) {
  // 顺序读写大数组，测内存带宽（超出 L3 的规模）
  const n = (sizeMB * 1024 * 1024) / 8; // float64 元素数
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = i & 0xffff;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) b[i] = a[i] * 2 + 1;
  const t1 = process.hrtime.bigint();
  const sec = Number(t1 - t0) / 1e9;
  const bytes = n * 8 * 2; // 读 + 写
  return { seconds: sec, gbps: bytes / sec / 1e9 };
}

function timed(fn, arg) {
  const t0 = process.hrtime.bigint();
  const r = fn(arg);
  const t1 = process.hrtime.bigint();
  return { result: r, ms: Number(t1 - t0) / 1e6 };
}

// ---------------- 单核 ----------------
console.log('=== 单核基准 ===');

const INT_ITERS = 80_000_000;
const FLOAT_ITERS = 60_000_000;

// 预热
benchInt(2_000_000);
benchFloat(2_000_000);

const intRuns = [];
const floatRuns = [];
for (let i = 0; i < 3; i++) {
  intRuns.push(timed(benchInt, INT_ITERS).ms);
  floatRuns.push(timed(benchFloat, FLOAT_ITERS).ms);
}

const intBest = Math.min(...intRuns);
const floatBest = Math.min(...floatRuns);
console.log(`整数运算  : ${intBest.toFixed(1)} ms  (${(INT_ITERS / intBest / 1e3).toFixed(1)} M ops/s)`);
console.log(`浮点运算  : ${floatBest.toFixed(1)} ms  (${(FLOAT_ITERS / floatBest / 1e3).toFixed(1)} M ops/s)`);

let intScore = INT_ITERS / intBest / 1000;
let floatScore = FLOAT_ITERS / floatBest / 1000;
console.log(`单核综合  : ${((intScore + floatScore) / 2).toFixed(1)} M ops/s`);

// ---------------- 内存 ----------------
console.log('\n=== 内存带宽 ===');
const small = benchMem(16);   // 贴近 L3 规模
const large = benchMem(256);  // 远超 L3，测主存
console.log(`16 MB  (贴近L3) : ${(small.gbps).toFixed(1)} GB/s  (${small.seconds.toFixed(3)} s)`);
console.log(`256 MB (主存)   : ${(large.gbps).toFixed(1)} GB/s  (${large.seconds.toFixed(3)} s)`);

// ---------------- 多核 ----------------
console.log('\n=== 多核基准 ===');

const workerSrc = `
const { parentPort } = require('worker_threads');
function benchInt(iterations) {
  let h = 2166136261;
  for (let i = 0; i < iterations; i++) {
    h ^= i; h = Math.imul(h, 16777619);
    h = (h >>> 13) ^ (h << 7); h |= 0;
  }
  return h;
}
parentPort.on('message', (m) => {
  const t0 = process.hrtime.bigint();
  benchInt(m.iters);
  const t1 = process.hrtime.bigint();
  parentPort.postMessage(Number(t1 - t0) / 1e6);
});
`;

async function runMulti(nWorkers, iters) {
  const workers = Array.from({ length: nWorkers }, () => new Worker(workerSrc, { eval: true }));
  await Promise.all(workers.map((w) => new Promise((res) => w.once('online', res))));
  const t0 = process.hrtime.bigint();
  const results = await Promise.all(
    workers.map((w) => new Promise((res) => {
      w.once('message', res);
      w.postMessage({ iters });
    }))
  );
  const t1 = process.hrtime.bigint();
  const wall = Number(t1 - t0) / 1e6;
  await Promise.all(workers.map((w) => w.terminate()));
  return { wall, results };
}

const MULTI_ITERS = 20_000_000;
for (const n of [1, 2, 4, 8, CORES]) {
  const { wall } = await runMulti(n, MULTI_ITERS);
  const throughput = (n * MULTI_ITERS) / wall / 1000; // M ops/s 总吞吐
  const scaling = throughput / intScore;
  const eff = (scaling / n) * 100;
  console.log(`${String(n).padStart(2)} 线程: 墙钟 ${wall.toFixed(0).padStart(5)} ms | 总吞吐 ${throughput.toFixed(0).padStart(5)} M ops/s | 加速比 ${scaling.toFixed(2)}x | 并行效率 ${eff.toFixed(0)}%`);
}

console.log('\n=== 汇总 ===');
console.log(JSON.stringify({
  model: os.cpus()[0].model.trim(),
  cores: CORES,
  physicalEstimate: CORES / 2,
  singleCoreMOps: Math.round(((intScore + floatScore) / 2) * 10) / 10,
  memBandwidthGBs: Math.round(large.gbps * 10) / 10,
}, null, 2));
