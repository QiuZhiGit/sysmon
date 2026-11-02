# Try to activate the IPMI driver and read sensors through it.
#
# Rationale: this machine ships an IPMIDRV service (Stopped) and the IPMIPrv /
# IPMIDRIVER WMI classes, which is how a BMC is reached from inside Windows.
# If the BMC is available, this bypasses the missing ACPI/SuperIO sensors entirely.
#
# Run elevated. ASCII only.

$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{}

function Section($t) { Write-Host "`n=== $t ===" }

Section "1) service state before"
$svc = Get-Service IPMIDRV
Write-Host ("IPMIDRV: status={0} startType={1}" -f $svc.Status, $svc.StartType)
$out.beforeStatus = "$($svc.Status)"

Section "2) attempt start"
try {
    Start-Service IPMIDRV -ErrorAction Stop
    Write-Host "Start-Service: OK"
} catch {
    Write-Host ("Start-Service: FAILED - {0}" -f $_.Exception.Message)
}
Start-Sleep -Seconds 2
$svc = Get-Service IPMIDRV
Write-Host ("IPMIDRV now: status={0}" -f $svc.Status)
$out.afterStatus = "$($svc.Status)"

Section "3) IPMI WMI classes"
foreach ($cls in @('IPMIPrv', 'IPMIDRIVER')) {
    $c = Get-CimClass -Namespace root/wmi -ClassName $cls
    if ($c) {
        Write-Host ("  class {0} found, methods:" -f $cls)
        foreach ($m in $c.CimClassMethods) { Write-Host ("    - {0}({1})" -f $m.Name, (($m.Parameters | ForEach-Object { $_.Name }) -join ',')) }
    } else {
        Write-Host ("  class {0} NOT found" -f $cls)
    }
}

Section "4) try RequestResponse on IPMIPrv"
# Generic IPMI request: NetFn=0x06 (App), Cmd=0x01 (Get Device ID)
try {
    $res = Invoke-CimMethod -Namespace root/wmi -ClassName IPMIPrv -MethodName RequestResponse -Arguments @{
        RequestData  = [byte[]](0x01)
        RequestDataSize = [uint32]1
        NetworkFunction = [byte]0x06
        Lun = [byte]0x00
        ResponderAddress = [byte]0x20
    } -ErrorAction Stop
    Write-Host ("  RequestResponse returned: {0}" -f ($res | Out-String).Trim())
} catch {
    Write-Host ("  RequestResponse failed: {0}" -f $_.Exception.Message)
}

Section "5) driver file presence"
$drv = "$env:SystemRoot\System32\drivers\ipmidrv.sys"
Write-Host ("  {0}: {1}" -f $drv, (Test-Path $drv))

Section "6) ACPI table check for IPMI"
# If the firmware exposes IPMI via ACPI, there is an SPCR or IPMI table entry
$tables = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature
Write-Host ("  thermal zones: {0}" -f @($tables).Count)

Section "7) verdict"
if ($svc.Status -eq 'Running') {
    Write-Host "  IPMI driver is RUNNING - sensor reads may be possible."
} else {
    Write-Host "  IPMI driver did NOT start. No in-band BMC access from this OS."
    Write-Host "  Root cause is likely no BMC hardware / no IPMI channel on this board,"
    Write-Host "  or it is disabled in BIOS."
}
