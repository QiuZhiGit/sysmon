'use strict';

/**
 * 进程内存 TOP N 采集器
 *
 * 取数方式：PowerShell `Get-Process`（实测 25ms，而 Get-CimInstance Win32_Process 需 338ms）
 * 聚合口径：按进程名合并。浏览器/Electron 应用会派生大量子进程
 *          （实测 chrome 9 个、svchost 99 个），若按 PID 罗列会把真正的答案淹没。
 * 内存口径：PrivateMemorySize64（私有字节）。实测 WorkingSet 合计只有已用的 31%，
 *          因为共享页被重复计入；Private 合计 49.5%，与系统内存利用率吻合，
 *          也更接近任务管理器"内存"列的口径。
 *
 * 默认 5 秒采集一次（进程枚举比 CPU/内存采样重，不必每秒做）。
 */

const { spawn } = require('child_process');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const SYS_ROOT = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
const POWERSHELL_EXE = path.join(SYS_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCRIPT = path.join(__dirname, 'scripts', 'procs.ps1');

const round1 = (v) => Math.round(v * 10) / 10;

function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return JSON.parse(text.slice(start, end + 1));
}

class ProcessCollector {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger || (() => {});
    this.stopped = false;
    this.timer = null;
    this.proc = null;
    this.busy = false;
    this.topN = Math.min(50, Math.max(1, Number(cfg.processTopN) || 10));

    this.processes = {
      available: false,
      pending: true,
      top: [],
      totalMB: 0,
      usedMB: 0,
      usedPercent: 0,
      processCount: 0,
      groupCount: 0,
      at: 0,
      error: null,
    };
  }

  start() {
    if (!IS_WIN) {
      this.processes.pending = false;
      this.processes.error = '仅支持 Windows';
      return;
    }
    if (this.cfg.enableProcesses === false) {
      this.processes.pending = false;
      this.processes.disabled = true;
      this.processes.error = '已在配置中禁用 (enableProcesses=false)';
      return;
    }

    const ms = Math.max(2000, Number(this.cfg.processIntervalMs) || 5000);
    this.poll();
    this.timer = setInterval(() => this.poll(), ms);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.proc) {
      try { this.proc.kill(); } catch (_) {}
      this.proc = null;
    }
  }

  runPowerShell(scriptFile, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(
          POWERSHELL_EXE,
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, ...args],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        );
      } catch (err) {
        return reject(err);
      }
      this.proc = child;

      let out = '';
      let err = '';
      let settled = false;

      const timer = setTimeout(() => finish(new Error(`超时 ${timeoutMs}ms`)), timeoutMs);

      const finish = (e, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.proc = null;
        if (e) reject(e);
        else resolve(v);
      };

      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { if (err.length < 2000) err += d.toString('utf8'); });
      child.on('error', (e) => finish(e));
      child.on('close', () => finish(null, out));
    });
  }

  async poll() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      const out = await this.runPowerShell(SCRIPT, [String(this.topN)], 15000);
      const data = extractJson(out);
      if (!data) throw new Error('无法解析 PowerShell 输出');
      if (data.ok === false) throw new Error(data.error || '采集失败');

      const top = (Array.isArray(data.top) ? data.top : []).map((p) => ({
        name: String(p.name || 'unknown').slice(0, 48),
        count: Number(p.count) || 1,
        privateMB: round1(Number(p.privateMB) || 0),
        workingMB: round1(Number(p.workingMB) || 0),
        pctOfUsed: Math.round((Number(p.pctOfUsed) || 0) * 100) / 100,
        pctOfTotal: Math.round((Number(p.pctOfTotal) || 0) * 100) / 100,
        maxPid: Number(p.maxPid) || 0,
      }));

      this.processes = {
        available: true,
        pending: false,
        top,
        totalMB: Math.round((Number(data.totalBytes) || 0) / 1024 / 1024),
        usedMB: Math.round((Number(data.usedBytes) || 0) / 1024 / 1024),
        usedPercent: round1(Number(data.usedPercent) || 0),
        processCount: Number(data.processCount) || 0,
        groupCount: Number(data.groupCount) || 0,
        at: Date.now(),
        error: null,
      };
    } catch (err) {
      this.processes.pending = false;
      this.processes.available = false;
      const code = err && (err.code || '');
      this.processes.error =
        code === 'EPERM' ? '无法调用 PowerShell（EPERM，进程创建受限）' : err.message || String(err);
      this.log('ERROR', `进程内存采集失败：${this.processes.error}`);
    } finally {
      this.busy = false;
    }
  }

  snapshot() {
    return { ...this.processes };
  }
}

module.exports = { ProcessCollector };
