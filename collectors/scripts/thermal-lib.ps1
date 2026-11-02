# Wrapper that runs the sensor read in a child process and captures its stdout
# BEFORE the child can crash during teardown.
#
# Why: LibreHardwareMonitorLib 0.9.6 overflows the stack on this platform
# (Hygon C86 / Suma board) when the Computer object is finalized or the process exits,
# even though every sensor value has already been produced. Running the read in a
# child and reading its stdout lets us keep the data despite the crash.
#
# Output: the child's JSON, or a structured error.

param(
    [string]$SourceDir = '',
    [string]$StageDir  = '',
    [int]$TimeoutMs    = 25000
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

function Emit($Obj) { [Console]::Out.Write(($Obj | ConvertTo-Json -Depth 6 -Compress)) }

function Fail($Code, $Message) {
    Emit ([pscustomobject]@{
        ok = $false; error = $Code; message = $Message; sensors = @()
        cpuTempCount = 0; tempCount = 0; fanCount = 0; maxTempC = $null
        driverLoaded = $false
        timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    })
    exit 0
}

if (-not $SourceDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $SourceDir = Join-Path (Split-Path -Parent (Split-Path -Parent $scriptDir)) 'tools\lhm'
}
if (-not $StageDir) { $StageDir = Join-Path $env:TEMP 'sysmon-lhm' }

if (-not (Test-Path (Join-Path $SourceDir 'LibreHardwareMonitorLib.dll'))) {
    Fail 'lib-missing' "LibreHardwareMonitorLib.dll not found in $SourceDir"
}

# ---------------------------------------------------------------- stage into ASCII path
try {
    if (-not (Test-Path $StageDir)) { New-Item -ItemType Directory -Force -Path $StageDir | Out-Null }
    $srcDll = Join-Path $SourceDir 'LibreHardwareMonitorLib.dll'
    $dstDll = Join-Path $StageDir 'LibreHardwareMonitorLib.dll'
    $copy = $true
    if (Test-Path $dstDll) {
        if ((Get-Item $srcDll).Length -eq (Get-Item $dstDll).Length) { $copy = $false }
    }
    if ($copy) {
        Copy-Item (Join-Path $SourceDir '*.dll') $StageDir -Force
    }
} catch { Fail 'stage-failed' $_.Exception.Message }

# ---------------------------------------------------------------- elevation
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail 'not-elevated' 'Elevation required for hardware sensors.'
}

# ---------------------------------------------------------------- write inner worker
# The inner script must live on an ASCII path too, otherwise -File mangles the path.
$inner = Join-Path $StageDir 'read-sensors.ps1'
$innerBody = @'
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$StageDir = $env:SYSMON_LHM_STAGE

$onResolve = {
    param($s, $e)
    try {
        $n = (New-Object System.Reflection.AssemblyName($e.Name)).Name
        $c = Join-Path $StageDir ($n + ".dll")
        if (Test-Path $c) { return [System.Reflection.Assembly]::LoadFrom($c) }
    } catch { }
    return $null
}
[System.AppDomain]::CurrentDomain.add_AssemblyResolve($onResolve)

$asm = [System.Reflection.Assembly]::LoadFrom((Join-Path $StageDir "LibreHardwareMonitorLib.dll"))
$ct  = $asm.GetType("LibreHardwareMonitor.Hardware.Computer")
$c   = [Activator]::CreateInstance($ct)
$c.IsCpuEnabled = $true
$c.IsMotherboardEnabled = $true
$c.IsMemoryEnabled = $false
$c.IsGpuEnabled = $true
$c.IsStorageEnabled = $true
$c.IsNetworkEnabled = $false
$c.IsControllerEnabled = $false
$c.IsPsuEnabled = $false
$c.Open()

$list = New-Object System.Collections.ArrayList
$cpuTemp = 0

function Walk($hw, [bool]$isCpu, [int]$depth) {
    if ($depth -gt 4) { return }
    try { $hw.Update() } catch { }
    $hwType = $hw.HardwareType.ToString()
    $isCpuNode = $isCpu -or ($hwType -eq "Cpu")
    foreach ($s in $hw.Sensors) {
        if ($null -eq $s) { continue }
        $st = $s.SensorType.ToString()
        if ($st -ne "Temperature" -and $st -ne "Fan") { continue }
        if ($null -eq $s.Value) { continue }
        $v = [double]$s.Value
        if ($st -eq "Temperature") {
            if ($v -le 0 -or $v -ge 150) { continue }
            # NVMe/SMART expose Warning/Critical thresholds alongside real readings.
            # Reporting a 129 C "temperature" would be alarming and wrong, so drop them.
            if ($s.Name -match 'Warning|Critical|Threshold|Max|Min') { continue }
        }
        else { if ($v -le 0 -or $v -gt 30000) { continue } }
        if ($isCpuNode -and $st -eq "Temperature") { $script:cpuTemp++ }
        [void]$list.Add([pscustomobject]@{
            source = "lhm"; name = $s.Name; hardware = $hw.Name
            hwType = $hwType; type = $st; value = [math]::Round($v, 1)
        })
    }
    foreach ($sub in $hw.SubHardware) { Walk $sub $isCpuNode ($depth + 1) }
}

foreach ($hw in $c.Hardware) { Walk $hw $false 0 }

$temps = @($list | Where-Object { $_.type -eq "Temperature" })
$fans  = @($list | Where-Object { $_.type -eq "Fan" })
$maxT  = if ($temps.Count -gt 0) { ($temps | Measure-Object -Property value -Maximum).Maximum } else { $null }

$payload = [pscustomobject]@{
    ok = $true; error = $null
    sensors = @($list | Select-Object -First 40)
    tempCount = $temps.Count; fanCount = $fans.Count
    cpuTempCount = $script:cpuTemp; maxTempC = $maxT
    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

# Emit and terminate hard: the library overflows the stack during normal teardown,
# which would otherwise truncate or lose this output.
[Console]::Out.Write(($payload | ConvertTo-Json -Depth 6 -Compress))
[Console]::Out.Flush()
[Environment]::Exit(0)
'@

try {
    Set-Content -Path $inner -Value $innerBody -Encoding ASCII -Force
} catch { Fail 'stage-failed' $_.Exception.Message }

# ---------------------------------------------------------------- run child, capture stdout
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$inner`""
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables['SYSMON_LHM_STAGE'] = $StageDir

try {
    $proc = [System.Diagnostics.Process]::Start($psi)
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    $finished = $proc.WaitForExit($TimeoutMs)
    if (-not $finished) {
        try { $proc.Kill() } catch { }
        Fail 'timeout' "sensor read timed out after ${TimeoutMs}ms"
    }
    $stdout = $outTask.Result
    $stderr = $errTask.Result
} catch {
    Fail 'spawn-failed' $_.Exception.Message
}

# Exit code is unreliable here (the child may crash during teardown after emitting data),
# so judge success purely on whether we got well-formed JSON.
$text = "$stdout"
$start = $text.IndexOf('{')
$end = $text.LastIndexOf('}')
if ($start -lt 0 -or $end -le $start) {
    $detail = if ($stderr) { $stderr.Trim() } else { 'no output' }
    Fail 'no-output' ("sensor read produced no JSON. exit=" + $proc.ExitCode + " detail=" + $detail.Substring(0, [Math]::Min(200, $detail.Length)))
}

$data = $null
try { $data = $text.Substring($start, $end - $start + 1) | ConvertFrom-Json }
catch { Fail 'bad-json' 'sensor read produced unparsable JSON' }

$driverLoaded = $false
try {
    $drv = Get-CimInstance Win32_SystemDriver -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'WinRing0|LibreHardware' -and $_.State -eq 'Running' }
    if ($drv) { $driverLoaded = $true }
} catch { }

$note = $null
if ([int]$data.cpuTempCount -eq 0) {
    $note = 'CPU temperature unavailable: this is a Hygon C86 (AMD Family 0x18) and LibreHardwareMonitor has no Hygon support. Disk and GPU temperatures work.'
}

Emit ([pscustomobject]@{
    ok = $true; error = $null
    sensors = @($data.sensors)
    tempCount = [int]$data.tempCount; fanCount = [int]$data.fanCount
    cpuTempCount = [int]$data.cpuTempCount; maxTempC = $data.maxTempC
    driverLoaded = $driverLoaded; note = $note
    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
})
