# Scan the System log for hardware / stability warning signs.
# Param: window in hours (default 168 = 7 days).
# Output: single-line ASCII JSON. Event *keys* are ASCII; Chinese labels live in hardware.js.

param(
    [int]$Hours = 168
)

$ErrorActionPreference = 'SilentlyContinue'

if ($Hours -le 0 -or $Hours -gt 8760) { $Hours = 168 }
$since = (Get-Date).AddHours(-$Hours)

$items = New-Object System.Collections.ArrayList

function Add-Bucket {
    param([string]$Key, [int]$Count, $LastTime)

    if ($Count -le 0) { return }
    [void]$items.Add([pscustomobject]@{
        key      = $Key
        count    = $Count
        lastTime = if ($LastTime) { ([DateTime]$LastTime).ToString('yyyy-MM-dd HH:mm:ss') } else { $null }
    })
}

# ---------------------------------------------------------------- kernel power 41 / 6008
# 41  = system rebooted without a clean shutdown (power loss, hard hang, PSU issue)
# 6008 = previous shutdown was unexpected
try {
    $e = Get-WinEvent -FilterHashtable @{
        LogName   = 'System'
        Id        = 41
        StartTime = $since
    } -MaxEvents 200
    Add-Bucket -Key 'unexpected-shutdown' -Count @($e).Count -LastTime ($e | Select-Object -First 1).TimeCreated
} catch { }

try {
    $e = Get-WinEvent -FilterHashtable @{
        LogName   = 'System'
        Id        = 6008
        StartTime = $since
    } -MaxEvents 200
    Add-Bucket -Key 'unexpected-shutdown-evlog' -Count @($e).Count -LastTime ($e | Select-Object -First 1).TimeCreated
} catch { }

# ---------------------------------------------------------------- bugcheck (blue screen)
try {
    $e = Get-WinEvent -FilterHashtable @{
        LogName   = 'System'
        Id        = 1001
        StartTime = $since
        ProviderName = 'Microsoft-Windows-WER-SystemErrorReporting'
    } -MaxEvents 200
    Add-Bucket -Key 'bugcheck' -Count @($e).Count -LastTime ($e | Select-Object -First 1).TimeCreated
} catch { }

# ---------------------------------------------------------------- WHEA hardware errors
# 17/18/19/47 = corrected/uncorrected machine check, PCIe, memory errors
try {
    $e = Get-WinEvent -FilterHashtable @{
        LogName      = 'System'
        ProviderName = 'Microsoft-Windows-WHEA-Logger'
        StartTime    = $since
    } -MaxEvents 300
    Add-Bucket -Key 'hardware-error' -Count @($e).Count -LastTime ($e | Select-Object -First 1).TimeCreated
} catch { }

# ---------------------------------------------------------------- disk errors
try {
    $e = Get-WinEvent -FilterHashtable @{
        LogName      = 'System'
        ProviderName = @('disk', 'storahci', 'stornvme', 'iaStorA', 'nvlddmkm')
        Id           = @(7, 9, 11, 15, 51, 52, 153, 154)
        StartTime    = $since
    } -MaxEvents 300
    Add-Bucket -Key 'disk-error' -Count @($e).Count -LastTime ($e | Select-Object -First 1).TimeCreated
} catch { }

# ---------------------------------------------------------------- NTFS / volume corruption
try {
    $e = Get-WinEvent -FilterHashtable @{
        LogName      = 'System'
        ProviderName = @('Ntfs', 'Microsoft-Windows-Ntfs')
        Id           = @(55, 98, 130, 131)
        StartTime    = $since
    } -MaxEvents 300
    Add-Bucket -Key 'ntfs-error' -Count @($e).Count -LastTime ($e | Select-Object -First 1).TimeCreated
} catch { }

$result = [pscustomobject]@{
    ok          = $true
    windowHours = $Hours
    since       = $since.ToString('yyyy-MM-dd HH:mm:ss')
    items       = @($items)
    timestamp   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

$json = $result | ConvertTo-Json -Depth 5 -Compress
[Console]::Out.Write($json)
