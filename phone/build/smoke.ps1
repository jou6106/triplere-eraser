# Installs the built Setup silently on a clean Windows runner, starts the program, checks it,
# takes a screenshot, then uninstalls. Usage: smoke.ps1 -Setup <setup.exe> -Out <folder>
param([Parameter(Mandatory)] [string]$Setup, [Parameter(Mandatory)] [string]$Out)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
function Check($cond, $msg) { if (-not $cond) { throw "SMOKE FAILED: $msg" } else { Write-Host "ok  $msg" } }

Write-Host "== install"
$p = Start-Process -FilePath $Setup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=desktopicon', "/LOG=$Out\install.log" -Wait -PassThru
Check ($p.ExitCode -eq 0) "installer exit code 0 (got $($p.ExitCode))"
$app = Join-Path $env:ProgramFiles 'Triple Re\Mobile Eraser'
$exe = Join-Path $app 'Triple Re Mobile Eraser.exe'
$data = Join-Path $env:ProgramData 'Triple Re\Mobile Eraser'
Check (Test-Path $exe) 'program installed'
Check (Test-Path (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Triple Re Mobile Eraser.lnk')) 'desktop icon'
Check (Test-Path $data) 'data folder created'
$vi = (Get-Item $exe).VersionInfo
Check ($vi.ProductName -eq 'Triple Re Mobile Eraser') "exe product name ($($vi.ProductName))"
Check ($vi.CompanyName -eq 'Triple Re') "exe company ($($vi.CompanyName))"
Check (-not ("$($vi.FileDescription) $($vi.ProductName) $($vi.CompanyName) $($vi.LegalCopyright)" -match 'node|OpenJS')) 'exe details do not name the runtime'
$bytes = [IO.File]::ReadAllBytes($exe); $pe = [BitConverter]::ToInt32($bytes, 0x3c)
Check ([BitConverter]::ToUInt16($bytes, $pe + 4 + 20 + 68) -eq 2) 'exe is a windowed program (no console)'

Write-Host "== bundled tools start (all DLLs present)"
$help = & "$app\tools\ios\idevicerestore.exe" --help 2>&1 | Out-String
Check ($help -match 'Usage') 'restore tool runs'
$info = & "$app\tools\ios\ideviceinfo.exe" --help 2>&1 | Out-String
Check ($info -match 'Usage') 'device info tool runs'
foreach ($t in 'idevice_id', 'idevicepair', 'ideviceenterrecovery') {
  $o = & "$app\tools\ios\$t.exe" --help 2>&1 | Out-String
  Check ($o -match 'Usage') "$t runs"
}
$rl = & "$app\tools\ios\triplere-recovery-list.exe" --help 2>&1 | Out-String
Check ($rl -match 'Usage') 'recovery lister runs'
& "$app\tools\ios\triplere-recovery-list.exe" 2>&1 | Out-String | Write-Host
Write-Host "recovery lister exit: $LASTEXITCODE"
$adb = & "$app\tools\android\adb.exe" version 2>&1 | Out-String
Check ($adb -match 'Android Debug Bridge') 'android tool runs'
& "$app\tools\android\adb.exe" kill-server 2>&1 | Out-Null

Write-Host "== program"
$env:TRIPLERE_NO_WINDOW = '1'
$proc = Start-Process -FilePath $exe -PassThru
$state = $null
for ($i = 0; $i -lt 60 -and -not $state; $i++) {
  Start-Sleep -Milliseconds 500
  try { $state = Invoke-RestMethod -Uri 'http://127.0.0.1:4320/api/state' -TimeoutSec 3 } catch { }
}
Check ($null -ne $state) 'program answers on 127.0.0.1:4320'
$state | ConvertTo-Json -Depth 6 | Set-Content "$Out\state.json"
Check ($state.licence.state -eq 'missing') 'no licence yet -> licence screen'
Check ($state.status.iosTools -eq $true) 'iPhone tools found'
Check ($state.status.androidTools -eq $true) 'Android tools found'
Check ($state.status.windows -eq $true) 'windows mode'
Write-Host "Apple driver on this runner: $($state.status.apple)"
$r = try { Invoke-WebRequest -Uri 'http://127.0.0.1:4320/api/erase' -Method Post -Body '{"ids":["x"]}' -ContentType 'application/json' -Headers @{ 'X-TripleRe' = '1' } -SkipHttpErrorCheck } catch { $_.Exception.Response }
Check ($r.StatusCode -eq 403) "erase refused without licence ($($r.StatusCode))"
$html = (Invoke-WebRequest -Uri 'http://127.0.0.1:4320/').Content
Check ($html -match 'Triple Re Mobile Eraser') 'screens served'

$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) {
  & $edge --headless=new --disable-gpu --hide-scrollbars --window-size=1280,860 --virtual-time-budget=4000 "--screenshot=$Out\windows-licence-screen.png" 'http://127.0.0.1:4320/' 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  Check (Test-Path "$Out\windows-licence-screen.png") 'screenshot taken with Edge'
}

# A second start only opens a window on the running program and exits.
$second = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 4
Check ($second.HasExited) 'second start hands over to the running program'

Stop-Process -Id $proc.Id -Force
Start-Sleep -Seconds 1
Copy-Item "$data\app.log" "$Out\app.log" -ErrorAction SilentlyContinue
$log = Get-Content "$data\app.log" -Raw
Check ($log -match 'listening on') 'app.log written'
Check (-not ($log -match 'uncaught|unhandled')) 'no crashes in app.log'

Write-Host "== uninstall"
$u = Start-Process -FilePath (Join-Path $app 'unins000.exe') -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
Start-Sleep -Seconds 3
Check (-not (Test-Path $exe)) 'program removed'
Write-Host "SMOKE TEST PASSED"
