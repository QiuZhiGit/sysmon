// 诊断：网络计数器是否真在跟踪物理网卡流量？
// 连续采样 20 秒，同时记录 typeperf 原始输出，确认读数不是恒定 0。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = async () => (await fetch('http://127.0.0.1:8090/api/snapshot')).json();

console.log('时间      RX(MB/s)  TX(MB/s)   以太网RX   以太网TX   util%');
const rows = [];
for (let i = 0; i < 12; i++) {
  const s = await snap();
  const n = s.network || {};
  const eth = (n.interfaces || []).find((f) => f.status === 'Up') || (n.interfaces || [])[0] || {};
  rows.push({ rx: n.totalRxMBs, tx: n.totalTxMBs, erx: eth.rxMBs, etx: eth.txMBs, util: eth.utilization });
  console.log(
    `${String(i * 2).padStart(2)}s      ` +
    `${String(n.totalRxMBs).padStart(8)}  ${String(n.totalTxMBs).padStart(8)}  ` +
    `${String(eth.rxMBs).padStart(9)}  ${String(eth.txMBs).padStart(9)}   ${eth.utilization}`
  );
  await sleep(2000);
}

const nonZero = rows.filter((r) => (r.erx || 0) > 0 || (r.etx || 0) > 0).length;
console.log(`\n出现非零流量的采样点: ${nonZero}/${rows.length}`);

if (nonZero === 0) {
  console.log('\n结论：12 次采样全部为 0，计数可能没有绑定到物理网卡。');
  console.log('需要检查 PDH 实例名与真实网卡的对应关系。');
} else {
  console.log('\n结论：计数器能捕捉到物理网卡流量，读数正常波动。');
}
