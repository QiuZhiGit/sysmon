# AIDA64 为什么能读到 CPU 温度，以及我们为什么不能

最后更新：2026-11-02

## 一、直接回答

**AIDA64 能读到 CPU 温度，是因为它自带一个专用的 Ring0 内核驱动，直接访问 CPU 的寄存器。**

实测证据（本机）：

```
服务名   : AIDA64Driver
显示名   : FinalWire AIDA64 Kernel Driver
状态     : Running
驱动文件 : C:\图吧工具箱\图吧工具箱202507\tools\综合检测\aida64\kerneld-x64.sys
内部名   : LLKD   (e:\work\visualc\llkd\driver.nt\amd64\LLKD.pdb)
版本     : 3.0.1016.0
签名     : Valid — CN=FinalWire Kft. (DigiCert)
```

驱动导出的设备对象（从二进制中提取）：

```
\Device\AIDA64Driver
\DosDevices\AIDA64Driver
```

也就是说 AIDA64 走的路径是：

```
AIDA64.exe  ──DeviceIoControl──>  \\.\AIDA64Driver  ──Ring0──>  CPU MSR / PCI SMN 寄存器
```

## 二、我上一轮的错误结论

上一轮我写的是「**硬件未向操作系统暴露温度，所有带内方案均失败**」。这个结论**错了**。

正确的说法是：**温度数据一直存在，但只有持有 Ring0 驱动、并且认识该 CPU 家族的程序才能读到。**

- AIDA64 能读 → 证明数据存在
- 所有通用接口（ACPI/WMI/IPMI/SuperIO）读不到 → 证明没有通用通路
- 两者并不矛盾

## 三、为什么 LibreHardwareMonitor 读不到 CPU 温度

**因为 LHM 不支持海光。** 这不是权限问题，也不是配置问题。

实测证据——直接在 LHM 的二进制里搜索字符串：

| 关键字 | 是否出现 |
| --- | --- |
| `Hygon` / `hygon` / `HYGON` | ❌ **完全没有** |
| `Family 24` / `0x18` | ❌ 没有 |
| `Zen` | ✅ 有（但用于零售 AMD） |
| `Amd17Cpu` / `Amd10Cpu` | ✅ 有（零售 AMD 家族） |

LHM 的 CPU 温度实现是按 CPU 家族硬编码寄存器地址的（AMD 走 `SMN` 间接访问 `THM_TCON_CUR_TMP`）。
本机 CPU 是：

```
Hygon C86-3G (OPN:3350)
Manufacturer: HygonGenuine
Description : AMD64 Family 24 Model 2 Stepping 2
```

`Family 24` = `0x18`。LHM 没有这个家族的实现，所以 19 个 CPU 节点全部为空，只有一个 `Load`。

## 四、但这轮有真实收获：磁盘/GPU 温度读到了

上一轮我连**非 CPU 温度**也没拿到，原因是加载方式错误。这轮修好了，现在能读到真实数据：

```
AMD Radeon R7 200 Series   GPU Core               = 51 °C
SCY S3000 (NVMe)           Composite Temperature  = 64 °C
SCY S3000 (NVMe)           Temperature #1         = 63.9 °C
SCY S3000 (NVMe)           Temperature #2         = 47.9 °C
ST1000DM014-2UB10D (HDD)   Temperature            = 41 °C
```

连读三次结果完全一致，数据稳定。

### 关键：NVMe 固态已经 64 °C，偏高

NVMe 的正常工作区间是 40–50 °C，**70 °C 左右开始主动降速**（thermal throttling），
主控长期高温会缩短寿命。当前 64 °C 虽未降速，但已经明显偏高，建议：

1. 检查 NVMe 是否有散热片
2. 确认机箱风道（尤其这颗盘紧邻显卡的话）
3. 关注是否随负载继续升高

### 上一轮失败的三个真实原因（都已修复）

| # | 问题 | 现象 | 修复 |
| --- | --- | --- | --- |
| 1 | 用 `Assembly.Load(byte[])` 加载 | `Assembly.Location` 为空，LHM 无法定位驱动释放目录 | 改为**先把库复制到 ASCII 路径再 `LoadFrom`** |
| 2 | 中文路径 | CLR 判定为远程程序集，`0x80131515` | 暂存到 `%TEMP%\sysmon-lhm`（纯 ASCII） |
| 3 | `$computer.Close()` | 该平台下**栈溢出崩溃**，进程非零退出 | 子进程隔离：先输出 JSON 再 `[Environment]::Exit(0)` |

第 3 点值得强调：即使数据已经全部打印出来，`Close()` 仍会在库内部触发
`StackOverflowException`，导致进程以 `0xC00000FD` 退出。这在 LHM 0.9.6 + 该主板的组合上是死循环。
解决办法是把读取逻辑放进子进程，父进程只读它的 stdout，**以「是否拿到合法 JSON」判断成功，不看退出码**。

> 定位过程：`tools/bisect-thermal.ps1` 把流程切成 9 个阶段逐个打印，前 8 个阶段全部通过、
> 第 9 阶段（`Close`）崩溃，从而锁定问题点。

## 五、能不能让监控也读到 CPU 温度

### ❌ 方案一：复用 AIDA64 的驱动 — 不可行

实测尝试打开设备：

```
\\.\AIDA64Driver        -> EPERM / Access denied
\\.\Global\AIDA64Driver -> EPERM / Access denied
```

AIDA64 对该设备加了 ACL，只允许自身进程访问。而且它的 IOCTL 协议未公开，
逆向属于另一项工程，且涉及绕过商业软件的保护，不做。

### ⚠️ 方案二：自己写 Ring0 驱动读 MSR — 理论可行，不建议

海光 C86 基于 AMD Zen，温度在 `SMN` 地址 `THM_TCON_CUR_TMP`（`0x00059800`）的 `[21:14]` 位。
读它需要：

1. 一个内核驱动（自行签名或开启测试签名模式）
2. 通过 `PCI 0xCF8/0xCFC` 访问 SMN 索引/数据寄存器
3. 为 `Family 0x18` 补上 LHM 缺失的实现

代价：需要驱动签名（否则每次重启要按 F8）、有蓝屏风险、维护成本高。
**除非长期需要，否则不划算。**

### ✅ 方案三：让 AIDA64 把数据吐出来 — 最现实

AIDA64 自带外部导出能力，这是唯一不需要我们自己碰 Ring0 的路子：

| 方式 | 说明 |
| --- | --- |
| **Shared Memory** | 偏好设置 → 外部应用程序 → 启用共享内存；可被其它进程读取 |
| **HTTP 服务** | 偏好设置 → 外部应用程序 → 启用 HTTP 服务，默认端口 80，访问 `/aida64` 得到 JSON/XML |
| **写日志** | 外部应用程序 → 启用写日志，定期写 CSV |

启用 HTTP 服务后，我可以给监控加一个数据源，直接读 AIDA64 的 JSON，这样
**CPU 温度、风扇转速、电压全都能拿到**，且不需要我们自己写驱动。

需要你在 AIDA64 界面里手动开启（`设置 → 外部应用程序 → 启用 HTTP 服务`），
因为它的配置存在注册表里，需要交互确认。

### 方案四：换支持该平台的软件

- 服务器厂商（曙光/中科可控）的管理工具
- BMC/IPMI 带外管理（上一轮已确认本机无 BMC 通道）

## 六、当前监控的状态

| 指标 | 状态 |
| --- | --- |
| CPU 利用率 / 内存 | ✅ |
| 磁盘 I/O | ✅ |
| 网络收发 / 利用率 / 错包 | ✅ |
| **磁盘温度（NVMe 64°C / HDD 41°C）** | ✅ **本轮新增** |
| **GPU 温度（51°C）** | ✅ **本轮新增** |
| CPU 温度 | ❌ 平台限制（LHM 无海光支持） |
| 风扇转速 | ❌ 主板 SuperIO 未适配 |

页面上会明确标注「CPU 温度读不到」及原因，**不会用磁盘温度冒充 CPU 温度**。

## 七、相关脚本

| 脚本 | 用途 |
| --- | --- |
| `collectors/scripts/thermal-lib.ps1` | 当前生产用：子进程隔离读温度 |
| `tools/bisect-thermal.ps1` | 分阶段定位 LHM 崩溃点 |
| `tools/probe-aida-device.mjs` | 测试 AIDA64 驱动设备能否打开 |
| `tools/diagnose-lhm.ps1` | LHM 硬件树诊断 |
| `tools/probe-all-temperature.ps1` | 全数据源探测（ACPI/WMI/IPMI/SuperIO/LHM） |
