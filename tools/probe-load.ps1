# Probe: how can this machine load LibreHardwareMonitorLib.dll?
# Tests three loading strategies and reports which one works.

$ErrorActionPreference = 'Stop'
$LibDir = $args[0]
if (-not $LibDir) { $LibDir = 'D:\DeepseekHarness工作区\sysmon\tools\lhm' }
$dll = Join-Path $LibDir 'LibreHardwareMonitorLib.dll'

$results = @()

function Try-Strategy {
    param([string]$Name, [scriptblock]$Block)
    try {
        $out = & $Block
        $script:results += [pscustomobject]@{ strategy = $Name; ok = $true; detail = "$out" }
    } catch {
        $msg = $_.Exception.Message
        $inner = $_.Exception
        $depth = 0
        while ($inner.InnerException -and $depth -lt 5) { $inner = $inner.InnerException; $depth++ }
        if ($depth -gt 0) { $msg = $msg + ' || inner: ' + $inner.Message }
        $script:results += [pscustomobject]@{ strategy = $Name; ok = $false; detail = $msg.Substring(0, [Math]::Min(240, $msg.Length)) }
    }
}

# 1) LoadFrom with explicit path
Try-Strategy 'Assembly.LoadFrom' {
    $a = [System.Reflection.Assembly]::LoadFrom($dll)
    $a.FullName
}

# 2) Load raw bytes (bypasses any location / zone checks entirely)
Try-Strategy 'Assembly.Load(bytes)' {
    $bytes = [System.IO.File]::ReadAllBytes($dll)
    $a = [System.Reflection.Assembly]::Load($bytes)
    $a.FullName
}

# 3) Add-Type -Path
Try-Strategy 'Add-Type -Path' {
    Add-Type -Path $dll
    'added'
}

# 4) Is the file marked as remote?
$zone = Get-Item $dll -Stream Zone.Identifier -ErrorAction SilentlyContinue
$zoneInfo = if ($zone) { 'HAS Zone.Identifier' } else { 'no zone marker' }

# 5) Check .NET 4 remote-source policy for this AppDomain
$policy = [System.AppDomain]::CurrentDomain.GetData('LOADER_OPTIMIZATION')

[pscustomobject]@{
    libDir    = $LibDir
    dllExists = (Test-Path $dll)
    zone      = $zoneInfo
    results   = $results
} | ConvertTo-Json -Depth 5
