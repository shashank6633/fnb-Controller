<#
  AKAN F&B Controller - Print Bridge installer (Windows)
  ======================================================
  Installs the print bridge as an ALWAYS-ON Windows Service so it:
    - starts automatically at boot (before anyone logs in),
    - restarts itself if it crashes,
    - survives reboots,
    - never needs a cashier to launch anything.

  Run ONCE per counter PC, as Administrator:
      powershell -ExecutionPolicy Bypass -File install-bridge-service.ps1

  It uses Node if installed; otherwise it downloads a portable Node. It also
  downloads NSSM (the service wrapper) and the latest print-bridge.mjs from your
  site, registers the service, and registers a daily auto-updater.

  Re-running it = upgrade-in-place (safe).
#>
param(
  [string]$AppUrl      = "https://fnb.akanhyd.com",   # your POS site (origin for CORS + bridge download)
  [string]$InstallDir  = "C:\AKAN\bridge",
  [string]$ServiceName = "AKANPrintBridge",
  [int]   $Port        = 9920,
  [string]$NodeVersion = "v22.11.0"                   # portable Node fallback if none installed
)

$ErrorActionPreference = "Stop"

# -- Self-elevate to Administrator --------------------------------------------
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Requesting Administrator rights..." -ForegroundColor Yellow
  $argList = "-ExecutionPolicy Bypass -File `"$PSCommandPath`" -AppUrl `"$AppUrl`" -InstallDir `"$InstallDir`" -ServiceName `"$ServiceName`" -Port $Port -NodeVersion `"$NodeVersion`""
  Start-Process powershell -Verb RunAs -ArgumentList $argList
  exit
}

Write-Host "`n=== AKAN Print Bridge - service install ===`n" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# -- 1. Node runtime ----------------------------------------------------------
$nodeExe = $null
$sysNode = (Get-Command node -ErrorAction SilentlyContinue)
if ($sysNode) {
  $nodeExe = $sysNode.Source
  Write-Host "[1/5] Using installed Node: $nodeExe" -ForegroundColor Green
} else {
  $nodeExe = "$InstallDir\node.exe"
  if (-not (Test-Path $nodeExe)) {
    Write-Host "[1/5] No Node found - downloading portable Node $NodeVersion ..." -ForegroundColor Yellow
    $zip = "$env:TEMP\node-$NodeVersion-win-x64.zip"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath "$env:TEMP\node-extract" -Force
    Copy-Item "$env:TEMP\node-extract\node-$NodeVersion-win-x64\node.exe" $nodeExe -Force
    Remove-Item $zip, "$env:TEMP\node-extract" -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host "[1/5] Portable Node ready: $nodeExe" -ForegroundColor Green
}

# -- 2. NSSM (service wrapper) -------------------------------------------------
$nssm = "$InstallDir\nssm.exe"
if (-not (Test-Path $nssm)) {
  Write-Host "[2/5] Downloading NSSM ..." -ForegroundColor Yellow
  $nz = "$env:TEMP\nssm.zip"
  Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $nz
  Expand-Archive -Path $nz -DestinationPath "$env:TEMP\nssm-extract" -Force
  Copy-Item "$env:TEMP\nssm-extract\nssm-2.24\win64\nssm.exe" $nssm -Force
  Remove-Item $nz, "$env:TEMP\nssm-extract" -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "[2/5] NSSM ready." -ForegroundColor Green

# -- 3. Bridge program (latest from the site) ---------------------------------
Write-Host "[3/5] Downloading latest print-bridge.mjs from $AppUrl ..." -ForegroundColor Yellow
Invoke-WebRequest -Uri "$AppUrl/print-bridge.mjs" -OutFile "$InstallDir\print-bridge.mjs"
# Save the updater script next to it
@"
`$ErrorActionPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
`$cur="$InstallDir\print-bridge.mjs"; `$new="$InstallDir\print-bridge.new"
Invoke-WebRequest -Uri "$AppUrl/print-bridge.mjs" -OutFile `$new
if((Test-Path `$new) -and ((Get-FileHash `$new).Hash -ne (Get-FileHash `$cur).Hash)){
  Copy-Item `$new `$cur -Force; & "$nssm" restart $ServiceName
}
Remove-Item `$new -ErrorAction SilentlyContinue
"@ | Set-Content -Path "$InstallDir\update-bridge.ps1" -Encoding UTF8
Write-Host "[3/5] Bridge + updater installed." -ForegroundColor Green

# -- 4. Register / reconfigure the Windows Service ----------------------------
Write-Host "[4/5] Registering Windows Service '$ServiceName' ..." -ForegroundColor Yellow
& $nssm stop $ServiceName 2>$null | Out-Null
& $nssm remove $ServiceName confirm 2>$null | Out-Null
$bridgeArgs = "`"$InstallDir\print-bridge.mjs`" --port=$Port --origin=$AppUrl"
& $nssm install $ServiceName $nodeExe $bridgeArgs
& $nssm set $ServiceName AppDirectory $InstallDir
& $nssm set $ServiceName Start SERVICE_AUTO_START        # start at boot, before login
& $nssm set $ServiceName AppExit Default Restart         # crash -> restart
& $nssm set $ServiceName AppThrottle 1500                # but throttle fast crash loops
& $nssm set $ServiceName AppRestartDelay 2000            # 2s backoff between restarts
& $nssm set $ServiceName AppStdout "$InstallDir\logs\out.log"
& $nssm set $ServiceName AppStderr "$InstallDir\logs\err.log"
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateBytes 1048576
& $nssm set $ServiceName DisplayName "AKAN Print Bridge"
& $nssm set $ServiceName Description "Prints KOTs and bills to local/LAN thermal printers for the AKAN POS."
& $nssm start $ServiceName
Write-Host "[4/5] Service registered + started." -ForegroundColor Green

# -- 5. Daily auto-updater (scheduled task) + health check --------------------
Write-Host "[5/5] Registering daily auto-updater + checking health ..." -ForegroundColor Yellow
$taskCmd = "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstallDir\update-bridge.ps1`""
schtasks /Create /TN "AKANBridgeUpdater" /TR $taskCmd /SC DAILY /ST 04:30 /RL HIGHEST /F | Out-Null

Start-Sleep -Seconds 3
try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
  Write-Host "`n  HEALTHY - bridge v$($h.version) listening on http://127.0.0.1:$Port" -ForegroundColor Green
  Write-Host "  It will now start automatically every time this PC boots." -ForegroundColor Green
} catch {
  Write-Host "`n  WARNING - service installed but /health did not respond yet." -ForegroundColor Red
  Write-Host "  Check $InstallDir\logs\err.log . Common cause: port $Port already in use." -ForegroundColor Red
}

Write-Host "`nDone. Open $AppUrl over HTTPS -> Dine-In -> KOT & Bill Printers -> Refresh (should be green)." -ForegroundColor Cyan
Write-Host "Manage the service:  $nssm [start|stop|restart|status] $ServiceName`n"
