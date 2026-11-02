# Self-test: prove the collector pipeline works when sensors DO exist.
# Feeds the exact same parsing/normalisation path with synthetic sensor data,
# so "not available" on this machine can be attributed to hardware, not to code.

$ErrorActionPreference = 'SilentlyContinue'

function Add-Sensor {
    param([string]$Source, [string]$Name, [string]$Type, [double]$Value)
    # Must match thermal.ps1: 0 is a placeholder, not a real reading
    if ($Type -eq 'Temperature') { if ($Value -le 0 -or $Value -ge 150) { return } }
    elseif ($Type -eq 'Fan') { if ($Value -le 0 -or $Value -gt 30000) { return } }
    return [pscustomobject]@{ source = $Source; name = $Name; type = $Type; value = [math]::Round($Value, 1) }
}

$sensors = New-Object System.Collections.ArrayList

# Simulated ACPI zone (the encoding used by real hardware: tenths of Kelvin)
$rawKelvinTenths = [int]((72.5 + 273.15) * 10)
$celsius = ($rawKelvinTenths / 10.0) - 273.15
[void]$sensors.Add((Add-Sensor -Source 'acpi' -Name 'ACPI\ThermalZone_0' -Type 'Temperature' -Value $celsius))

# Simulated LibreHardwareMonitor sensors
[void]$sensors.Add((Add-Sensor -Source 'lhm' -Name 'CPU Package' -Type 'Temperature' -Value 68.4))
[void]$sensors.Add((Add-Sensor -Source 'lhm' -Name 'Core #1' -Type 'Temperature' -Value 65.0))
[void]$sensors.Add((Add-Sensor -Source 'lhm' -Name 'CPU Fan' -Type 'Fan' -Value 1480))

# Bogus values that must be filtered out
$bogus1 = Add-Sensor -Source 'acpi' -Name 'Bogus_Zero' -Type 'Temperature' -Value 0
$bogus2 = Add-Sensor -Source 'acpi' -Name 'Bogus_Hot' -Type 'Temperature' -Value 999
$bogus3 = Add-Sensor -Source 'acpi' -Name 'Bogus_Fan' -Type 'Fan' -Value 999999

$temps = @($sensors | Where-Object { $_.type -eq 'Temperature' })
$fans = @($sensors | Where-Object { $_.type -eq 'Fan' })
$maxTemp = ($temps | Measure-Object -Property value -Maximum).Maximum

$result = [pscustomobject]@{
    sensorCount  = $sensors.Count
    acpiCelsius  = [math]::Round($celsius, 1)
    tempCount    = $temps.Count
    fanCount     = $fans.Count
    maxTempC     = [math]::Round($maxTemp, 1)
    bogusFiltered = ($null -eq $bogus1 -and $null -eq $bogus2 -and $null -eq $bogus3)
    sensors      = @($sensors)
}

[Console]::Out.Write(($result | ConvertTo-Json -Depth 5 -Compress))
