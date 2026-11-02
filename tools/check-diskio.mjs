// 验证磁盘 I/O 采集能真实反映负载：写入大量数据，观察 % Disk Time 与写速率变化
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const snap = async () => (await fetch('http://127.0.0.1:8090/api/snapshot')).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const before = await snap();
console.log(`基线 : util=${before.hardware.diskIo.util}% queue=${before.hardware.diskIo.queue} ` +
            `read=${before.hardware.diskIo.readMBs}MB/s write=${before.hardware.diskIo.writeMBs}MB/s`);

// 在系统临时目录持续写 6 秒，绕开缓存，确保至少覆盖 3 个采样周期
const tmp = path.join(os.tmpdir(), `sysmon-iotest-${process.pid}.bin`);
const chunk = Buffer.alloc(8 * 1024 * 1024, 7);

(async () => {
  const fd = fs.openSync(tmp, 'w');
  const deadline = Date.now() + 6000;
  let written = 0;
  while (Date.now() < deadline) {
    fs.writeSync(fd, chunk);
    fs.fsyncSync(fd); // 强制落盘，避免只进页缓存
    written += chunk.length;
  }
  fs.closeSync(fd);
  console.log(`已写入 ${(written / 1024 / 1024).toFixed(0)} MB（持续 6 秒，fsync 落盘）`);
})();

await sleep(4000); // 覆盖压力期
const during = await snap();
console.log(`写入中: util=${during.hardware.diskIo.util}% queue=${during.hardware.diskIo.queue} ` +
            `read=${during.hardware.diskIo.readMBs}MB/s write=${during.hardware.diskIo.writeMBs}MB/s`);

await sleep(3000);
const peak = await snap();
console.log(`继续中: util=${peak.hardware.diskIo.util}% queue=${peak.hardware.diskIo.queue} ` +
            `read=${peak.hardware.diskIo.readMBs}MB/s write=${peak.hardware.diskIo.writeMBs}MB/s`);

try { fs.unlinkSync(tmp); } catch (_) {}
await sleep(3000);
const after = await snap();
console.log(`写入后: util=${after.hardware.diskIo.util}% queue=${after.hardware.diskIo.queue} ` +
            `read=${after.hardware.diskIo.readMBs}MB/s write=${after.hardware.diskIo.writeMBs}MB/s`);

const samples = [before, during, peak, after].map((s) => s.hardware.diskIo);
const peakWrite = Math.max(...samples.map((s) => s.writeMBs));
const peakUtil = Math.max(...samples.map((s) => s.util));

const results = [
  ['磁盘 I/O 数据可用', before.hardware.diskIo.available, `available=${before.hardware.diskIo.available}`],
  ['写压力期写速率上升', peakWrite > 1, `峰值 ${peakWrite} MB/s`],
  ['写压力期 util 上升', peakUtil > before.hardware.diskIo.util, `峰值 ${peakUtil}% (基线 ${before.hardware.diskIo.util}%)`],
  ['util 在 0-100 合法范围', samples.every((s) => s.util >= 0 && s.util <= 100), ''],
  ['队列深度非负', samples.every((s) => s.queue >= 0), ''],
];

let pass = 0;
console.log('');
for (const [n, ok, d] of results) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  (${d})`); if (ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
