# Deep diagnostic: what hardware does LHM actually see, and why are sensors empty?
# Run elevated. Prints a readable report, not just JSON.

param([string]$LibDir = '')

$ErrorActionPreference = 'Continue'

# Resolve the lib dir from the script location instead of trusting a command-line path:
# passing a Chinese path through -File can arrive mangled depending on the console codepage.
if (-not $LibDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $LibDir = Join-Path (Split-Path -Parent $scriptDir) 'tools\lhm'
}
$dll = Join-Path $LibDir 'LibreHardwareMonitorLib.dll'

Write-Host "=== 1) elevation ==="
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
Write-Host ("user      : {0}" -f $id.Name)
Write-Host ("elevated  : {0}" -f $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

Write-Host "`n=== 2) load assembly ==="
$onResolve = {
    param($sender, $eventArgs)
    try {
        $name = (New-Object System.Reflection.AssemblyName($eventArgs.Name)).Name
        $candidate = Join-Path $LibDir ($name + '.dll')
        if (Test-Path $candidate) { return [System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($candidate)) }
    } catch { }
    return $null
}
[System.AppDomain]::CurrentDomain.add_AssemblyResolve($onResolve)

try {
    $asm = [System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($dll))
    Write-Host ("loaded    : {0}" -f $asm.FullName)
} catch {
    Write-Host ("LOAD FAIL : {0}" -f $_.Exception.Message)
    exit 1
}

Write-Host "`n=== 3) open Computer ==="
$ct = $asm.GetType('LibreHardwareMonitor.Hardware.Computer')
$c = [Activator]::CreateInstance($ct)
$c.IsCpuEnabled = $true
$c.IsMotherboardEnabled = $true
$c.IsMemoryEnabled = $false
$c.IsGpuEnabled = $false
$c.IsStorageEnabled = $false
$c.IsNetworkEnabled = $false
$c.IsControllerEnabled = $false
$c.IsPsuEnabled = $false

try {
    $c.Open()
    Write-Host "Open()    : OK"
} catch {
    $inner = $_.Exception; $d = 0
    while ($inner.InnerException -and $d -lt 5) { $inner = $inner.InnerException; $d++ }
    Write-Host ("Open()    : FAIL - {0}" -f $inner.Message)
    exit 1
}

Write-Host "`n=== 4) hardware tree ==="
Write-Host ("top-level count: {0}" -f @($c.Hardware).Count)

$totalSensors = 0
foreach ($hw in $c.Hardware) {
    Write-Host ("- {0}  [{1}]  sensors={2}" -f $hw.Name, $hw.HardwareType, @($hw.Sensors).Count)
    try { $hw.Update() } catch { Write-Host ("    Update() error: {0}" -f $_.Exception.Message) }

    $byType = @{}
    foreach ($s in $hw.Sensors) {
        $t = $s.SensorType.ToString()
        if (-not $byType.ContainsKey($t)) { $byType[$t] = 0 }
        $byType[$t]++
        $totalSensors++
    }
    foreach ($k in ($byType.Keys | Sort-Object)) {
        Write-Host ("    {0,-14} x{1}" -f $k, $byType[$k])
    }

    # Show the temperature/fan ones specifically
    foreach ($s in $hw.Sensors) {
        $t = $s.SensorType.ToString()
        if ($t -eq 'Temperature' -or $t -eq 'Fan') {
            Write-Host ("    * {0,-12} {1,-32} = {2}" -f $t, $s.Name, $s.Value)
        }
    }

    foreach ($sub in $hw.SubHardware) {
        Write-Host ("  + sub: {0} [{1}] sensors={2}" -f $sub.Name, $sub.HardwareType, @($sub.Sensors).Count)
        try { $sub.Update() } catch { }
        foreach ($s in $sub.Sensors) {
            $t = $s.SensorType.ToString()
            if ($t -eq 'Temperature' -or $t -eq 'Fan') {
                Write-Host ("    * {0,-12} {1,-32} = {2}" -f $t, $s.Name, $s.Value)
            }
            $totalSensors++
        }
    }
}

Write-Host ("`ntotal sensors across tree: {0}" -f $totalSensors)

Write-Host "`n=== 5) CPU identity ==="
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
Write-Host ("Name       : {0}" -f $cpu.Name)
Write-Host ("Manufacturer: {0}" -f $cpu.Manufacturer)
Write-Host ("Description: {0}" -f $cpu.Description)

Write-Host "`n=== 6) board ==="
$board = Get-CimInstance Win32_BaseBoard | Select-Object -First 1
if ($board) { Write-Host ("Board      : {0} {1}" -f $board.Manufacturer, $board.Product) }

try { $c.Close() } catch { }
