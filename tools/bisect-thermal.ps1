# Locate the StackOverflow: run the collector in stages, print progress markers.
$ErrorActionPreference = 'Stop'
$StageDir = Join-Path $env:TEMP 'sysmon-lhm'
Write-Host "STAGE 1: staging"

# Resolve the source dir from the script location: a literal Chinese path in the file
# arrives mangled because this .ps1 is written as UTF-8 without BOM and PowerShell 5.1
# decodes it as ANSI.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir = Join-Path (Split-Path -Parent $scriptDir) 'tools\lhm'
Write-Host ("  source: " + $srcDir)

if (-not (Test-Path $StageDir)) { New-Item -ItemType Directory -Force -Path $StageDir | Out-Null }
Copy-Item (Join-Path $srcDir '*.dll') $StageDir -Force
Write-Host "STAGE 1 OK"

Write-Host "STAGE 2: load"
$asm = [System.Reflection.Assembly]::LoadFrom((Join-Path $StageDir 'LibreHardwareMonitorLib.dll'))
Write-Host ("STAGE 2 OK: " + $asm.GetName().Version)

Write-Host "STAGE 3: create computer"
$ct = $asm.GetType('LibreHardwareMonitor.Hardware.Computer')
$c = [Activator]::CreateInstance($ct)
Write-Host "STAGE 3 OK"

Write-Host "STAGE 4: configure"
$c.IsCpuEnabled = $true
$c.IsMotherboardEnabled = $true
$c.IsMemoryEnabled = $false
$c.IsGpuEnabled = $true
$c.IsStorageEnabled = $true
$c.IsNetworkEnabled = $false
$c.IsControllerEnabled = $false
$c.IsPsuEnabled = $false
Write-Host "STAGE 4 OK"

Write-Host "STAGE 5: Open()"
$c.Open()
Write-Host "STAGE 5 OK"

Write-Host "STAGE 6: enumerate"
$n = 0
foreach ($hw in $c.Hardware) {
    Write-Host ("  node: " + $hw.Name + " [" + $hw.HardwareType + "]")
    $n++
}
Write-Host ("STAGE 6 OK, nodes=" + $n)

Write-Host "STAGE 7: sensors (top level only, no recursion)"
foreach ($hw in $c.Hardware) {
    try { $hw.Update() } catch { Write-Host ("  Update failed on " + $hw.Name) }
    foreach ($s in $hw.Sensors) {
        if ($s.SensorType.ToString() -eq 'Temperature') {
            Write-Host ("  TEMP " + $hw.Name + " / " + $s.Name + " = " + $s.Value)
        }
    }
}
Write-Host "STAGE 7 OK"

Write-Host "STAGE 8: subhardware depth 1"
foreach ($hw in $c.Hardware) {
    foreach ($sub in $hw.SubHardware) {
        Write-Host ("  sub: " + $sub.Name)
        try { $sub.Update() } catch { }
        foreach ($s in $sub.Sensors) {
            if ($s.SensorType.ToString() -eq 'Temperature') {
                Write-Host ("  TEMP " + $sub.Name + " / " + $s.Name + " = " + $s.Value)
            }
        }
    }
}
Write-Host "STAGE 8 OK"

Write-Host "STAGE 9: Close"
$c.Close()
Write-Host "STAGE 9 OK"
Write-Host "ALL DONE"
