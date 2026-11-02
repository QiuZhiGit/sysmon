# Probe every temperature/fan source available on this machine.
# Answer one question: is there ANY path that yields a real sensor reading,
# or is the hardware simply not exposing it to the OS?
# Run elevated. ASCII only (PowerShell 5.1 mis-decodes BOM-less UTF-8).

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

function Section($t) { Write-Host "`n=== $t ===" }

Section "0) identity"
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
Write-Host ("user     : {0}" -f $id.Name)
Write-Host ("elevated : {0}" -f $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

Section "1) machine identity"
$bb = Get-CimInstance Win32_BaseBoard
Write-Host ("Board    : {0} / {1} / {2}" -f $bb.Manufacturer, $bb.Product, $bb.Version)
$bios = Get-CimInstance Win32_BIOS
Write-Host ("BIOS     : {0} / {1} / {2}" -f $bios.Manufacturer, $bios.Version, $bios.ReleaseDate)
$cs = Get-CimInstance Win32_ComputerSystem
Write-Host ("System   : {0} / {1} / {2}" -f $cs.Manufacturer, $cs.Model, $cs.SystemType)

Section "2) ACPI thermal zones"
$tz = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature
if ($tz) {
    foreach ($z in $tz) {
        $c = ($z.CurrentTemperature / 10.0) - 273.15
        Write-Host ("  {0} = {1:N1} C" -f $z.InstanceName, $c)
    }
} else { Write-Host "  NONE" }

Section "3) Win32_TemperatureProbe"
$tp = Get-CimInstance Win32_TemperatureProbe
if ($tp) { foreach ($p in $tp) { Write-Host ("  {0} CurrentReading={1} Status={2}" -f $p.Name, $p.CurrentReading, $p.Status) } }
else { Write-Host "  NONE" }

Section "4) Win32_Fan"
$fan = Get-CimInstance Win32_Fan
if ($fan) { foreach ($f in $fan) { Write-Host ("  {0} DesiredSpeed={1} Status={2}" -f $f.Name, $f.DesiredSpeed, $f.Status) } }
else { Write-Host "  NONE" }

Section "5) out-of-band IPMI/BMC"
$ipmiSvc = Get-Service -Name 'IPMIManagement','IPMIDRV','IPMI'
if ($ipmiSvc) { $ipmiSvc | ForEach-Object { Write-Host ("  service {0} = {1}" -f $_.Name, $_.Status) } }
else { Write-Host "  no IPMI service" }

$ipmiDev = Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match 'IPMI|BMC|Baseboard Management' }
if ($ipmiDev) { $ipmiDev | ForEach-Object { Write-Host ("  device: {0} [{1}]" -f $_.Name, $_.Status) } }
else { Write-Host "  no IPMI/BMC device" }

$ipmiClass = Get-CimClass -Namespace root/wmi -ClassName 'Ipmi*'
if ($ipmiClass) { $ipmiClass | ForEach-Object { Write-Host ("  wmi class: {0}" -f $_.CimClassName) } }
else { Write-Host "  no IPMI WMI class" }

Section "6) SuperIO / chipset devices"
$superio = Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match 'SuperIO|SIO|ITE|Nuvoton|Fintek|Winbond' }
if ($superio) { $superio | ForEach-Object { Write-Host ("  {0} [{1}]" -f $_.Name, $_.Status) } }
else { Write-Host "  no SuperIO device enumerated" }

Section "7) LHM hardware tree recheck"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$libDir = Join-Path (Split-Path -Parent $scriptDir) 'tools\lhm'
$dll = Join-Path $libDir 'LibreHardwareMonitorLib.dll'
if (Test-Path $dll) {
    $onResolve = {
        param($s, $e)
        try {
            $n = (New-Object System.Reflection.AssemblyName($e.Name)).Name
            $c = Join-Path $libDir ($n + '.dll')
            if (Test-Path $c) { return [System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($c)) }
        } catch { }
        return $null
    }
    [System.AppDomain]::CurrentDomain.add_AssemblyResolve($onResolve)
    try {
        $asm = [System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($dll))
        $ct = $asm.GetType('LibreHardwareMonitor.Hardware.Computer')
        $comp = [Activator]::CreateInstance($ct)
        $comp.IsCpuEnabled = $true
        $comp.IsMotherboardEnabled = $true
        $comp.Open()
        $tempSeen = 0; $fanSeen = 0; $total = 0
        foreach ($hw in $comp.Hardware) {
            try { $hw.Update() } catch { }
            foreach ($s in $hw.Sensors) {
                $total++
                $t = $s.SensorType.ToString()
                if ($t -eq 'Temperature') { $tempSeen++ }
                if ($t -eq 'Fan') { $fanSeen++ }
            }
            foreach ($sub in $hw.SubHardware) {
                try { $sub.Update() } catch { }
                foreach ($s in $sub.Sensors) {
                    $total++
                    $t = $s.SensorType.ToString()
                    if ($t -eq 'Temperature') { $tempSeen++ }
                    if ($t -eq 'Fan') { $fanSeen++ }
                }
            }
        }
        Write-Host ("  nodes={0} sensors={1} temp={2} fan={3}" -f @($comp.Hardware).Count, $total, $tempSeen, $fanSeen)
        $comp.Close()
    } catch {
        Write-Host ("  LHM recheck failed: {0}" -f $_.Exception.Message)
    }
} else { Write-Host "  LHM library not installed" }

Section "8) verdict"
Write-Host "  If every source above is empty, the OS has no path to the sensors."
Write-Host "  The only reliable route left is BMC/IPMI over the network."
