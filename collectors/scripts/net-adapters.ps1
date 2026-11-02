# Report network adapter metadata (link speed / status) for utilisation math.
# The flow counters come from typeperf; this only supplies the denominator.
# ASCII only: PowerShell 5.1 mis-decodes BOM-less UTF-8.

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

# Force UTF-8 on stdout so Chinese adapter names (e.g. the built-in "Ethernet"
# localised to the system language) survive the pipe. Without this, Windows
# PowerShell encodes stdout with the OEM code page and non-ASCII becomes mojibake.
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$list = New-Object System.Collections.ArrayList

# Get-NetAdapter needs no elevation, but fall back to CIM for older builds
$adapters = $null
try { $adapters = Get-NetAdapter -ErrorAction Stop } catch { $adapters = $null }

if ($adapters) {
    foreach ($a in $adapters) {
        # LinkSpeed is a string like "1 Gbps"; convert to Mbps
        $mbps = $null
        try {
            $raw = $a.LinkSpeed
            if ($raw -match '([\d\.]+)\s*(Gbps|Mbps|Kbps)') {
                $n = [double]$Matches[1]
                switch ($Matches[2]) {
                    'Gbps' { $mbps = $n * 1000 }
                    'Mbps' { $mbps = $n }
                    'Kbps' { $mbps = $n / 1000 }
                }
            }
        } catch { }

        [void]$list.Add([pscustomobject]@{
            name        = $a.Name
            description = $a.InterfaceDescription
            status      = "$($a.Status)"
            speedMbps   = $mbps
        })
    }
} else {
    # Fallback: CIM exposes Speed (bits per second) and NetConnectionStatus
    $cim = Get-CimInstance Win32_NetworkAdapter -ErrorAction SilentlyContinue |
        Where-Object { $_.NetConnectionID -and $_.Speed }
    foreach ($c in $cim) {
        [void]$list.Add([pscustomobject]@{
            name        = $c.NetConnectionID
            description = $c.Name
            status      = if ($c.NetConnectionStatus -eq 2) { 'Up' } else { 'Down' }
            speedMbps   = [math]::Round($c.Speed / 1e6, 0)
        })
    }
}

# Also expose the PDH instance names, which do not always equal the friendly name.
# PDH uses the adapter description for the "Network Interface" instances.
$pdhNames = New-Object System.Collections.ArrayList
foreach ($a in Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface -ErrorAction SilentlyContinue) {
    [void]$pdhNames.Add([pscustomobject]@{
        instance    = $a.Name
        bytesTotal  = $a.BytesTotalPersec
    })
}

[pscustomobject]@{
    ok       = $true
    adapters = @($list)
    pdhInstances = @($pdhNames | Select-Object -First 30)
    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
} | ConvertTo-Json -Depth 5 -Compress
