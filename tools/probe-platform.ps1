# Platform forensics for CPU performance assessment.
# Why: DDR4-3200 dual-channel measures only 5-7 GB/s here; expected 30-38 GB/s.
# This script gathers the facts needed to explain it. ASCII only.

$ErrorActionPreference = 'SilentlyContinue'

function Section($t) { Write-Host "`n=== $t ===" }

Section "1) platform and virtualisation"
$cs = Get-CimInstance Win32_ComputerSystem
Write-Host ("Vendor/Model       : {0} / {1}" -f $cs.Manufacturer, $cs.Model)
Write-Host ("HypervisorPresent  : {0}" -f $cs.HypervisorPresent)
Write-Host ("TotalPhysicalMemory: {0:N1} GB" -f ($cs.TotalPhysicalMemory / 1GB))
Write-Host ("NumberOfProcessors : {0}" -f $cs.NumberOfProcessors)

$csp = Get-CimInstance Win32_ComputerSystemProduct
Write-Host ("System UUID        : {0}" -f $csp.UUID)
Write-Host ("System Version     : {0}" -f $csp.Version)

Section "2) memory modules"
$mods = Get-CimInstance Win32_PhysicalMemory
Write-Host ("module count: {0}" -f @($mods).Count)
foreach ($m in $mods) {
    Write-Host ("  {0,-16} {1,3} GB  {2} MHz  {3}" -f $m.DeviceLocator, ($m.Capacity / 1GB), $m.Speed, $m.PartNumber)
}
$arr = Get-CimInstance Win32_PhysicalMemoryArray
Write-Host ("total slots: {0}" -f $arr.MemoryDevices)

Section "3) NUMA topology"
$numa = Get-CimInstance Win32_NumaNode
Write-Host ("NUMA nodes: {0}" -f @($numa).Count)
foreach ($n in $numa) {
    Write-Host ("  node {0}: {1:N1} GB" -f $n.NodeId, ($n.TotalPhysicalMemory / 1GB))
}

Section "4) CPU specs"
$cpu = Get-CimInstance Win32_Processor
Write-Host ("Name          : {0}" -f $cpu.Name)
Write-Host ("Cores/Threads : {0} / {1}" -f $cpu.NumberOfCores, $cpu.NumberOfLogicalProcessors)
Write-Host ("MaxClock      : {0} MHz" -f $cpu.MaxClockSpeed)
Write-Host ("L2 / L3       : {0} KB / {1} KB" -f $cpu.L2CacheSize, $cpu.L3CacheSize)
Write-Host ("VirtFirmware  : {0}" -f $cpu.VirtualizationFirmwareEnabled)

Section "5) Hyper-V traces"
$vm = Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match 'Hyper-V|Virtual Machine Bus|VMBus' }
if ($vm) {
    foreach ($v in $vm) { Write-Host ("  device: {0} [{1}]" -f $v.Name, $v.Status) }
} else { Write-Host "  none" }

$svcNames = @('vmcompute', 'vmms', 'VMSMP')
foreach ($n in $svcNames) {
    $s = Get-Service -Name $n
    if ($s) { Write-Host ("  service {0} = {1}" -f $s.Name, $s.Status) }
}

Section "6) power plan"
$plan = powercfg /getactivescheme 2>&1
Write-Host ($plan -join "`n")

Section "7) actual clock behaviour"
$perf = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation | Where-Object { $_.Name -eq '_Total' }
if ($perf) {
    Write-Host ("  PercentProcessorPerformance : {0}%" -f $perf.PercentProcessorPerformance)
    Write-Host ("  PercentProcessorFrequency   : {0}%" -f $perf.PercentProcessorFrequency)
    Write-Host ("  ProcessorFrequency (MHz)    : {0}" -f $perf.ProcessorFrequency)
} else {
    Write-Host "  perf counters unavailable"
}

Section "8) memory pressure / page file"
$os = Get-CimInstance Win32_OperatingSystem
Write-Host ("  FreePhysicalMemory : {0:N1} GB" -f ($os.FreePhysicalMemory / 1MB))
Write-Host ("  TotalVisibleMemory : {0:N1} GB" -f ($os.TotalVisibleMemorySize / 1MB))
