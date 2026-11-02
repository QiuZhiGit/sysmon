// 硬件 / 网络 / 进程 区块渲染验收
// 用最小 DOM 桩执行前端脚本，注入不同数据，检查渲染结果。
// 温度模块已从页面移除，故此处不再覆盖 thermal 分支。
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((b) => b[1]).join('\n');

class El {
  constructor(tag, id) {
    this.tagName = tag; this.id = id || '';
    this.children = []; this.style = {}; this._text = ''; this._html = '';
    this.className = ''; this._classes = new Set();
    const self = this;
    this.classList = {
      add(c) { self._classes.add(c); },
      remove(c) { self._classes.delete(c); },
      contains(c) { return self._classes.has(c); },
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  querySelector() { return null; }
  getBoundingClientRect() { return { width: 640, height: 150 }; }
  getContext() {
    const noop = () => {};
    return {
      setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
      closePath: noop, fill: noop, stroke: noop, arc: noop, fillText: noop,
      createLinearGradient: () => ({ addColorStop: noop }),
      set fillStyle(v) {}, get fillStyle() { return ''; },
      set strokeStyle(v) {}, get strokeStyle() { return ''; },
      set lineWidth(v) {}, set lineJoin(v) {}, set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
    };
  }
}

const reg = new Map();
const getEl = (id) => { if (!reg.has(id)) reg.set(id, new El('div', id)); return reg.get(id); };

globalThis.document = { getElementById: getEl, querySelector: () => null, addEventListener: () => {}, hidden: false };
globalThis.window = { devicePixelRatio: 1, addEventListener: () => {} };
globalThis.EventSource = class { close() {} };
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
globalThis.setInterval = () => 0;
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};

const api = new Function(
  js + '\n;return { renderSnapshot, renderDiskIo, renderEvents, renderNetwork, renderProcesses, dioSeries, netRxSeries, netTxSeries };'
)();

const base = {
  ts: Date.now(),
  cpu: { usage: 20, perCore: [10, 20], cores: 2 },
  mem: { usage: 50, usedGB: 8, totalGB: 15.9, freeGB: 7.9, serviceRssMB: 40 },
  disks: [{ mount: 'C:', usage: 36, usedGB: 143, totalGB: 396, freeGB: 253 }],
  uptime: { systemSec: 1000, serviceSec: 100 },
};

const groups = [];
function group(name, fn) {
  const checks = [];
  const check = (n, ok, d) => checks.push({ n, ok: !!ok, d });
  fn(check);
  groups.push({ name, checks });
}

// ============ 磁盘 I/O 不可用 ============
group('磁盘 I/O 不可用', (check) => {
  api.renderSnapshot({
    ...base,
    hardware: {
      diskIo: { available: false, pending: false, error: 'EPERM 进程创建受限' },
      events: { available: true, pending: false, windowHours: 168, items: [], total: 0 },
    },
  });
  check('显示具体原因', getEl('dio-sub').textContent.includes('EPERM'), getEl('dio-sub').textContent);
  check('不显示假数字', getEl('dio-val').textContent === '--', getEl('dio-val').textContent);
  check('无告警显示通过提示', getEl('events-body').innerHTML.includes('未发现硬件或稳定性告警'), '');
});

// ============ 磁盘 I/O 可用 + 告警分级 ============
group('磁盘 I/O 与告警', (check) => {
  api.renderSnapshot({
    ...base,
    hardware: {
      diskIo: { available: true, pending: false, util: 87.5, queue: 2.4, readMBs: 12.34, writeMBs: 5.67, at: Date.now() },
      events: {
        available: true, pending: false, windowHours: 168, total: 3,
        items: [
          { key: 'hardware-error', label: '硬件错误 (WHEA)', critical: true, notice: false, count: 2, lastTime: '2026-11-01 10:00:00' },
          { key: 'unexpected-shutdown', label: '非正常关机 (Kernel-Power 41)', critical: false, notice: true, count: 1, lastTime: '2026-10-30 08:29:20' },
        ],
      },
    },
  });
  check('利用率数值正确', getEl('dio-val').textContent === '87.5', getEl('dio-val').textContent);
  check('高负载标红/黄', getEl('dio-bar').className.includes('fill-bad') || getEl('dio-bar').className.includes('fill-warn'), getEl('dio-bar').className);
  check('队列深度显示', getEl('dio-queue').innerHTML.includes('2.40'), '');
  check('读写速率显示', getEl('dio-read').innerHTML.includes('12.34') && getEl('dio-write').innerHTML.includes('5.67'), '');
  check('严重告警标 crit', getEl('events-body').innerHTML.includes('alert-row crit'), '');
  check('提示级告警标 notice', getEl('events-body').innerHTML.includes('alert-row notice'), '');
  check('告警计数正确', getEl('events-body').innerHTML.includes('共 3 条'), '');
  check('磁盘I/O曲线已累积', api.dioSeries.length === 1, `${api.dioSeries.length} 点`);
});

// ============ 网络监控 ============
group('网络监控', (check) => {
  api.renderSnapshot({
    ...base,
    network: {
      available: true, pending: false, totalRxMBs: 12.34, totalTxMBs: 5.67, at: Date.now(),
      interfaces: [
        { name: '以太网', description: 'Realtek PCIe GbE', status: 'Up', speedMbps: 1000,
          rxMBs: 12.34, txMBs: 5.67, utilization: 88.5, rxErrors: 3, txErrors: 0, rxDiscarded: 1, txDiscarded: 0 },
        { name: 'WLAN', description: 'USB WiFi', status: 'Disconnected', speedMbps: null,
          rxMBs: 0, txMBs: 0, utilization: null, rxErrors: 0, txErrors: 0, rxDiscarded: 0, txDiscarded: 0 },
      ],
    },
  });
  check('接收速率渲染', getEl('net-rx').innerHTML.includes('12.34'), getEl('net-rx').innerHTML);
  check('发送速率渲染', getEl('net-tx').innerHTML.includes('5.67'), '');
  check('网卡行数正确', (getEl('net-ifaces').innerHTML.match(/<tr>/g) || []).length === 2, '');
  check('1 Gbps 换算', getEl('net-ifaces').innerHTML.includes('1 Gbps'), '');
  check('高利用率标红', getEl('net-ifaces').innerHTML.includes('crit-text'), '');
  check('断连网卡显示 Disconnected', getEl('net-ifaces').innerHTML.includes('Disconnected'), '');
  check('无链路速率显示占位', getEl('net-ifaces').innerHTML.includes('—'), '');
  check('错误/丢弃计数渲染', getEl('net-ifaces').innerHTML.includes('3 / 1'), '');
  check('网络曲线已累积', api.netRxSeries.length === 1 && api.netTxSeries.length === 1, '');

  api.renderSnapshot({
    ...base,
    network: { available: false, pending: false, error: 'typeperf 退出 (code 1)', interfaces: [] },
  });
  check('不可用时显示原因', getEl('net-ifaces').innerHTML.includes('typeperf 退出'), '');
  check('不可用时数值占位', getEl('net-rx').innerHTML.includes('--'), '');
});

// ============ 进程内存 TOP10 ============
group('进程内存 TOP10', (check) => {
  api.renderProcesses({
    available: true, pending: false,
    top: [
      { name: 'WorkBuddy', count: 8, privateMB: 2074.3, workingMB: 964, pctOfUsed: 35.54, pctOfTotal: 12.75, maxPid: 18596 },
      { name: 'node', count: 8, privateMB: 1067.3, workingMB: 524, pctOfUsed: 18.29, pctOfTotal: 6.71, maxPid: 20884 },
      { name: 'svchost', count: 100, privateMB: 573.5, workingMB: 528, pctOfUsed: 9.83, pctOfTotal: 3.52, maxPid: 22308 },
      { name: 'mytool', count: 1, privateMB: 148.8, workingMB: 17, pctOfUsed: 2.55, pctOfTotal: 0.91, maxPid: 5048 },
    ],
    usedMB: 5836, totalMB: 15900, usedPercent: 35.9,
    processCount: 273, groupCount: 105, at: Date.now(),
  });
  const h = getEl('proc-body').innerHTML;
  check('排名渲染', h.includes('WorkBuddy') && h.includes('node'), '');
  check('多实例显示 ×N', h.includes('×8') && h.includes('×100'), '');
  check('GB/MB 换算', h.includes('2.03 GB') || h.includes('2025 MB'), '');
  check('占比按已用内存', h.includes('35.5%'), '');
  check('含进程总数', h.includes('273'), '');
  check('注明私有字节口径', h.includes('私有字节'), '');
  check('TOP1 条形占满', h.includes('width:100.0%'), '');
  check('高占比标红', h.includes('#f85149'), '');

  api.renderProcesses({ available: false, pending: false, error: 'PowerShell 超时' });
  check('不可用时显示原因', getEl('proc-body').innerHTML.includes('PowerShell 超时'), '');

  api.renderProcesses({ available: false, pending: false, disabled: true, error: 'x' });
  check('禁用态显示已关闭', getEl('proc-ts').textContent.includes('已关闭'), getEl('proc-ts').textContent);
});

// ============ 汇总 ============
let pass = 0;
let total = 0;
for (const g of groups) {
  console.log(`\n--- ${g.name} ---`);
  for (const c of g.checks) {
    total++;
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.n}${c.ok ? '' : ' -> ' + c.d}`);
    if (c.ok) pass++;
  }
}
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
