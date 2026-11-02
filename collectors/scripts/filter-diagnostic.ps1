# Diagnosis: does the value filter actually reject bogus readings?
# Note: in the real thermal.ps1 the filter is WRONG in a subtle way - it returns
# nothing (which becomes $null) and the CALLER checks nothing, so nothing is filtered.

function Add-Sensor-Diagnostic {
    param([double]$Value, [string]$Type)

    $rejected = $false
    # Keep in sync with thermal.ps1
    if ($Type -eq 'Temperature') { if ($Value -le 0 -or $Value -ge 150) { $rejected = $true } }
    elseif ($Type -eq 'Fan') { if ($Value -le 0 -or $Value -gt 30000) { $rejected = $true } }

    return [pscustomobject]@{
        value    = $Value
        type     = $Type
        rejected = $rejected
        survived = (-not $rejected)
    }
}

$cases = @(
    @{ v = 0;      t = 'Temperature'; expect = 'reject' },  # 0 C is impossible
    @{ v = 999;    t = 'Temperature'; expect = 'reject' },  # absurd
    @{ v = 999999; t = 'Fan';         expect = 'reject' },  # absurd RPM
    @{ v = 72.5;   t = 'Temperature'; expect = 'keep'   },
    @{ v = 1480;   t = 'Fan';         expect = 'keep'   }
)

$results = @()
foreach ($c in $cases) {
    $r = Add-Sensor-Diagnostic -Value $c.v -Type $c.t
    $results += [pscustomobject]@{
        value    = $c.v
        type     = $c.t
        expected = $c.expect
        survived = $r.survived
        correct  = (($c.expect -eq 'reject' -and -not $r.survived) -or ($c.expect -eq 'keep' -and $r.survived))
    }
}

$allCorrect = -not ($results | Where-Object { -not $_.correct })

[pscustomobject]@{
    allCorrect = $allCorrect
    results    = $results
} | ConvertTo-Json -Depth 5 -Compress
