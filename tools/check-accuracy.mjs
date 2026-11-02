// 采样准确性验证：用 worker_threads 制造可控 CPU 压力，检查监控读数是否随之变化
import { Worker } from 'node:worker_threads';

const snap = async () => (await fetch('http://127.0.0.1:8090/api/snapshot')).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const spinSrc = `
const { parentPort } = require('worker_threads');
const end = Date.now() + 6000;
while (Date.now() < end) { Math.sqrt(Math.random()); }
parentPort.postMessage('done');
`;

const idle = await snap();
console.log(`基线:   cpu=${idle.cpu.usage}%  mem=${idle.mem.usage}%  perCore=${idle.cpu.perCore.length}`);

const N = 4; // 16 核机器上占 4 核 -> 整体约 +25%
const workers = Array.from({ length: N }, () => new Worker(spinSrc, { eval: true }));

await sleep(3000); // 等采样窗口覆盖到压力期
const hot = await snap();
console.log(`加压中: cpu=${hot.cpu.usage}%  perCore=${JSON.stringify(hot.cpu.perCore.map((v) => Math.round(v)))}`);

await Promise.all(workers.map((w) => new Promise((r) => { w.on('message', r); w.on('exit', r); w.on('error', r); })));
await sleep(2000);

const cool = await snap();
console.log(`恢复后: cpu=${cool.cpu.usage}%  mem=${cool.mem.usage}%`);

const expectRise = N / idle.cpu.perCore.length * 100; // 预期增幅
const okCpu = hot.cpu.usage > idle.cpu.usage + 10;
const okRecover = cool.cpu.usage < hot.cpu.usage - 5;
const okCores = hot.cpu.perCore.length === idle.cpu.perCore.length && hot.cpu.perCore.length > 0;

const checks = [
  [`CPU 随压力上升`, okCpu, `${idle.cpu.usage}% -> ${hot.cpu.usage}%（预期至少 +${expectRise.toFixed(0)}%）`],
  [`压力解除后回落`, okRecover, `${hot.cpu.usage}% -> ${cool.cpu.usage}%`],
  [`每核数据完整`, okCores, `${hot.cpu.perCore.length} 核`],
  [`内存读数合理`, idle.mem.usage > 1 && idle.mem.usage < 99, `${idle.mem.usage}%`],
];
let pass = 0;
console.log('');
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
