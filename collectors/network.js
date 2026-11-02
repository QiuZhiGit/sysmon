'use strict';

/**
 * 网络监控采集器
 *
 * 数据来源分两部分，各自独立降级：
 *   1) 流量与错包 —— 常驻一个 typeperf 读 Network Interface 计数器（1 次进程，非每轮 spawn）
 *   2) 网卡元信息  —— 定时调用 PowerShell 取链路速率/状态（用于算利用率百分比）
 *
 * 说明：Bytes Received/sec 等是 PDH 速率计数器，typeperf 直接给每秒字节数，无需自己差分；
 *       而 Packets Received Errors / Discarded 是累计值，代表开机以来的累计计数。
 *
 * 任何一块失败都以 { available:false, error } 暴露，不抛异常打断主采样。
 */

const { spawn } = require('child_process');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const SYS_ROOT = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
const SYSTEM32 = path.join(SYS_ROOT, 'System32');
const TPERF_EXE = path.join(SYSTEM32, 'typeperf.exe');
const POWERSHELL_EXE = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCRIPTS_DIR = path.join(__dirname, 'scripts');

const OBJECT_NAME = 'Network Interface';

/** 请求的计数器，顺序决定 CSV 列的分组顺序（counter-major） */
const COUNTERS = [
  'Bytes Received/sec',
  'Bytes Sent/sec',
  'Packets Received Errors',
  'Packets Outbound Errors',
  'Packets Received Discarded',
  'Packets Outbound Discarded',
];

const round2 = (v) => Math.round(v * 100) / 100;
const toMB = (bytes) => bytes / 1024 / 1024;

/** 从可能带杂音的 stdout 里抠出第一个完整 JSON 对象 */
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * 解析 typeperf 表头里的一条计数器路径。
 * 形如：\\HOST\Network Interface(Realtek PCIe GbE)\Bytes Received/sec
 * 实例名本身可能含括号，所以取最后一个 ")\\" 作为分隔。
 */
function parseCounterPath(raw) {
  const marker = `\\${OBJECT_NAME}(`;
  const i = raw.indexOf(marker);
  if (i < 0) return null;
  const rest = raw.slice(i + marker.length);
  const j = rest.lastIndexOf(')\\');
  if (j < 0) return null;
  return {
    instance: rest.slice(0, j),
    counter: rest.slice(j + 2).trim(),
  };
}

class NetworkCollector {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger || (() => {});
    this.stopped = false;
    this.timers = [];
    this.procs = new Set();

    this.colProc = null;
    this.retryTimer = null;
    this.backoff = 2000;

    /** 列映射：columnIndex -> { instance, counter } */
    this.columns = null;
    /** 网卡元信息：name -> { speedMbps, status, description } */
    this.adapters = new Map();
    this.adapterBusy = false;
    this.adapterAt = 0;

    this.network = {
      available: false,
      pending: true,
      interfaces: [],
      totalRxMBs: 0,
      totalTxMBs: 0,
      at: 0,
      error: null,
    };
  }

  // ------------------------------------------------------------ 生命周期

  start() {
    if (!IS_WIN) {
      this.network.pending = false;
      this.network.error = '仅支持 Windows';
      return;
    }
    if (this.cfg.enableNetwork === false) {
      this.network.pending = false;
      this.network.error = '已在配置中禁用 (enableNetwork=false)';
      return;
    }

    this.startCounter();
    this.pollAdapters(); // 首次立即取一次链路速率

    const metaMs = Math.max(60000, Number(this.cfg.networkMetaIntervalMs) || 300000);
    this.timers.push(setInterval(() => this.pollAdapters(), metaMs));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.colProc) {
      try { this.colProc.kill(); } catch (_) {}
      this.colProc = null;
    }
    for (const p of this.procs) {
      try { p.kill(); } catch (_) {}
    }
    this.procs.clear();
  }

  // ------------------------------------------------------------ 流量计数器

  startCounter() {
    if (this.stopped) return;

    const si = Math.max(1, Number(this.cfg.networkIntervalSec) || 2);
    const args = ['-si', String(si)];
    for (const c of COUNTERS) args.push(`\\${OBJECT_NAME}(*)\\${c}`);

    let child;
    try {
      child = spawn(TPERF_EXE, args, { windowsHide: true });
    } catch (err) {
      this.onFailure(err);
      return;
    }
    this.colProc = child;
    let stderr = '';
    let buf = '';

    child.on('error', (err) => this.onFailure(err));
    child.stderr.on('data', (d) => {
      if (stderr.length < 2000) stderr += d.toString('utf8');
    });

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('"')) continue;
        const parts = t.split('","').map((s) => s.replace(/^"+|"+$/g, ''));

        // 表头行：第一列是 (PDH-CSV 4.0)，后面是计数器路径
        if (parts[0] && parts[0].startsWith('(PDH-CSV')) {
          this.columns = parts.slice(1).map(parseCounterPath);
          this.backoff = 2000;
          continue;
        }

        // 数据行：第一列时间戳，其余为数值
        if (!this.columns) continue;
        const nums = parts.slice(1).map(Number);
        if (nums.length < 1 || nums.some((n) => !Number.isFinite(n))) continue;

        this.network = this.buildSnapshot(nums);
        this.backoff = 2000;
      }
    });

    child.on('close', (code) => {
      if (this.stopped) return;
      this.colProc = null;
      this.network.available = false;
      this.network.error = `typeperf 退出 (code ${code})${stderr ? '：' + stderr.trim().slice(0, 160) : ''}`;
      this.scheduleRetry();
    });
  }

  /** 把一行数值按列映射聚合成每网卡数据 */
  buildSnapshot(nums) {
    const byInstance = new Map();

    for (let i = 0; i < this.columns.length && i < nums.length; i++) {
      const col = this.columns[i];
      if (!col) continue;
      const inst = col.instance;
      // _Total 是 PDH 自己合成的汇总，这里自己算，避免重复计数
      if (inst === '_Total') continue;

      let e = byInstance.get(inst);
      if (!e) {
        e = {
          name: inst,
          rxBps: 0, txBps: 0,
          rxErrors: 0, txErrors: 0,
          rxDiscarded: 0, txDiscarded: 0,
        };
        byInstance.set(inst, e);
      }

      const v = nums[i];
      switch (col.counter) {
        case 'Bytes Received/sec': e.rxBps = v; break;
        case 'Bytes Sent/sec': e.txBps = v; break;
        case 'Packets Received Errors': e.rxErrors = v; break;
        case 'Packets Outbound Errors': e.txErrors = v; break;
        case 'Packets Received Discarded': e.rxDiscarded = v; break;
        case 'Packets Outbound Discarded': e.txDiscarded = v; break;
        default: break;
      }
    }

    let totalRx = 0;
    let totalTx = 0;

    const interfaces = [];
    for (const e of byInstance.values()) {
      const meta = this.adapters.get(e.name);
      const speedMbps = meta && Number.isFinite(meta.speedMbps) && meta.speedMbps > 0 ? meta.speedMbps : null;

      let utilization = null;
      if (speedMbps) {
        const bitsPerSec = (e.rxBps + e.txBps) * 8;
        utilization = round2((bitsPerSec / (speedMbps * 1e6)) * 100);
        if (utilization < 0) utilization = 0;
      }

      totalRx += e.rxBps;
      totalTx += e.txBps;

      interfaces.push({
        // e.name 是 PDH 实例名（通常是网卡描述）；友好名对用户更友好，有就用
        name: (meta && meta.displayName) || e.name,
        pdhInstance: e.name,
        description: meta ? meta.description : null,
        status: meta ? meta.status : null,
        speedMbps,
        rxMBs: round2(toMB(e.rxBps)),
        txMBs: round2(toMB(e.txBps)),
        utilization,
        rxErrors: Math.round(e.rxErrors),
        txErrors: Math.round(e.txErrors),
        rxDiscarded: Math.round(e.rxDiscarded),
        txDiscarded: Math.round(e.txDiscarded),
      });
    }

    // 有流量的排前面，其次按名字
    interfaces.sort((a, b) => (b.rxMBs + b.txMBs) - (a.rxMBs + a.txMBs) || a.name.localeCompare(b.name));

    return {
      available: true,
      pending: false,
      interfaces,
      totalRxMBs: round2(toMB(totalRx)),
      totalTxMBs: round2(toMB(totalTx)),
      at: Date.now(),
      error: null,
    };
  }

  onFailure(err) {
    this.colProc = null;
    this.network.pending = false;
    this.network.available = false;
    const code = err && (err.code || err.message);
    this.network.error =
      code === 'EPERM'
        ? '无法启动 typeperf（EPERM，进程创建被沙箱限制；以系统服务方式运行即可）'
        : code === 'ENOENT'
        ? `找不到 typeperf：${TPERF_EXE}`
        : `typeperf 启动失败：${code}`;
    this.scheduleRetry();
  }

  scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 120000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.startCounter();
    }, delay);
  }

  // ------------------------------------------------------------ 网卡元信息

  async pollAdapters() {
    if (this.stopped || this.adapterBusy) return;
    this.adapterBusy = true;
    try {
      const out = await this.runPowershell(path.join(SCRIPTS_DIR, 'net-adapters.ps1'), [], 20000);
      const data = extractJson(out);
      if (!data || !Array.isArray(data.adapters)) throw new Error('无法解析 PowerShell 输出');

      const next = new Map();
      for (const a of data.adapters) {
        if (!a) continue;
        const friendly = a.name ? String(a.name) : null;
        const desc = a.description ? String(a.description) : null;
        const meta = {
          displayName: friendly,
          description: desc,
          status: a.status ? String(a.status) : null,
          speedMbps: Number.isFinite(Number(a.speedMbps)) && Number(a.speedMbps) > 0 ? Number(a.speedMbps) : null,
        };
        // 关键：PDH 的 Network Interface 实例名用的是「描述」（如 Realtek PCIe GbE），
        // 而 Get-NetAdapter 的 Name 是友好名（如「以太网」）。两个键都要能命中。
        if (friendly) next.set(friendly, meta);
        if (desc) next.set(desc, meta);
      }
      this.adapters = next;
      this.adapterAt = Date.now();
      this.adapterError = null;
    } catch (err) {
      // 元信息失败不影响流量数据，只是利用率算不出来
      this.adapterError = err && err.code === 'EPERM' ? 'EPERM：无法调用 PowerShell' : (err.message || String(err));
    } finally {
      this.adapterBusy = false;
    }
  }

  runPowershell(scriptFile, extraArgs = [], timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(
          POWERSHELL_EXE,
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, ...extraArgs],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        );
      } catch (err) {
        return reject(err);
      }
      this.procs.add(child);

      let out = '';
      let errOut = '';
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`超时 ${timeoutMs}ms`)), timeoutMs);

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.procs.delete(child);
        try { child.kill(); } catch (_) {}
        if (err) reject(err);
        else resolve(value);
      };

      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { if (errOut.length < 4000) errOut += d.toString('utf8'); });
      child.on('error', (e) => finish(e));
      child.on('close', (code) => {
        if (code === 0) finish(null, out);
        else finish(new Error(`exit ${code}${errOut ? '：' + errOut.trim().slice(0, 200) : ''}`));
      });
    });
  }

  // ------------------------------------------------------------ 对外快照

  snapshot() {
    const base = { ...this.network };
    if (this.adapterError) base.adapterError = this.adapterError;
    return base;
  }
}

module.exports = { NetworkCollector, COUNTERS, parseCounterPath };
