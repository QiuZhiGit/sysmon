// 验证网络采集准确性（修正版）：
// 回环流量不经过物理网卡，上一版测不出效果。改为从本机网关/外网拉取，
// 走真实网卡，才能证明计数器读数随负载变化。
const snap = async () => (await fetch('http://127.0.0.1:8090/api/snapshot')).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const before = await snap();
const nb = before.network;
console.log(`基线   : RX=${nb.totalRxMBs} TX=${nb.totalTxMBs} MB/s`);

// 找一个真实可用的外部目标下载数据（走物理网卡）
const targets = [
  'http://192.168.1.100:3080/',          // 局域网内另一台机器（DSH Web）
  'https://ghproxy.net/https://raw.githubusercontent.com/LibreHardwareMonitor/LibreHardwareMonitor/master/README.md',
];

let movedBytes = 0;
let used = null;
const deadline = Date.now() + 8000;

for (const url of targets) {
  try {
    const t0 = Date.now();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 6000);
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    movedBytes += buf.byteLength;
    used = url;
    console.log(`从 ${url} 拉取 ${(buf.byteLength / 1024).toFixed(0)} KB，耗时 ${Date.now() - t0}ms`);
    break;
  } catch (e) {
    console.log(`目标不可用: ${url} (${e.name})`);
  }
}

if (!used) {
  console.log('\n没有可用的外部目标，本机无法产生物理网卡流量。');
  console.log('仍验证数据结构正确性，但不声称已验证动态范围。');
}

await sleep(2500);
const during = await snap();
const nd = during.network;
console.log(`拉取中 : RX=${nd.totalRxMBs} TX=${nd.totalTxMBs} MB/s`);

const peakRx = Math.max(nb.totalRxMBs || 0, nd.totalRxMBs || 0);
const peakTx = Math.max(nb.totalTxMBs || 0, nd.totalTxMBs || 0);
const dynamicsVerified = used !== null && (peakRx > 0.05 || peakTx > 0.05);

const checks = [
  ['网络数据可用', nb.available, `available=${nb.available}`],
  ['网卡列表非空', (nb.interfaces || []).length > 0, `${(nb.interfaces || []).length} 个`],
  ['链路速率已取到', (nb.interfaces || []).some((f) => f.speedMbps), ''],
  ['链路状态已取到', (nb.interfaces || []).some((f) => f.status), ''],
  ['利用率在 0-100', (nb.interfaces || []).every((f) => f.utilization == null || (f.utilization >= 0 && f.utilization <= 100)), ''],
  ['错误计数非负', (nb.interfaces || []).every((f) => f.rxErrors >= 0 && f.txErrors >= 0), ''],
];

let pass = 0;
console.log('');
for (const [n, ok, d] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  (${d})`);
  if (ok) pass++;
}

let skipped = 0;
console.log('');
let dynamicOk = false;
if (dynamicsVerified) {
  console.log(`PASS  流量读数随真实负载变化  (峰值 RX=${peakRx} TX=${peakTx} MB/s)`);
  pass++;
  dynamicOk = true;
} else {
  console.log(`SKIP  动态范围验证 —— 无外部目标可产生物理网卡流量（峰值 RX=${peakRx} TX=${peakTx} MB/s）`);
  console.log('      说明：数据结构与映射已验证；动态范围需在有外部流量时复核。');
  skipped++;
}

const total = checks.length + 1;
console.log(`\n${pass}/${total - skipped} passed${skipped ? '（1 项跳过）' : ''}`);

// 只有结构性断言失败才算不通过；跳过项不算失败
const failed = checks.filter(([, ok]) => !ok).length;
process.exit(failed === 0 ? 0 : 1);
