// 不依赖浏览器的渲染逻辑验收：用最小 DOM 桩执行前端脚本，
// 把真实 /api/snapshot 数据喂进去，检查文本/样式/表格是否按预期生成。
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((b) => b[1]).join('\n');

// ---- 最小 DOM 桩
class El {
  constructor(tag, id) {
    this.tagName = tag; this.id = id || '';
    this.children = []; this.style = {}; this._text = ''; this._html = '';
    this.className = '';
    const self = this;
    this.classList = {
      add(c) { const s = new Set(self.className.split(' ').filter(Boolean)); s.add(c); self.className = [...s].join(' '); },
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this._html = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    // 极简解析：只统计新插入的元素数量，供断言使用
    this.children = [...String(v).matchAll(/<div class="core"/g)].map((_, i) => new El('div', `core-${i}`));
  }
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

const registry = new Map();
function getEl(id) {
  if (!registry.has(id)) registry.set(id, new El('div', id));
  return registry.get(id);
}

globalThis.document = {
  getElementById: getEl,
  querySelector: () => null,
  addEventListener: () => {},
  hidden: false,
};
globalThis.window = { devicePixelRatio: 1, addEventListener: () => {} };
globalThis.EventSource = class { constructor() { this.onopen = null; this.onmessage = null; this.onerror = null; } close() {} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ hostname: 'TESTHOST', cpuModel: 'TestCPU @ 3GHz', cores: 4, totalMemGB: 16, platform: 'win32', arch: 'x64', port: 8090, addresses: [{ iface: 'eth0', address: '192.168.1.5' }] }) });
globalThis.setInterval = () => 0;
globalThis.setTimeout = (fn) => 0;
globalThis.clearTimeout = () => {};

// ---- 执行前端脚本，并把 renderSnapshot 暴露出来
const factory = new Function(
  js + '\n;return { renderSnapshot, renderHost, drawAll, cpuSeries, get es() { return es; } };'
);
const api = factory();

// ---- 真实数据
const snap = {
  ts: Date.now(),
  cpu: { usage: 42.5, perCore: [10.2, 88.8, 50.0, 97.3], cores: 4 },
  mem: { usage: 63.2, usedGB: 10.1, totalGB: 15.9, freeGB: 5.8, serviceRssMB: 47 },
  disks: [
    { mount: 'C:', usage: 36.1, usedGB: 143.3, totalGB: 396.6, freeGB: 253.3 },
    { mount: 'D:', usage: 91.4, usedGB: 851.4, totalGB: 931.5, freeGB: 80.1 },
  ],
  uptime: { systemSec: 254007, serviceSec: 125 },
};

const checks = [];
const check = (name, cond, detail) => checks.push({ name, ok: !!cond, detail });

api.renderHost({ hostname: 'WIN-TEST', cpuModel: 'TestCPU', cores: 16, totalMemGB: 15.9, platform: 'win32', arch: 'x64', port: 8090, addresses: [{ iface: 'eth', address: '192.168.1.5' }] });
check('host line 渲染', getEl('hostline').innerHTML.includes('WIN-TEST'), getEl('hostline').innerHTML.slice(0, 60));
check('访问地址列出局域网 IP', getEl('accessurls').textContent.includes('192.168.1.5:8090'), getEl('accessurls').textContent);

for (let i = 0; i < 3; i++) api.renderSnapshot({ ...snap, ts: snap.ts + i * 1000, cpu: { ...snap.cpu, usage: 40 + i } });

check('CPU 数值 = 最后一条', getEl('cpuval').textContent === '42.0', getEl('cpuval').textContent);
check('CPU 进度条宽度', getEl('cpubar').style.width === '42.0%', String(getEl('cpubar').style.width));
check('内存数值', getEl('memval').textContent === '63.2', getEl('memval').textContent);
check('内存副标题 已用/总量', getEl('memsub').textContent === '10.1 GB / 15.9 GB', getEl('memsub').textContent);
check('内存进度条', getEl('membar').style.width === '63.2%', String(getEl('membar').style.width));
check('核心数标签', getEl('cpucores').textContent === '4 核', getEl('cpucores').textContent);
check('磁盘表含 C:/D: 两行', (getEl('disks').innerHTML.match(/<tr>/g) || []).length === 2, `${(getEl('disks').innerHTML.match(/<tr>/g) || []).length} 行`);
check('高占用磁盘标红', getEl('disks').innerHTML.includes('fill-bad'), '91.4% 应触发 fill-bad');
check('运行信息含服务运行时长', getEl('sysinfo').innerHTML.includes('2分 5秒'), getEl('sysinfo').innerHTML.replace(/\s+/g, ' ').slice(0, 120));
check('曲线数据已累积', api.cpuSeries.length === 3, `${api.cpuSeries.length} 点`);

let pass = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  -> ' + c.detail}`);
  if (c.ok) pass++;
}
console.log(`\n${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
