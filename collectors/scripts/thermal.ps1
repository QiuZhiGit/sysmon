# Collect CPU temperature / fan sensors from every source that works on this machine.
# Output: single-line ASCII JSON so the parent process never has to guess the encoding.
# Every source is tried independently; whatever is missing is simply absent from "sources".

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

# Force UTF-8 on stdout so non-ASCII sensor / adapter names survive the pipe.
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$sensors = New-Object System.Collections.ArrayList
$sources = New-Object System.Collections.ArrayList

function Add-Sensor {
    param([string]$Source, [string]$Name, [string]$Type, [double]$Value)

    # Reject obviously bogus readings.
    # Temperature: 0 C is the classic "sensor not present" placeholder, and anything
    # outside -20..150 C is impossible for a live CPU. Must be a strict lower bound
    # because 0 is exactly what broken ACPI zones report.
    if ($Type -eq 'Temperature') {
        if ($Value -le 0 -or $Value -ge 150) { return }
    } elseif ($Type -eq 'Fan') {
        if ($Value -le 0 -or $Value -gt 30000) { return }
    }

    # De-duplicate identical source/name pairs
    foreach ($s in $sensors) {
        if ($s.source -eq $Source -and $s.name -eq $Name -and $s.type -eq $Type) { return }
    }

    [void]$sensors.Add([pscustomobject]@{
        source = $Source
        name   = $Name
        type   = $Type
        value  = [math]::Round($Value, 1)
    })
}

# ---------------------------------------------------------------- 1) ACPI thermal zones
try {
    $zones = Get-CimInstance -Namespace 'root/wmi' -ClassName 'MSAcpi_ThermalZoneTemperature'
    if ($zones) {
        [void]$sources.Add('acpi')
        foreach ($z in $zones) {
            if ($null -eq $z.CurrentTemperature) { continue }
            # ACPI reports tenths of a Kelvin
            $celsius = ($z.CurrentTemperature / 10.0) - 273.15
            Add-Sensor -Source 'acpi' -Name ("$($z.InstanceName)") -Type 'Temperature' -Value $celsius
        }
    }
} catch { }

# ---------------------------------------------------------------- 2) LibreHardwareMonitor / OpenHardwareMonitor WMI
# Works when the monitor app is running with its WMI provider enabled (needs admin usually).
foreach ($ns in @('root/LibreHardwareMonitor', 'root/OpenHardwareMonitor')) {
    try {
        $hs = Get-CimInstance -Namespace $ns -ClassName 'Sensor'
        if (-not $hs) { continue }
        $tag = if ($ns -like '*Libre*') { 'lhm' } else { 'ohm' }
        [void]$sources.Add($tag)
        foreach ($h in $hs) {
            if ($h.SensorType -notin @('Temperature', 'Fan')) { continue }
            if ($null -eq $h.Value) { continue }
            $name = if ($h.Name) { $h.Name } else { "Sensor$($h.Identifier)" }
            Add-Sensor -Source $tag -Name $name -Type $h.SensorType -Value ([double]$h.Value)
        }
    } catch { }
}

# ---------------------------------------------------------------- 3) OpenHardwareMonitor / LHM local web API
# These apps expose /data.json on their built-in web server (port differs per app).
foreach ($entry in @(
        @{ Port = 8085; Tag = 'ohm-http' },
        @{ Port = 8086; Tag = 'ohm-http' },
        @{ Port = 8080; Tag = 'lhm-http' })) {
    try {
        $resp = Invoke-RestMethod -Uri ("http://localhost:{0}/data.json" -f $entry.Port) -TimeoutSec 3
        if (-not $resp) { continue }
        [void]$sources.Add($entry.Tag)
        foreach ($node in $resp.Children) {
            foreach ($group in $node.Children) {
                foreach ($item in $group.Children) {
                    if (-not $item) { continue }
                    if ($item.Type -in @('Temperature', 'Fan')) {
                        if ($null -eq $item.Value) { continue }
                        Add-Sensor -Source $entry.Tag -Name $item.Text -Type $item.Type -Value ([double]$item.Value)
                    }
                }
            }
        }
    } catch { }
}

# ---------------------------------------------------------------- 4) Thermal Zone information (best effort)
# Note: this class is a state enum, not a temperature. Kept for diagnostics only.
$diag = $null
try {
    $tz = Get-CimInstance -Namespace 'root/wmi' -ClassName 'MSAcpi_ThermalZoneTemperature'
    if ($tz) { $diag = 'MSAcpi_ThermalZoneTemperature returned {0} zone(s)' -f @($tz).Count }
    else { $diag = 'MSAcpi_ThermalZoneTemperature returned nothing' }
} catch {
    $diag = 'MSAcpi_ThermalZoneTemperature unavailable: ' + $_.Exception.Message
}

# ---------------------------------------------------------------- output
$temps = @($sensors | Where-Object { $_.type -eq 'Temperature' })
$fans  = @($sensors | Where-Object { $_.type -eq 'Fan' })

$result = [pscustomobject]@{
    ok          = $true
    sources     = @($sources)
    sensorCount = $sensors.Count
    maxTempC    = if ($temps.Count -gt 0) { ($temps | Measure-Object -Property value -Maximum).Maximum } else { $null }
    fanCount    = $fans.Count
    sensors     = @($sensors | Select-Object -First 24)
    diag        = $diag
    timestamp   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

$json = $result | ConvertTo-Json -Depth 5 -Compress
[Console]::Out.Write($json)
