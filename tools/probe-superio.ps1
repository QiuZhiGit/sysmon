# Last-resort probe: can we reach the SuperIO / SMBus hardware directly?
#
# Server boards expose CPU temperature and fan tachometers through a SuperIO chip
# (usually at I/O ports 0x2E/0x4E) or through SMBus. If neither the ACPI zones nor
# LHM nor IPMI produce data, the remaining question is whether *anything* is there.
#
# This does NOT write to hardware; it only reports what Windows exposes.
# Run elevated. ASCII only.

$ErrorActionPreference = 'SilentlyContinue'

function Section($t) { Write-Host "`n=== $t ===" }

Section "1) IPMI driver state (after previous start attempt)"
$svc = Get-Service IPMIDRV
Write-Host ("  IPMIDRV: {0} (startType={1})" -f $svc.Status, $svc.StartType)

Section "2) IPMI WMI instances (data, not just class)"
foreach ($cls in @('IPMIPrv', 'IPMIDRIVER')) {
    $inst = Get-CimInstance -Namespace root/wmi -ClassName $cls
    $n = @($inst).Count
    Write-Host ("  {0}: {1} instance(s)" -f $cls, $n)
    if ($n -gt 0) {
        foreach ($i in $inst) {
            Write-Host ("    props: {0}" -f (($i.PSObject.Properties | Where-Object { $_.Name -notmatch '^Cim|^PS' } | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '; '))
        }
    }
}

Section "3) ACPI thermal zone instances (recheck)"
$tz = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature
Write-Host ("  count={0}" -f @($tz).Count)

Section "4) SuperIO related PnP / legacy devices"
# Legacy ISA devices often show up as "System board" style entries
$devs = Get-CimInstance Win32_PnPEntity | Where-Object {
    $_.Name -match 'System board|Motherboard resources|ISA|LPC|SMBus|SMB' -or
    $_.DeviceID -match 'PNP0C02|PNP0C09'
}
if ($devs) {
    foreach ($d in $devs) { Write-Host ("  {0}  [{1}]  {2}" -f $d.Name, $d.Status, $d.DeviceID) }
} else { Write-Host "  none" }

Section "5) does any process expose sensors? (LHM/OHM running)"
$procs = Get-Process | Where-Object { $_.ProcessName -match 'LibreHardware|OpenHardware|HWiNFO|AIDA' }
if ($procs) { $procs | ForEach-Object { Write-Host ("  {0} PID={1}" -f $_.ProcessName, $_.Id) } }
else { Write-Host "  no monitor process running" }

Section "6) BIOS setting hints"
$bios = Get-CimInstance Win32_BIOS
Write-Host ("  Vendor : {0}" -f $bios.Manufacturer)
Write-Host ("  Version: {0}" -f $bios.Version)
Write-Host ("  SMBIOS : {0}" -f $bios.SMBIOSBIOSVersion)

Section "7) summary"
Write-Host "  If sections 2-4 are all empty, this OS has no in-band sensor access at all."
Write-Host "  Only an out-of-band BMC (network) could provide CPU temperature."
