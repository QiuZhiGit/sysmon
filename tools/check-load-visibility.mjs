// 验证监控能正确反映 CPU 满载：跑 16 线程压力，同时读监控快照
const snap = async () => (await fetch('http://127.0.0.1:8090/api/snapshot')).json();
const { Worker } = await import('node:worker_threads');

const src = `
const { parentPort } = require('worker_threads');
parentPort.on('message', (ms) => {
  const end = Date.now() + ms;
  let x = 1.000001;
  while (Date.now() < end) { for (let i = 0; i < 50000; i++) x = x * 1.0000001 + 0.0000001; }
  parentPort.postMessage(x);
});
`;

const before = await snap();
console.log(`基准前 CPU: ${before.cpu.usage}%`);

const ws = Array.from({ length: 16 }, () => new Worker(src, { eval: true }));
await Promise.all(ws.map((w) => new Promise((r) => w.once('online', r))));
const running = ws.map((w) => new Promise((r) => { w.once('message', r); w.postMessage(4000); }));

// 压力进行中读取
await new Promise((r) => setTimeout(r, 2500));
const during = await snap();
console.log(`满载时 CPU: ${during.cpu.usage}%`);
console.log(`满载时每核: ${JSON.stringify(during.cpu.perCore.map((v) => Math.round(v)))}`);
const loadedCores = during.cpu.perCore.filter((v) => v > 50).length;
console.log(`高负载核数(>50%): ${loadedCores} / ${during.cpu.perCore.length}`);

await Promise.all(running);
await Promise.all(ws.map((w) => w.terminate()));

await new Promise((r) => setTimeout(r, 2500));
const after = await snap();
console.log(`压力解除后 CPU: ${after.cpu.usage}%`);

const ok = during.cpu.usage > before.cpu.usage + 30;
console.log(ok ? '\nPASS 监控准确反映了满载情况' : '\nFAIL 监控未反映满载');
process.exit(ok ? 0 : 1);
