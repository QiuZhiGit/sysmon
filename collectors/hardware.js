'use strict';

/**
 * 硬件指标采集器
 *
 * 三块数据，各自独立降级——任何一块取不到都不影响其它块和主监控：
 *   1) 磁盘 I/O      —— 常驻 typeperf 进程流式读取（1 次进程，非每轮 spawn）
 *   2) CPU 温度/风扇  —— 定时调用 PowerShell，依次尝试 ACPI / LibreHardwareMonitor / OpenHardwareMonitor
 *   3) 硬件告警巡检   —— 定时查事件日志（非正常关机、蓝屏、WHEA、磁盘/文件系统错误）
 *
 * 设计约束：不引入任何第三方依赖，所有失败都以 { available:false, error } 形式暴露，
 * 绝不抛异常打断主采样循环。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';
const SYS_ROOT = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
const SYSTEM32 = path.join(SYS_ROOT, 'System32');
const TPERF_EXE = path.join(SYSTEM32, 'typeperf.exe');
const POWERSHELL_EXE = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCRIPTS_DIR = path.join(__dirname, 'scripts');
/** LibreHardwareMonitorLib 的本地副本（若不存在则跳过该数据源） */
const LHM_LIB_DIR = path.join(__dirname, '..', 'tools', 'lhm');

/** 事件 key -> 中文名（PowerShell 只输出 ASCII key，避免编码问题） */
const EVENT_LABELS = {
  'unexpected-shutdown': '非正常关机 (Kernel-Power 41)',
  'unexpected-shutdown-evlog': '意外关机记录 (6008)',
  bugcheck: '蓝屏 (BugCheck 1001)',
  'hardware-error': '硬件错误 (WHEA)',
  'disk-error': '磁盘错误',
  'ntfs-error': '文件系统错误',
};

/** 这几类一旦出现就是硬故障，标红 */
const EVENT_CRITICAL = new Set(['hardware-error', 'disk-error', 'bugcheck']);

/**
 * 提示级：值得知道但不代表硬件马上要坏。
 * ntfs-error 里的 98 号多为非正常关机时的文件系统状态记录（实测与 Kernel-Power 41 同秒出现），
 * 归到关键级别会产生大量误导，因此只做提示。
 */
const EVENT_NOTICE = new Set(['unexpected-shutdown', 'unexpected-shutdown-evlog', 'ntfs-error']);

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

/** 从可能带杂音的 stdout 里抠出第一个完整 JSON 对象 */
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return JSON.parse(text.slice(start, end + 1));
}

class HardwareCollector {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger || (() => {});
    this.stopped = false;
    this.timers = [];
    this.procs = new Set();
    this.thermalBusy = false;
    this.eventsBusy = false;
    this.diskProc = null;
    this.diskRetryTimer = null;
    this.diskBackoff = 2000;

    this.disk = {
      available: false,
      pending: true,
      util: 0,
      queue: 0,
      readMBs: 0,
      writeMBs: 0,
      at: 0,
      error: null,
    };

    this.thermal = {
      available: false,
      pending: true,
      disabled: false,
      source: null,
      sensors: [],
      maxTempC: null,
      fanCount: 0,
      at: 0,
      error: null,
    };

    this.events = {
      available: false,
      pending: true,
      windowHours: Number(cfg.eventWindowHours) || 168,
      items: [],
      total: 0,
      at: 0,
      error: null,
    };
  }

  // ------------------------------------------------------------ 生命周期

  start() {
    if (!IS_WIN) {
      this.disk.error = '仅支持 Windows';
      this.disk.pending = false;
      this.thermal.error = '仅支持 Windows';
      this.thermal.pending = false;
      this.events.error = '仅支持 Windows';
      this.events.pending = false;
      return;
    }

    this.startDiskIo();

    if (this.cfg.enableThermal !== false) {
      const ms = Math.max(5000, Number(this.cfg.thermalIntervalMs) || 20000);
      this.pollThermal();
      this.timers.push(setInterval(() => this.pollThermal(), ms));
    } else {
      // 明确标记为「已禁用」，与「采集失败」区分开，且不创建任何定时器
      this.thermal.pending = false;
      this.thermal.disabled = true;
      this.thermal.error = '已在配置中禁用 (enableThermal=false)';
    }

    if (this.cfg.enableEvents !== false) {
      const ms = Math.max(30000, Number(this.cfg.eventIntervalMs) || 300000);
      this.pollEvents();
      this.timers.push(setInterval(() => this.pollEvents(), ms));
    } else {
      this.events.pending = false;
      this.events.error = '已在配置中禁用 (enableEvents=false)';
    }
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    if (this.diskRetryTimer) {
      clearTimeout(this.diskRetryTimer);
      this.diskRetryTimer = null;
    }
    if (this.diskProc) {
      try { this.diskProc.kill(); } catch (_) {}
      this.diskProc = null;
    }
    for (const p of this.procs) {
      try { p.kill(); } catch (_) {}
    }
    this.procs.clear();
  }

  // ------------------------------------------------------------ 磁盘 I/O

  /** 常驻一个 typeperf，按固定间隔吐 CSV；进程挂了自动重连 */
  startDiskIo() {
    if (this.cfg.enableDiskIo === false) {
      this.disk.pending = false;
      this.disk.error = '已在配置中禁用 (enableDiskIo=false)';
      return;
    }
    if (this.stopped) return;

    const si = Math.max(1, Number(this.cfg.diskIoIntervalSec) || 2);
    const args = [
      '-si', String(si),
      '\\PhysicalDisk(_Total)\\% Disk Time',
      '\\PhysicalDisk(_Total)\\Avg. Disk Queue Length',
      '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec',
      '\\PhysicalDisk(_Total)\\Disk Write Bytes/sec',
    ];

    let child;
    try {
      child = spawn(TPERF_EXE, args, { windowsHide: true });
    } catch (err) {
      this.onDiskFailure(err);
      return;
    }
    this.diskProc = child;
    let stderr = '';
    let buf = '';

    child.on('error', (err) => this.onDiskFailure(err));

    child.stderr.on('data', (d) => {
      if (stderr.length < 2000) stderr += d.toString('utf8');
    });

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const s = this.parseTypeperfLine(line);
        if (!s) continue;
        this.disk = {
          available: true,
          pending: false,
          util: round1(Math.min(100, Math.max(0, s.util))),
          queue: round2(Math.max(0, s.queue)),
          readMBs: round2(Math.max(0, s.read) / 1024 / 1024),
          writeMBs: round2(Math.max(0, s.write) / 1024 / 1024),
          at: Date.now(),
          error: null,
        };
        this.diskBackoff = 2000; // 成功一次就把退避重置
      }
    });

    child.on('close', (code) => {
      if (this.stopped) return;
      this.diskProc = null;
      // 进程意外退出：保留最后一次值，但标记为陈旧
      this.disk.available = false;
      this.disk.error = `typeperf 退出 (code ${code})${stderr ? '：' + stderr.trim().slice(0, 160) : ''}`;
      this.scheduleDiskRetry();
    });
  }

  /** 解析一行 typeperf CSV；表头行会因数值非数字被过滤掉 */
  parseTypeperfLine(line) {
    const t = String(line || '').trim();
    if (!t.startsWith('"')) return null;
    const parts = t.split('","').map((s) => s.replace(/^"+|"+$/g, ''));
    if (parts.length < 5) return null;
    const nums = parts.slice(1, 5).map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return { util: nums[0], queue: nums[1], read: nums[2], write: nums[3] };
  }

  onDiskFailure(err) {
    this.diskProc = null;
    this.disk.pending = false;
    this.disk.available = false;
    const code = err && (err.code || err.message);
    this.disk.error =
      code === 'EPERM'
        ? '无法启动 typeperf（EPERM，进程创建被沙箱限制；以系统服务方式运行即可）'
        : code === 'ENOENT'
        ? `找不到 typeperf：${TPERF_EXE}`
        : `typeperf 启动失败：${code}`;
    this.scheduleDiskRetry();
  }

  scheduleDiskRetry() {
    if (this.stopped || this.diskRetryTimer) return;
    const delay = this.diskBackoff;
    this.diskBackoff = Math.min(this.diskBackoff * 2, 120000);
    this.diskRetryTimer = setTimeout(() => {
      this.diskRetryTimer = null;
      this.startDiskIo();
    }, delay);
  }

  // ------------------------------------------------------------ PowerShell 调用

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

  // ------------------------------------------------------------ 温度 / 风扇

  async pollThermal() {
    if (this.stopped || this.thermalBusy) return;
    this.thermalBusy = true;
    try {
      // 优先用 LibreHardwareMonitorLib 直读（不依赖 GUI，也不占端口）；
      // 装不了或读不到时回落到多源探测脚本。
      let data = null;
      let usedSource = null;

      const libScript = path.join(SCRIPTS_DIR, 'thermal-lib.ps1');
      if (this.cfg.enableLhmLib !== false && fs.existsSync(path.join(LHM_LIB_DIR, 'LibreHardwareMonitorLib.dll'))) {
        try {
          const out = await this.runPowershell(
            libScript,
            ['-SourceDir', LHM_LIB_DIR, '-StageDir', path.join(process.env.TEMP || process.env.TMP || 'C:\\Windows\\TEMP', 'sysmon-lhm')],
            45000
          );
          const lib = extractJson(out);
          if (lib && lib.ok) {
            data = lib;
            usedSource = 'lib';
          }
        } catch (_) {
          /* 回落 */
        }
      }

      if (!data) {
        const out = await this.runPowershell(path.join(SCRIPTS_DIR, 'thermal.ps1'), [], 15000);
        data = extractJson(out);
        usedSource = 'acpi';
      }

      if (!data) throw new Error('无法解析 PowerShell 输出');

      const sensors = Array.isArray(data.sensors) ? data.sensors : [];
      const temps = sensors.filter((s) => s.type === 'Temperature' && Number.isFinite(s.value));
      const fans = sensors.filter((s) => s.type === 'Fan' && Number.isFinite(s.value));

      // CPU 温度在这一平台必然缺失（海光无支持），这是预期结果而非故障，
      // 所以不能用「无传感器」来判错，要按 cpuTempCount 单独说明。
      let error = null;
      if (sensors.length === 0) {
        error =
          usedSource === 'lib'
            ? 'LibreHardwareMonitor 已加载，但未读到任何温度传感器'
            : '未检测到温度/风扇传感器';
      }

      const cpuTempCount = Number(data.cpuTempCount) || 0;
      let note = null;
      if (usedSource === 'lib') {
        if (cpuTempCount === 0) {
          note =
            'CPU 温度不可用：本机是海光 C86（AMD Family 0x18），LibreHardwareMonitor 无海光支持。' +
            '磁盘与显卡温度正常。AIDA64 能读 CPU 温度，是因为它自带专用的 Ring0 内核驱动（kerneld-x64.sys）直接访问寄存器。';
        }
        if (data.driverLoaded === false) {
          note = (note ? note + ' ' : '') + 'Ring0 驱动未加载（本平台的传感器不需要它：NVMe 走 SMART，GPU 走厂商接口）。';
        }
      }

      this.thermal = {
        available: sensors.length > 0,
        pending: false,
        source: usedSource,
        cpuTempCount,
        note,
        sensors: sensors.slice(0, 12).map((s) => ({
          source: String(s.source || ''),
          name: String(s.name || '').slice(0, 60),
          hardware: s.hardware ? String(s.hardware).slice(0, 40) : null,
          hwType: s.hwType ? String(s.hwType) : null,
          type: s.type,
          value: s.type === 'Fan' ? Math.round(s.value) : round1(s.value),
        })),
        maxTempC: temps.length ? round1(Math.max(...temps.map((s) => s.value))) : null,
        fanCount: fans.length,
        at: Date.now(),
        error,
      };
    } catch (err) {
      this.thermal.pending = false;
      this.thermal.available = false;
      const code = err && (err.code || '');
      this.thermal.error =
        code === 'EPERM' ? '无法调用 PowerShell（EPERM，进程创建受限）' : err.message || String(err);
    } finally {
      this.thermalBusy = false;
    }
  }

  // ------------------------------------------------------------ 硬件告警巡检

  async pollEvents() {
    if (this.stopped || this.eventsBusy) return;
    this.eventsBusy = true;
    try {
      const hours = String(Number(this.cfg.eventWindowHours) || 168);
      const out = await this.runPowershell(path.join(SCRIPTS_DIR, 'events.ps1'), [hours], 30000);
      const data = extractJson(out);
      if (!data) throw new Error('无法解析 PowerShell 输出');

      const items = (Array.isArray(data.items) ? data.items : []).map((it) => ({
        key: String(it.key || ''),
        label: EVENT_LABELS[it.key] || String(it.key || ''),
        critical: EVENT_CRITICAL.has(it.key),
        notice: EVENT_NOTICE.has(it.key),
        count: Number(it.count) || 0,
        lastTime: it.lastTime || null,
      }));

      this.events = {
        available: true,
        pending: false,
        windowHours: Number(data.windowHours) || 168,
        items,
        total: items.reduce((a, b) => a + b.count, 0),
        at: Date.now(),
        error: null,
      };
    } catch (err) {
      this.events.pending = false;
      this.events.available = false;
      const code = err && (err.code || '');
      this.events.error =
        code === 'EPERM' ? '无法调用 PowerShell（EPERM，进程创建受限）' : err.message || String(err);
    } finally {
      this.eventsBusy = false;
    }
  }

  // ------------------------------------------------------------ 对外快照

  snapshot() {
    return {
      diskIo: { ...this.disk },
      thermal: { ...this.thermal },
      events: { ...this.events },
    };
  }
}

module.exports = { HardwareCollector, EVENT_LABELS, EVENT_CRITICAL };
