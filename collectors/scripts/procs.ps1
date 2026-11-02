# Top memory-consuming processes, aggregated by program name.
# ASCII only: PowerShell 5.1 mis-decodes BOM-less UTF-8.
#
# Metric choice: PrivateMemorySize64 ("private bytes"), NOT WorkingSet64.
# Rationale (measured on this box): summing WorkingSet across processes yields
# 4.95 GB (31.2% of RAM) because shared pages get counted repeatedly, while
# summing Private yields 7.85 GB (49.5%), which matches the OS-wide memory
# utilisation. Private is also what Task Manager's per-process "Memory" column
# approximates.
#
# Grouping: by ProcessName, because a browser or Electron app spawns many child
# processes (chrome had 9, svchost 100 here). Listing raw PIDs would bury the
# real answer under duplicates.

param(
    [int]$TopN = 10
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

if ($TopN -lt 1 -or $TopN -gt 50) { $TopN = 10 }

try {
    $os = Get-CimInstance Win32_OperatingSystem
    $totalBytes = [double]$os.TotalVisibleMemorySize * 1KB
    $freeBytes = [double]$os.FreePhysicalMemory * 1KB
    $usedBytes = $totalBytes - $freeBytes

    $procs = Get-Process
    $procCount = @($procs).Count

    # Aggregate by program name
    $groups = $procs | Group-Object -Property ProcessName

    $rows = foreach ($g in $groups) {
        $sumPrivate = 0
        $sumWorking = 0
        $maxId = 0
        foreach ($p in $g.Group) {
            $sumPrivate += [double]$p.PrivateMemorySize64
            $sumWorking += [double]$p.WorkingSet64
            if ($p.Id -gt $maxId) { $maxId = $p.Id }
        }
        [pscustomobject]@{
            name       = $g.Name
            count      = $g.Count
            privateMB  = [math]::Round($sumPrivate / 1MB, 1)
            workingMB  = [math]::Round($sumWorking / 1MB, 1)
            maxPid     = $maxId
            # share of currently USED memory, so the Top-N shares are meaningful
            pctOfUsed  = if ($usedBytes -gt 0) { [math]::Round($sumPrivate / $usedBytes * 100, 2) } else { 0 }
            pctOfTotal = if ($totalBytes -gt 0) { [math]::Round($sumPrivate / $totalBytes * 100, 2) } else { 0 }
        }
    }

    $topRows = @($rows | Sort-Object -Property privateMB -Descending | Select-Object -First $TopN)

    [pscustomobject]@{
        ok           = $true
        totalBytes   = [long]$totalBytes
        usedBytes    = [long]$usedBytes
        freeBytes    = [long]$freeBytes
        usedPercent  = if ($totalBytes -gt 0) { [math]::Round($usedBytes / $totalBytes * 100, 2) } else { 0 }
        processCount = $procCount
        groupCount   = @($groups).Count
        top          = @($topRows)
        timestamp    = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    } | ConvertTo-Json -Depth 5 -Compress
} catch {
    [pscustomobject]@{
        ok        = $false
        error     = $_.Exception.Message
        top       = @()
        timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    } | ConvertTo-Json -Depth 5 -Compress
}
