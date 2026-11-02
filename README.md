# SysMon — 局域网服务器资源监控

监控本机 CPU / 内存 / 磁盘 / 网络 / 进程内存 TOP10 / 硬件告警，通过 `IP:端口` 在局域网内用浏览器查看实时数据。

- **零依赖**：只用 Node.js 内置模块与系统自带的 PowerShell / typeperf，不需要 `npm install`
- **实时推送**：SSE 长连接，1 秒一帧，无需刷新页面
- **优雅降级**：任何一项指标取不到，都单独显示「不可用 + 原因」，不影响其它指标

## 页面布局

按使用频率与关联性排列，从上到下：

| 位置 | 模块 | 说明 |
| --- | --- | --- |
| 1（左） | CPU 利用率 | 总体 + 每核柱状 + 曲线 |
| 1（右） | **内存利用率 + 占用内存最高的程序** | 两者合为一张卡片，便于对照「总量高 → 是谁占的」 |
| 2（左） | 磁盘 I/O 利用率 | 繁忙度 + 队列 + 读写速率 |
| 2（右） | 磁盘占用 | 各盘符容量 |
| 3 | 网络监控 | 收发速率 + 每网卡明细 |
| 4 | 硬件告警巡检 | 事件日志异常 |
| 5（末尾） | 运行信息 | 系统/服务运行时长、监控进程自身内存 |

> 温度 / 风扇模块**已从页面移除**（本机为海光平台，CPU 温度无通用读取路径）。
> 相关采集逻辑与诊断记录仍保留在仓库中，详见
> [tools/AIDA64-机制分析与温度方案.md](tools/AIDA64-机制分析与温度方案.md)。

## 需求拆解

| # | 子需求 | 落实方式 |
| --- | --- | --- |
| 1 | 采集 CPU 利用率 | `os.cpus()` 的累计时间片做差分，算出整体利用率与**每核**利用率 |
| 2 | 采集内存利用率 | `os.totalmem()` / `os.freemem()`，输出百分比 + 已用/总量 + 剩余 |
| 3 | 定时采样 | 默认 1 秒；磁盘枚举较慢，单独 15 秒缓存 |
| 4 | 通过 IP+端口访问 | HTTP 服务监听 `0.0.0.0:8090`，任意网卡均可访问 |
| 5 | 实时查看 | 页面用 `EventSource` 订阅 `/api/stream`，服务端每秒推送；断线自动重连 |
| 6 | 局域网可访问 | 需监听 `0.0.0.0` **且** 防火墙放行该端口 |
| 7 | 长期运行 | 注册为开机自启的 SYSTEM 计划任务，随系统启动，不依赖登录 |
| 8 | 磁盘占用 | `fs.statfsSync` 枚举盘符 |
| 9 | **磁盘 I/O 利用率** | 常驻 `typeperf` 读 `% Disk Time`、队列深度、读写速率 |
| 10 | **网络监控** | 常驻 `typeperf` 读每网卡收发速率、利用率、错包/丢包 |
| 11 | **内存占用 TOP10 程序** | `Get-Process` 按程序名聚合，私有字节口径 |
| 12 | **硬件告警巡检** | 扫系统事件日志：非正常关机、蓝屏、WHEA、磁盘、文件系统错误 |

附加（超出原始需求，但运维上几乎必需）：系统/服务运行时长、监控进程自身内存、历史曲线、高负载颜色告警。

## 快速开始

```cmd
:: 前台启动（调试用，关窗口即停）
start-sysmon.cmd

:: 后台启动（无窗口）
start-sysmon-hidden.vbs

:: 停止
stop-sysmon.cmd
```

浏览器打开：

```
http://127.0.0.1:8090/          ← 本机
http://192.168.1.100:8090/      ← 局域网（按实际网卡 IP）
http://10.0.0.50:8090/
```

页面底部会自动列出本机所有可用的访问地址，直接照着点即可。

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `server.js` | 采集 + HTTP + SSE 推送主服务 |
| `collectors/hardware.js` | 硬件采集器（磁盘 I/O、温度风扇、事件巡检），各块独立降级 |
| `collectors/network.js` | 网络采集器（流量、利用率、错包丢包） |
| `collectors/processes.js` | 进程内存 Top N 采集器 |
| `collectors/scripts/procs.ps1` | 按程序名聚合进程内存 |
| `collectors/scripts/net-adapters.ps1` | 网卡链路速率与状态 |
| `collectors/scripts/thermal.ps1` | 多源温度/风扇探测（ACPI + LHM/OHM WMI + Web） |
| `collectors/scripts/thermal-lib.ps1` | 通过 LibreHardwareMonitorLib.dll 直读传感器 |
| `collectors/scripts/events.ps1` | 事件日志巡检 |
| `collectors/scripts/thermal-selftest.ps1` | 用合成数据验证采集链路（排除"代码有 bug"） |
| `collectors/scripts/filter-diagnostic.ps1` | 验证异常读数过滤逻辑 |
| `tools/lhm/` | LibreHardwareMonitor v0.9.6（温度数据源） |
| `tools/LHM-安装与诊断结论.md` | 为什么装了仍读不到温度的完整诊断记录 |
| `public/index.html` | 仪表盘页面（单文件，HTML+CSS+JS 内联） |
| `config.json` | 端口、采样间隔、硬件采集开关等配置 |
| `start-sysmon.cmd` | 前台启动 |
| `start-sysmon-hidden.vbs` | 后台启动（无黑窗） |
| `stop-sysmon.cmd` | 停止，并**校验端口确实释放**才报成功 |
| `setup-autostart.cmd` | 注册开机自启任务 + 防火墙放行（**需管理员**） |
| `remove-autostart.cmd` | 撤销上述两项（**需管理员**） |
| `logs/sysmon.log` | 运行日志，超过 2 MB 自动轮转 |
| `tools/` | 生成脚本与自检工具（见"验证"） |

## 配置

改 `config.json` 后重启服务生效：

```json
{
  "host": "0.0.0.0",          // 监听地址，0.0.0.0 = 所有网卡
  "port": 8090,               // 端口，被占用就改这里
  "sampleIntervalMs": 1000,   // 采样间隔
  "historyPoints": 600,       // 内存中保留的历史点数（600×1s = 10 分钟）
  "diskIntervalMs": 15000,    // 磁盘容量扫描间隔
  "logMaxBytes": 2097152,     // 日志轮转阈值

  "enableDiskIo": true,       // 磁盘 I/O 采集开关
  "diskIoIntervalSec": 2,     // typeperf 采样周期
  "enableThermal": false,     // 温度/风扇采集（页面已移除该模块，默认关闭）
  "thermalIntervalMs": 20000, // 温度轮询间隔（开启时生效）
  "enableLhmLib": true,       // 开启温度时优先用 LibreHardwareMonitorLib 直读
  "enableEvents": true,       // 事件日志巡检开关
  "eventIntervalMs": 300000,  // 巡检间隔（5 分钟）
  "eventWindowHours": 168,    // 告警回看窗口（7 天）

  "enableNetwork": true,          // 网络监控开关
  "networkIntervalSec": 2,        // 流量采样周期
  "networkMetaIntervalMs": 300000,// 网卡链路速率刷新间隔

  "enableProcesses": true,        // 进程内存 Top N 开关
  "processIntervalMs": 5000,      // 采集间隔
  "processTopN": 10               // 显示条数（上限 50）
}
```

也可用命令行或环境变量临时覆盖：`node server.js --port 9000`、`$env:SYSMON_PORT=9000`。

## 硬件指标的实现方式

### 磁盘 I/O

常驻**一个** `typeperf` 进程，按固定周期输出 CSV（`-si` 控制间隔），Node 流式解析：

```
typeperf -si 2 \PhysicalDisk(_Total)\% Disk Time \PhysicalDisk(_Total)\Avg. Disk Queue Length ...
```

- 不是每轮 spawn 一次新进程——那样开销大且统计不准
- 进程异常退出会**指数退避重连**（2s → 4s → … → 120s），期间保留最后值并标为陈旧
- 只取 `_Total`，不分具体物理盘

### 温度 / 风扇（已从页面移除）

该模块已按需求删除，后端采集同步关闭（`enableThermal: false`），因此**不再每 20 秒拉起一次 PowerShell**。

保留的记录（换到支持的平台或需要恢复时查阅）：

- CPU 温度读不到的原因：本机是**海光 C86-3G（AMD Family 24 / 0x18）**，LibreHardwareMonitor
  的二进制里**完全没有 `Hygon` 字符串**，只有 `Amd17Cpu`/`Amd10Cpu` 等零售 AMD 家族实现
- AIDA64 能读到，是因为它自带专用 Ring0 驱动（`kerneld-x64.sys`，服务 `AIDA64Driver`）
  直接访问 CPU 寄存器（MSR/SMN）
- 若要恢复：`enableThermal` 改回 `true`，并把卡片加回页面

完整诊断与方案对比见 [tools/AIDA64-机制分析与温度方案.md](tools/AIDA64-机制分析与温度方案.md)。

### 内存占用 TOP10 程序

每 5 秒用 `Get-Process` 采集（实测 25ms；`Get-CimInstance Win32_Process` 需 338ms，慢 13 倍）。

两个关键设计决定，都是实测推出来的：

**1. 按程序名聚合，不按 PID 罗列**

本机有 273 个进程、105 个程序。浏览器和 Electron 应用会派生大量子进程：

```
chrome   × 9 个
svchost  × 100 个
WorkBuddy × 8 个
node     × 8 个
```

若按 PID 平铺，TOP10 会被 chrome 的 9 个进程占满，看不出「哪个程序真的吃内存」。

**2. 用私有字节，不用工作集**

| 口径 | 各进程加总 | 占物理内存 |
| --- | --- | --- |
| WorkingSet（工作集） | 4.95 GB | 31.2% ❌ |
| **PrivateMemorySize64（私有）** | 7.85 GB | **49.5%** ✅ |

工作集会低估，因为**共享页被每个进程重复计入**。私有字节口径与系统整体内存利用率吻合（实测差值仅 0.5 个百分点），也更接近任务管理器「内存」列。

页面展示内容：排名、程序名（多实例显示 `×N`）、相对 Top1 的条形、私有内存、占已用内存百分比。占比 ≥10% 标黄、≥25% 标红。

> 配置项：`enableProcesses`、`processIntervalMs`（默认 5000）、`processTopN`（默认 10，上限 50）。

### 网络监控

常驻**一个** `typeperf` 进程读 `Network Interface` 系列计数器（与磁盘 I/O 各自独立）：

```
Bytes Received/sec  Bytes Sent/sec
Packets Received Errors  Packets Outbound Errors
Packets Received Discarded  Packets Outbound Discarded
```

要点：

- **实例名映射**：PDH 的实例名是网卡**描述**（`Realtek PCIe GbE...`），而 `Get-NetAdapter` 的
  `Name` 是**友好名**（`以太网`）。两者必须双向映射，否则链路速率取不到、利用率算不出来。
  这是开发中实际踩到的 bug，已在 `network.js` 里对两个键都建映射。
- **利用率** = `(收发字节×8) / (链路速率×10⁶) × 100%`，链路速率由 `net-adapters.ps1` 每 5 分钟刷新。
- **错包/丢包**是开机以来的累计值（非速率），用于发现网线/网卡/对端的物理层问题。
- 单网卡无链路速率（如已断开）时利用率显示 `—`，不臆造数字。
- `Bytes Received/sec` 是 PDH 速率计数器，typeperf 直接给每秒字节数，**不需要自己差分**。

> 中文网卡名乱码问题：Windows PowerShell 默认用 OEM 代码页写 stdout，
> `以太网` 会变成 `��̫��`。脚本内已强制 `[Console]::OutputEncoding = UTF8` 修正。

### 硬件告警巡检

每 5 分钟扫一次系统事件日志，统计最近 7 天内以下事件：

| 事件 | ID / 来源 | 级别 | 含义 |
| --- | --- | --- | --- |
| 非正常关机 | 41 / Kernel-Power | 提示 | 断电或硬死机 |
| 意外关机记录 | 6008 / EventLog | 提示 | 同上，佐证 |
| 蓝屏 | 1001 / WER-SystemErrorReporting | **严重** | 系统崩溃 |
| 硬件错误 | WHEA-Logger | **严重** | CPU/内存/PCIe 硬件级错误 |
| 磁盘错误 | disk / storahci / stornvme 等 | **严重** | 磁盘或控制器异常 |
| 文件系统错误 | Ntfs | 提示 | 多为非正常关机后的状态记录 |

`Ntfs` 之所以定为**提示**而非严重：实测其 98 号事件与 Kernel-Power 41 **同秒出现**，属关机时的状态记录，若标红会产生大量误导。

## HTTP 接口

| 路径 | 说明 |
| --- | --- |
| `GET /` | 仪表盘页面 |
| `GET /api/health` | 健康检查，`{"ok":true}` |
| `GET /api/info` | 主机名、CPU 型号、核数、内存总量、各网卡 IP |
| `GET /api/snapshot` | 当前一帧快照（JSON） |
| `GET /api/history?points=300` | 历史曲线点 |
| `GET /api/stream` | SSE 实时流 |

`/api/snapshot` 示例：

```json
{
  "ts": 1793599172978,
  "cpu": { "usage": 1.7, "perCore": [7.8, 1.5, "...共16个"], "cores": 16 },
  "mem": { "usage": 49.9, "usedGB": 7.9, "totalGB": 15.9, "freeGB": 7.9, "serviceRssMB": 50 },
  "disks": [{ "mount": "C:", "usage": 36.1, "usedGB": 143.3, "totalGB": 396.6 }],
  "uptime": { "systemSec": 254007, "serviceSec": 5 },
  "hardware": {
    "diskIo": { "available": true, "util": 0.3, "queue": 0.01, "readMBs": 0, "writeMBs": 0.11, "at": 1793600305143, "error": null },
    "thermal": { "available": false, "pending": false, "disabled": true, "sensors": [], "error": "已在配置中禁用 (enableThermal=false)" },
    "events": {
      "available": true, "windowHours": 168, "total": 6,
      "items": [
        { "key": "unexpected-shutdown", "label": "非正常关机 (Kernel-Power 41)", "critical": false, "notice": true, "count": 1, "lastTime": "2026-10-30 08:29:20" }
      ]
    }
  },
  "network": {
    "available": true, "totalRxMBs": 0.06, "totalTxMBs": 0.03,
    "interfaces": [{ "name": "以太网", "status": "Up", "speedMbps": 10, "utilization": 0.4 }]
  },
  "processes": {
    "available": true, "usedPercent": 35.9, "processCount": 273, "groupCount": 105,
    "top": [{ "name": "WorkBuddy", "count": 8, "privateMB": 2074.3, "pctOfUsed": 35.54 }]
  }
}
```

## 开机自启（系统级）

以**管理员**身份运行一次 `setup-autostart.cmd`，它会：

1. 注册计划任务 `SysMon-Web`：`SYSTEM` 身份、`At system start up`、延迟 30 秒（等网络就绪）、失败自动重试 3 次
2. 添加入站防火墙规则 `SysMon-Web-8090`（TCP 8090，所有配置文件）

撤销用 `remove-autostart.cmd`。手动触发一次：`schtasks /Run /TN "SysMon-Web"`。

> 以 SYSTEM 运行的好处：不需要用户登录就生效，且重启机器后自动恢复。日志、配置仍留在本目录。

## 防火墙（局域网访问的关键）

Windows 防火墙在所有配置文件下都是开启的，**不放开 8090 的话，别的机器连不上**，仅本机能访问。

- `setup-autostart.cmd` 已自动添加规则
- 手工添加：

```powershell
netsh advfirewall firewall add rule name="SysMon-Web-8090" dir=in action=allow protocol=TCP localport=8090 profile=any
```

**注意**：在本机用内网 IP 访问自己是走回环、**绕过防火墙**的，所以本机能打开不代表局域网别的机器能打开。务必从另一台设备实测（手机浏览器连同一个 WiFi 即可）。

## 验证记录

以下结果均在本机实测（Windows / 16 核 / 15.9 GB）：

| 项目 | 结果 |
| --- | --- |
| 首页 / API / SSE | 200，SSE 每秒推送快照 + 首连补历史 |
| 三个网卡 IP 访问 | `192.168.1.100`、`10.0.0.50`、`10.0.0.51` 全部 200 |
| **局域网真机访问** | 已观察到 `192.168.1.125` 实际连入，证明防火墙放行生效 |
| CPU 采样准确性 | 4 线程加压：8% → 34.6%，解除后回落 0.5%（16 核，符合预期增幅） |
| **磁盘 I/O 准确性** | 持续写 5512 MB：写速率 0.18 → 951.77 MB/s，util 0.3% → 18.1%，停止后回落 |
| **网络采集** | 22 秒连续采样，5/12 采样点捕捉到非零流量；链路速率/状态/利用率均正确 |
| **网络 UI 渲染** | 11 项断言通过（速率、网卡表、Gbps 换算、高负载标红、不可用降级） |
| **进程内存采集** | 8 项自洽性检查通过；进程口径 36.5% vs 系统口径 36%，差 0.5 个百分点 |
| **进程 UI 渲染** | 10 项断言通过（排名、×N 多实例、单位换算、占比、口径说明、降级） |
| **告警巡检** | 实测检出 Kernel-Power 41 ×1、NTFS ×5，并正确分级为「提示」 |
| 前端渲染逻辑 | 12 项断言通过（数值、进度条、磁盘表、曲线累积） |
| **硬件/网络/进程渲染** | 32 项断言通过，覆盖可用、不可用、禁用三条分支 |
| **页面布局结构** | 6 项断言通过（温度模块已移除、进程内嵌内存卡、运行信息在末尾、并排关系） |
| 计划任务链路 | `schtasks /Run` 后新 PID 监听 8090，HTTP 正常 |
| 停止脚本 | 端口未释放时如实报错并返回非零退出码 |
| SSE 断开日志 | 修复重复触发后，接入 1 次 / 断开 1 次 |
| SSE 推送周期 | 稳定在 1002~1018ms（`setInterval` 正常抖动），无重复帧 |
| 服务自身开销 | 常驻内存约 51 MB；typeperf 单进程常驻 |

自检工具：

```cmd
node tools/check-frontend.mjs         :: 内联脚本语法 + DOM id 引用完整性
node tools/check-layout.mjs           :: 页面布局结构（模块位置与嵌套关系）
node tools/check-render.mjs           :: 基础渲染，12 项断言
node tools/check-hardware-ui.mjs      :: 硬件/网络/进程渲染，32 项断言
node tools/check-accuracy.mjs         :: 真实加压，验证 CPU 读数随负载变化
node tools/check-diskio.mjs           :: 持续写入，验证磁盘 I/O 读数随负载变化
node tools/check-network.mjs          :: 真实流量，验证网络读数与网卡映射
node tools/check-processes.mjs        :: 进程内存数据自洽性与排序校验
node tools/check-sse-rate.mjs         :: 实测推送周期，确认无重复帧

:: 温度链路（模块已下线，仅在恢复时使用）
powershell -ExecutionPolicy Bypass -File collectors\scripts\thermal-selftest.ps1
powershell -ExecutionPolicy Bypass -File collectors\scripts\filter-diagnostic.ps1
```

## 排障

| 现象 | 原因与处理 |
| --- | --- |
| 本机能开，别的机器打不开 | 防火墙未放行。用管理员执行 `setup-autostart.cmd`，或手工加规则 |
| 日志报"端口 8090 已被占用" | 已有实例在跑。`stop-sysmon.cmd` 或改 `config.json` 的端口 |
| `stop-sysmon.cmd` 报 Failed to kill | 需要管理员权限；脚本现在会如实报错，不再假报成功 |
| 页面一直"连接中断" | 看 `logs/sysmon.log` 是否有 SSE 接入记录；公司网络若拦长连接，改用 `/api/snapshot` 轮询 |
| 重启机器后没起来 | 确认任务存在：`schtasks /Query /TN "SysMon-Web"`；确认 `setup-autostart.cmd` 用管理员跑过 |
| 磁盘 I/O 显示不可用 | 看页面上的原因文字。`EPERM` = 进程创建被限制，以 SYSTEM 服务运行即可；`ENOENT` = 找不到 typeperf |
| 磁盘 I/O 数据长时间不动 | typeperf 可能已退出，采集器会指数退避自动重连；查日志有无重复的退出记录 |
| 网络显示「不可用」 | 看页面原因。`EPERM` = 进程创建受限；若 typeperf 退出会自动退避重连 |
| 网卡利用率为 `—` | 该网卡无链路速率（已断开或查询失败），5 分钟内会刷新 |
| 网卡名乱码 | 已修复（强制 UTF-8 输出）；若仍乱码请反馈 |
| 进程列表为空或不可用 | 看页面原因。若 PowerShell 调用失败会每 5 秒自动重试 |
| 进程内存数值与任务管理器不同 | 正常。本页是**私有字节**并按程序名合并；任务管理器按进程拆分且口径略有差异 |
| 页面上看不到温度模块 | 已按需求移除（`enableThermal: false`）。恢复方法见「温度 / 风扇（已从页面移除）」 |

## 已知限制

- **温度模块已下线**：页面不再显示。本机为海光平台，CPU 温度无通用读取路径；
  磁盘/GPU 温度技术上可读，但已按需求一并移除。
- **磁盘 I/O 只到 `_Total`**：不分具体物理盘；多盘机器想看单盘需改 `typeperf` 计数器路径。
- **无鉴权**：局域网内知道地址的人都能看。仅暴露只读的利用率数据；若要限制来源，可把防火墙规则的 `profile` 收窄或加 `remoteip=`。
- **无持久化**：历史曲线存在内存里，服务重启即清空。需要长期趋势可外接 Prometheus / InfluxDB。
- **单机监控**：只监控本进程所在的那台机器。多台需各自部署，或用 `/api/snapshot` 汇总。
- 内存利用率按操作系统口径（`totalmem - freemem`），含系统缓存，与任务管理器"已用"可能有细微差异。
- 进程列表每 5 秒、事件日志每 5 分钟各拉一次 PowerShell；温度关闭后不再有 20 秒一次的轮询。
