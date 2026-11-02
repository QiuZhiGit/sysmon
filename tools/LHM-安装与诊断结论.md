# LibreHardwareMonitor 安装与诊断结论

安装日期：2026-11-02
版本：**v0.9.6**（GitHub 最新 release，发布于 2026-02-14）

## 结论先说

**本机装好 LibreHardwareMonitor 后，依然读不到 CPU 温度，也读不到风扇转速。**

这不是安装失败，也不是调用方式错误——是**硬件平台不被支持**。详见下面的实测证据。

## 已完成的工作

| 步骤 | 结果 |
| --- | --- |
| 下载 v0.9.6 | ✅ 6632626 字节，与官方 asset 大小一致 |
| SHA256 | `086D9F1B5A99E643EDC2CFAAAC16051685B551E4C5AC0B32A57C58C0E529C001` |
| 安装位置 | `sysmon/tools/lhm/`（工作区规则：配置与工具放工作区，不散落系统盘） |
| 库加载 | ✅ `LibreHardwareMonitorLib, Version=0.9.6.0` |
| Computer.Open() | ✅ 成功，识别出 17 个硬件节点 |
| 温度传感器 | ❌ **0 个** |
| 风扇传感器 | ❌ **0 个** |

下载说明：本机 `github.com` 不可达（release CDN 被阻断），`api.github.com` 可达。
最终通过 `ghproxy.net` 镜像取得，大小与官方 asset 完全一致。

## 关键实测证据

诊断脚本：`tools/diagnose-lhm.ps1`（需管理员运行）。输出摘要：

```
user      : NT AUTHORITY\SYSTEM
elevated  : True
loaded    : LibreHardwareMonitorLib, Version=0.9.6.0

top-level count: 17
- 22DC4_2  [Motherboard]  sensors=0          <-- 主板 0 个传感器
- Hygon C86-3G (OPN:3350)  [Cpu]  sensors=1  <-- 只有 1 个，且是 Load（负载）
    Load           x1
- Hygon C86-3G (OPN:3350)  [Cpu]  sensors=0  <-- 其余 15 个 CPU 节点全为空
...（共 16 个 CPU 节点，仅 1 个有传感器）

total sensors across tree: 1

CPU: Hygon C86-3G (OPN:3350) / HygonGenuine / AMD64 Family 24 Model 2 Stepping 2
Board: Suma 22DC4_2
```

### 为什么读不到

1. **主板是 `Suma 22DC4_2`** —— 国产信创服务器平台。温度与风扇转速依赖主板上的 **SuperIO** 芯片，LHM 没有为这个型号适配寄存器布局，所以主板节点 `sensors=0`。
2. **CPU 是海光 Hygon C86-3G** —— AMD Zen 授权的国产化产品。LHM 对 AMD 的温度读取走 SMN/PCI 寄存器，海光在 `Family 24 Model 2` 上未提供相同的温度寄存器接口，因此 16 个 CPU 节点全空。
3. 权限已排除嫌疑：进程以 `NT AUTHORITY\SYSTEM` 运行、`elevated=True`，内核驱动可以正常加载（否则 `Open()` 会失败）。

## 安装过程中的三个技术障碍（都已解决，供以后参考）

### 1. GUI 不可用

`LibreHardwareMonitor.exe` 的 manifest 声明 `requireAdministrator`，且是 WinForms 程序，**必须有桌面会话**。无桌面环境下无法启动，其内置的 Web Server（8085 端口，`data.json`）也就无法开启。

**解决**：不跑 GUI，改用包里附带的 `LibreHardwareMonitorLib.dll`，用 PowerShell 反射直接调用。这样无需界面、不占端口、也不用每次开机手点「Enable Web Server」。

### 2. `0x80131515` 程序集加载失败

`Assembly.LoadFrom` 与 `Add-Type -Path` 都失败：

```
Could not load file or assembly 'file:///D:\...\LibreHardwareMonitorLib.dll'
Operation is not supported. (HRESULT: 0x80131515)
```

原因是 CLR 把含中文的工作区路径判定为「远程来源」（`loadFromRemoteSources` 未启用）。
文件本身**没有** `Zone.Identifier` 标记，`Unblock-File` 无效。

**解决**：用 `Assembly.Load(byte[])` 读字节后加载，绕开位置检查。已实测这是本机唯一可行方式。

### 3. 中文路径经 `-File` 传参会乱码

```
Could not find a part of the path 'D:\DeepseekHarness宸ヤ綔鍖篭sysmon\...'
```

**解决**：脚本内部用 `$MyInvocation.MyCommand.Path` 自行推导目录，不依赖命令行传中文路径。

## 现在系统的行为

服务已接入 LHM，`source` 字段会显示实际尝试的路径：

```json
"thermal": {
  "available": false,
  "source": "lib",
  "sensors": [],
  "error": "LibreHardwareMonitor 已加载，但本机硬件未暴露温度/风扇传感器"
}
```

**只要将来换成 LHM 支持的平台（常见消费级主板 + Intel/AMD 零售 CPU），同一套代码会自动读到温度，无需改任何配置。**

## 还能怎么办

如果确实需要这台机器的温度，可选：

1. **服务器带外管理**：信创服务器通常有 BMC/IPMI。用 `ipmitool sdr` 能读到 CPU 温度与风扇转速，那是独立于操作系统的硬件管理芯片，最可靠。前提是 BMC 已接入网络。
2. **主板厂商工具**：联系曙光/中科可控（Suma 为曙光系）索取该平台的监控工具。
3. **接受现状**：CPU 与内存利用率、磁盘 I/O、硬件告警巡检都已正常工作，温度缺失不影响主要运维判断。

## 文件清单

| 路径 | 用途 |
| --- | --- |
| `sysmon/tools/lhm/` | LibreHardwareMonitor v0.9.6 完整文件（11.6 MB，含 32 个文件） |
| `sysmon/collectors/scripts/thermal-lib.ps1` | 通过 DLL 直读传感器 |
| `sysmon/tools/diagnose-lhm.ps1` | 硬件树诊断，确认 LHM 到底看到了什么 |
| `sysmon/tools/probe-load.ps1` | 验证三种程序集加载方式哪种可用 |
| `sysmon/tools/lhm-download/` | 下载的原始 zip 与解压副本（可删，省 20 MB） |

清理下载缓存（保留已安装的 `tools/lhm/`）：

```powershell
Remove-Item -Recurse -Force "D:\DeepseekHarness工作区\sysmon\tools\lhm-download"
```
