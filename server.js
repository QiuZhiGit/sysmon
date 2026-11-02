#!/usr/bin/env node
'use strict';

/**
 * SysMon —— 轻量级服务器资源监控服务
 *
 * 采集：CPU 总体/每核利用率、内存利用率、磁盘占用、运行时长
 * 提供：实时仪表盘（SSE 推送）+ JSON API
 * 依赖：零依赖，只用 Node.js 内置模块
 *
 * 启动：node server.js [--port 8090] [--host 0.0.0.0]
 * 访问：http://<本机IP>:<端口>/
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { HardwareCollector } = require('./collectors/hardware');
const { NetworkCollector } = require('./collectors/network');
const { ProcessCollector } = require('./collectors/processes');

// ---------------------------------------------------------------- 常量/配置

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const LOG_DIR = path.join(APP_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'sysmon.log');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8090,
  sampleIntervalMs: 1000, // 采样间隔
  historyPoints: 600,     // 内存中保留的历史点数（600 * 1s = 10 分钟）
  diskIntervalMs: 15000,  // 磁盘扫描间隔（磁盘枚举偏慢，放长）
  logMaxBytes: 2 * 1024 * 1024,
  // ---- 硬件采集 ----
  enableDiskIo: true,
  diskIoIntervalSec: 2,     // typeperf 采样周期
  enableThermal: true,
  thermalIntervalMs: 20000, // 温度/风扇轮询间隔（PowerShell 启动约 0.5s，不宜过密）
  enableEvents: true,
  eventIntervalMs: 300000,  // 事件日志巡检间隔（5 分钟足够）
  eventWindowHours: 168,    // 告警回看窗口（7 天）
  // ---- 网络监控 ----
  enableNetwork: true,
  networkIntervalSec: 2,           // typeperf 流量采样周期
  networkMetaIntervalMs: 300000,   // 网卡链路速率刷新间隔
  // ---- 进程内存 Top N ----
  enableProcesses: true,
  processIntervalMs: 5000,         // 进程枚举比 CPU 采样重，5 秒足够
  processTopN: 10,
};

function loadConfig() {
  const cfg = Object.assign({}, DEFAULTS);
  const file = path.join(APP_DIR, 'config.json');
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const k of Object.keys(DEFAULTS)) {
        if (raw[k] !== undefined && raw[k] !== null) cfg[k] = raw[k];
      }
    }
  } catch (err) {
    console.error(`[config] 读取 config.json 失败，使用默认值：${err.message}`);
  }
  // 命令行/环境变量覆盖
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--port' || a === '-p') && argv[i + 1]) cfg.port = Number(argv[++i]);
    else if (a === '--host' && argv[i + 1]) cfg.host = String(argv[++i]);
  }
  if (process.env.SYSMON_PORT) cfg.port = Number(process.env.SYSMON_PORT);
  if (process.env.SYSMON_HOST) cfg.host = String(process.env.SYSMON_HOST);

  cfg.port = Number(cfg.port);
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new Error(`端口不合法：${cfg.port}`);
  }
  cfg.sampleIntervalMs = Math.max(200, Number(cfg.sampleIntervalMs) || 1000);
  cfg.historyPoints = Math.max(30, Number(cfg.historyPoints) || 600);
  cfg.diskIntervalMs = Math.max(2000, Number(cfg.diskIntervalMs) || 15000);
  return cfg;
}

const CONFIG = loadConfig();

// ---------------------------------------------------------------- 日志

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

function rotateLog() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size > CONFIG.logMaxBytes) {
      const bak = LOG_FILE + '.1';
      try { fs.unlinkSync(bak); } catch (_) {}
      fs.renameSync(LOG_FILE, bak);
    }
  } catch (_) {
    /* 文件不存在，忽略 */
  }
}

ensureDir(LOG_DIR);

function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  try {
    rotateLog();
    fs.appendFileSync(LOG_FILE, line + os.EOL);
  } catch (_) {
    /* 写日志失败不影响主流程 */
  }
}

// ---------------------------------------------------------------- 工具

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;
const fmtGB = (bytes) => round1(bytes / 1024 / 1024 / 1024);

// ---------------------------------------------------------------- 采样器

let prevCpuTimes = null;
let diskCache = { at: 0, list: [] };
let history = [];
const startedAt = Date.now();

function readCpuTimes() {
  return os.cpus().map((c) => ({ ...c.times }));
}

/** 计算相对于上一次采样的 CPU 利用率（整体 + 每核） */
function sampleCpu() {
  const now = readCpuTimes();
  const perCore = [];
  let totalDelta = 0;
  let idleDelta = 0;

  if (prevCpuTimes && prevCpuTimes.length === now.length) {
    for (let i = 0; i < now.length; i++) {
      const a = prevCpuTimes[i];
      const b = now[i];
      const delta = b.user - a.user + (b.nice - a.nice) + (b.sys - a.sys) + (b.idle - a.idle) + (b.irq - a.irq);
      const idle = b.idle - a.idle;
      totalDelta += delta;
      idleDelta += idle;
      perCore.push(delta > 0 ? clamp(100 * (1 - idle / delta), 0, 100) : 0);
    }
  }
  prevCpuTimes = now;

  const usage = totalDelta > 0 ? clamp(100 * (1 - idleDelta / totalDelta), 0, 100) : knownCpuUsage;
  return {
    usage,
    perCore,
    cores: now.length,
  };
}

// 首次采样没有基准，沿用上一次的有效值（初始为 0），避免开头出现跳变
let knownCpuUsage = 0;

function sampleMem() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const rss = process.memoryUsage().rss;
  return {
    total,
    free,
    used,
    usage: total > 0 ? clamp((used / total) * 100, 0, 100) : 0,
    totalGB: fmtGB(total),
    usedGB: fmtGB(used),
    freeGB: fmtGB(free),
    serviceRssMB: Math.round(rss / 1024 / 1024),
  };
}

/** 枚举盘符并取容量；结果按 diskIntervalMs 缓存 */
function sampleDisks() {
  const now = Date.now();
  if (diskCache.list.length && now - diskCache.at < CONFIG.diskIntervalMs) {
    return diskCache.list;
  }
  const list = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
    const mount = `${letter}:\\`;
    try {
      const st = fs.statfsSync(mount);
      const total = Number(st.blocks) * Number(st.bsize);
      const free = Number(st.bavail) * Number(st.bsize);
      if (!total || !Number.isFinite(total)) continue; // 空光驱/不可用盘
      list.push({
        mount: `${letter}:`,
        total,
        free,
        used: total - free,
        usage: clamp(((total - free) / total) * 100, 0, 100),
        totalGB: fmtGB(total),
        freeGB: fmtGB(free),
        usedGB: fmtGB(total - free),
      });
    } catch (_) {
      // 盘符不存在或无权限，跳过
    }
  }
  list.sort((a, b) => a.mount.localeCompare(b.mount));
  diskCache = { at: now, list };
  return list;
}

function ipList() {
  const out = [];
  const nics = os.networkInterfaces();
  for (const name of Object.keys(nics)) {
    for (const nic of nics[name] || []) {
      if (nic.family === 'IPv4' && !nic.internal) {
        out.push({ iface: name, address: nic.address });
      }
    }
  }
  return out;
}

function hostInfo() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpuModel: cpus.length ? cpus[0].model.trim() : 'unknown',
    cores: cpus.length,
    node: process.version,
    totalMemGB: fmtGB(os.totalmem()),
    bootAt: Date.now() - os.uptime() * 1000,
    serviceStartAt: startedAt,
    addresses: ipList(),
    port: CONFIG.port,
  };
}

function sample() {
  const cpu = sampleCpu();
  if (cpu.usage > 0) knownCpuUsage = cpu.usage;
  const mem = sampleMem();
  const disks = sampleDisks();
  const at = Date.now();
  const snap = {
    ts: at,
    cpu: {
      usage: round1(cpu.usage),
      perCore: cpu.perCore.map(round1),
      cores: cpu.cores,
    },
    mem: {
      usage: round1(mem.usage),
      usedGB: mem.usedGB,
      totalGB: mem.totalGB,
      freeGB: mem.freeGB,
      used: mem.used,
      total: mem.total,
      serviceRssMB: mem.serviceRssMB,
    },
    disks: disks.map((d) => ({
      mount: d.mount,
      usage: round1(d.usage),
      usedGB: d.usedGB,
      totalGB: d.totalGB,
      freeGB: d.freeGB,
    })),
    uptime: {
      systemSec: Math.round(os.uptime()),
      serviceSec: Math.round((at - startedAt) / 1000),
    },
    hardware: hardware ? hardware.snapshot() : null,
    network: network ? network.snapshot() : null,
    processes: processes ? processes.snapshot() : null,
  };
  return snap;
}

function pushHistory(snap) {
  const hw = snap.hardware;
  const net = snap.network;
  history.push({
    t: snap.ts,
    cpu: snap.cpu.usage,
    mem: snap.mem.usage,
    // 磁盘 I/O 利用率仅在采到时记录，否则为 null，前端据此断线而不是画成 0
    dio: hw && hw.diskIo && hw.diskIo.available ? hw.diskIo.util : null,
    // 网络收发速率（MB/s），用于趋势曲线
    nrx: net && net.available ? net.totalRxMBs : null,
    ntx: net && net.available ? net.totalTxMBs : null,
  });
  if (history.length > CONFIG.historyPoints) {
    history.splice(0, history.length - CONFIG.historyPoints);
  }
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.replace(/^\/+/, ''));
  const target = path.resolve(PUBLIC_DIR, rel);
  // 防目录穿越
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) {
    return sendText(res, 403, 'Forbidden');
  }
  let data;
  try {
    data = fs.readFileSync(target);
  } catch (_) {
    return sendText(res, 404, 'Not Found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/** SSE 客户端集合 */
const sseClients = new Set();

function sseWrite(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch (_) {
    return false;
  }
}

function handleSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  log('INFO', `SSE 客户端接入：${req.socket.remoteAddress}（当前 ${sseClients.size} 个）`);

  // 先把最新快照和历史推过去，页面立即有内容
  if (lastSnap) sseWrite(res, { type: 'snapshot', data: lastSnap });
  sseWrite(res, { type: 'history', data: history.slice(-120) });

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 15000);

  // close 事件在 req 与 res 上都会触发，用标志位保证只清理一次
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    sseClients.delete(res);
    log('INFO', `SSE 客户端断开：${req.socket.remoteAddress}（剩余 ${sseClients.size} 个）`);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

function broadcast(payload) {
  for (const res of Array.from(sseClients)) {
    if (!sseWrite(res, payload)) sseClients.delete(res);
  }
}

let lastSnap = null;
let hardware = null;
let network = null;
let processes = null;

function handleRequest(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  // 简单跨域：允许局域网内其它页面读取（只读数据，无凭据）
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' });
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed');
  }

  if (p === '/api/health') return sendJson(res, 200, { ok: true, ts: Date.now() });
  if (p === '/api/info') return sendJson(res, 200, hostInfo());
  if (p === '/api/snapshot') return sendJson(res, 200, lastSnap || sample());
  if (p === '/api/history') {
    const n = clamp(parseInt(u.searchParams.get('points') || '300', 10) || 300, 1, history.length || 1);
    return sendJson(res, 200, history.slice(-n));
  }
  if (p === '/api/stream') return handleSse(req, res);

  if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
  return serveStatic(req, res, p);
}

// ---------------------------------------------------------------- 主循环

function startSampling() {
  prevCpuTimes = readCpuTimes(); // 建立基准，第一次采样就能算出真实值

  // 硬件采集独立于主采样，任何一块失败都不影响 CPU/内存
  hardware = new HardwareCollector(CONFIG, log);
  hardware.start();

  // 网络采集同样独立
  network = new NetworkCollector(CONFIG, log);
  network.start();

  // 进程内存 TOP N
  processes = new ProcessCollector(CONFIG, log);
  processes.start();

  setInterval(() => {
    try {
      lastSnap = sample();
      pushHistory(lastSnap);
      broadcast({ type: 'snapshot', data: lastSnap });
    } catch (err) {
      log('ERROR', `采样失败：${err.stack || err.message}`);
    }
  }, CONFIG.sampleIntervalMs);
}

function serverUrls(port, host) {
  const urls = [`http://127.0.0.1:${port}/`];
  if (host === '0.0.0.0' || host === '::') {
    for (const { address } of ipList()) urls.push(`http://${address}:${port}/`);
  } else {
    urls.push(`http://${host}:${port}/`);
  }
  return urls;
}

function main() {
  const server = http.createServer(handleRequest);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('ERROR', `端口 ${CONFIG.port} 已被占用，请修改 config.json 里的 port 或加 --port 参数`);
    } else if (err.code === 'EACCES') {
      log('ERROR', `端口 ${CONFIG.port} 无权限绑定（1024 以下端口需要管理员权限）`);
    } else {
      log('ERROR', `HTTP 服务出错：${err.stack || err.message}`);
    }
    process.exit(1);
  });

  server.listen(CONFIG.port, CONFIG.host, () => {
    startSampling();
    const info = hostInfo();
    log('INFO', `SysMon 已启动，PID=${process.pid}，监听 ${CONFIG.host}:${CONFIG.port}`);
    log('INFO', `采样间隔 ${CONFIG.sampleIntervalMs}ms，历史保留 ${CONFIG.historyPoints} 点`);
    log('INFO', `主机 ${info.hostname} / ${info.cpuModel} / ${info.cores} 核 / ${info.totalMemGB} GB`);
    for (const u of serverUrls(CONFIG.port, CONFIG.host)) log('INFO', `访问地址：${u}`);
  });

  const shutdown = (sig) => {
    log('INFO', `收到 ${sig}，正在退出`);
    if (hardware) {
      try { hardware.stop(); } catch (_) {}
    }
    if (network) {
      try { network.stop(); } catch (_) {}
    }
    if (processes) {
      try { processes.stop(); } catch (_) {}
    }
    for (const res of sseClients) {
      try { res.end(); } catch (_) {}
    }
    sseClients.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => log('ERROR', `未捕获异常：${err.stack || err.message}`));
}

main();
