# =============================================================
# run-deploy-server.ps1
# Start / Stop / Restart / Status for the LZGO TLS gateway
# Usage:
#   .\run-deploy-server.ps1 -Start
#   .\run-deploy-server.ps1 -Stop
#   .\run-deploy-server.ps1 -Restart
#   .\run-deploy-server.ps1 -Status
# =============================================================
param(
    [switch]$Start,
    [switch]$Stop,
    [switch]$Restart,
    [switch]$Status,
    [switch]$Foreground
)

$DeployDir = "C:\deploy-gateway"
$HttpPort = 80
$HttpsPort = 443
$AppName = "lzgo-gateway"
$LogDir = Join-Path $DeployDir "logs"
$LogFile = Join-Path $LogDir "gateway.log"
$ErrFile = Join-Path $LogDir "gateway-error.log"
$PidFile = Join-Path $LogDir "gateway.pid"
$ServerFile = Join-Path $DeployDir "gateway.cjs"
$EnvFile = Join-Path $DeployDir ".env"

$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) {
    # Try common install paths for SYSTEM account
    $candidates = @(
        "C:\Program Files\nodejs\node.exe",
        "C:\Program Files (x86)\nodejs\node.exe"
    )
    $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($found) { $NodeExe = $found }
}
if (-not $NodeExe) {
    Write-Host "ERROR: node.exe not found. Install Node.js or add to system PATH." -ForegroundColor Red
    exit 1
}

# Ensure log directory exists
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# ---- Helper: Find process by PID file ----
function Get-AppProcess {
    if (Test-Path $PidFile) {
        $savedPid = (Get-Content $PidFile -Raw).Trim()
        if ($savedPid -match '^\d+$') {
            try {
                $proc = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
                if ($proc) { return $proc }
            } catch { }
        }
    }
    # Fallback: find by HTTPS port
    $conn = Get-NetTCPConnection -LocalPort $HttpsPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        try {
            return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        } catch { }
    }
    return $null
}

# ---- Helper: Start the gateway ----
function Start-App {
    $existing = Get-AppProcess
    if ($existing) {
        Write-Host "Gateway is already running (PID: $($existing.Id), Port: $HttpsPort)" -ForegroundColor Yellow
        return
    }

    Write-Host "Starting $AppName on ports $HttpPort/$HttpsPort..." -ForegroundColor Cyan

    # Ensure we are in the deploy directory
    Set-Location $DeployDir

    # Verify server bundle exists
    if (-not (Test-Path $ServerFile)) {
        Write-Host "ERROR: $ServerFile not found. Run 'npm run build' first." -ForegroundColor Red
        exit 1
    }

    # Certificates live inside the gateway project (certs\*.pem)
    $CertDir = Join-Path $DeployDir "certs"
    if (-not (Test-Path $CertDir)) {
        Write-Host "ERROR: certificate directory $CertDir not found." -ForegroundColor Red
        exit 1
    }

    # The gateway reads HTTP_PORT / HTTPS_PORT / CERT_DIR / ROUTES from .env
    # (loaded by dotenv inside gateway.ts). cmd /c is used so nothing leaks
    # into the current PowerShell session environment.
    if ($Foreground) {
        Write-Host "Running in foreground (Ctrl+C to stop)..." -ForegroundColor Yellow
        & $NodeExe $ServerFile
        return
    }

    $cmdArgs = "/c `"set NODE_ENV=production&&`"$NodeExe`" `"$ServerFile`"`""
    $proc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList $cmdArgs `
        -WorkingDirectory $DeployDir `
        -NoNewWindow `
        -PassThru `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError $ErrFile

    # Save PID
    $proc.Id | Out-File -FilePath $PidFile -NoNewline

    # Wait for the HTTPS port to come up (startup is not instant)
    $listening = $false
    for ($i = 1; $i -le 10; $i++) {
        Start-Sleep -Seconds 1
        $conn = Get-NetTCPConnection -LocalPort $HttpsPort -State Listen -ErrorAction SilentlyContinue
        if ($conn) { $listening = $true; break }
    }

    if ($listening) {
        Write-Host "Gateway started successfully (PID: $($proc.Id))" -ForegroundColor Green
        Write-Host "  HTTP:  $HttpPort" -ForegroundColor White
        Write-Host "  HTTPS: $HttpsPort" -ForegroundColor White
        Write-Host "  Log:   $LogFile" -ForegroundColor White
        Write-Host "  Health: http://localhost:$HttpPort/__gateway/health" -ForegroundColor White
    } else {
        Write-Host "WARNING: Process started but port $HttpsPort is not listening. Check $ErrFile" -ForegroundColor Yellow
        if (Test-Path $ErrFile) {
            Write-Host "Last 5 error lines:" -ForegroundColor Gray
            Get-Content $ErrFile -Tail 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
        }
        if (Test-Path $LogFile) {
            Write-Host "Last 10 log lines:" -ForegroundColor Gray
            Get-Content $LogFile -Tail 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
        }
    }
}

# ---- Helper: Stop the gateway ----
function Stop-App {
    $proc = Get-AppProcess
    if (-not $proc) {
        Write-Host "Gateway is not running (no process found on port $HttpsPort)" -ForegroundColor Yellow
        if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
        return
    }

    Write-Host "Stopping $AppName (PID: $($proc.Id))..." -ForegroundColor Cyan

    # The gateway handles SIGINT/SIGTERM for a graceful shutdown.
    $proc.CloseMainWindow() | Out-Null
    Start-Sleep -Seconds 3

    if (-not $proc.HasExited) {
        Write-Host "  Force killing process..." -ForegroundColor Yellow
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }

    # Verify both ports are freed
    Start-Sleep -Seconds 1
    $busy = $false
    foreach ($port in @($HttpPort, $HttpsPort)) {
        $check = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($check) { $busy = $true }
    }
    if (-not $busy) {
        Write-Host "Gateway stopped successfully" -ForegroundColor Green
    } else {
        Write-Host "WARNING: Ports $HttpPort/$HttpsPort still in use. Manual cleanup may be needed." -ForegroundColor Red
    }

    if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
}

# ---- Helper: Show status ----
function Show-Status {
    $proc = Get-AppProcess
    if ($proc) {
        $cpu = [math]::Round($proc.CPU, 1)
        $mem = [math]::Round($proc.WorkingSet64 / 1MB, 1)
        Write-Host "============================================" -ForegroundColor Cyan
        Write-Host " $AppName - RUNNING" -ForegroundColor Green
        Write-Host "============================================" -ForegroundColor Cyan
        Write-Host "  PID:       $($proc.Id)" -ForegroundColor White
        Write-Host "  HTTP:      $HttpPort" -ForegroundColor White
        Write-Host "  HTTPS:     $HttpsPort" -ForegroundColor White
        Write-Host "  CPU:       ${cpu}s" -ForegroundColor White
        Write-Host "  Memory:    ${mem} MB" -ForegroundColor White
        Write-Host "  Started:   $($proc.StartTime)" -ForegroundColor White
        Write-Host "  Directory: $DeployDir" -ForegroundColor White
        Write-Host "  Log:       $LogFile" -ForegroundColor White

        # Show the configured routes
        if (Test-Path $EnvFile) {
            $routeLine = Get-Content $EnvFile | Where-Object { $_ -match '^\s*ROUTES\s*=' } | Select-Object -First 1
            if ($routeLine) { Write-Host "  Routes:    $($routeLine -replace '^\s*ROUTES\s*=\s*','')" -ForegroundColor White }
        }

        # Quick health check (HTTP side, no certificate validation)
        try {
            $health = Invoke-RestMethod -Uri "http://localhost:$HttpPort/__gateway/health" -TimeoutSec 3 -ErrorAction Stop
            Write-Host "  Health:    OK (uptime $($health.uptime)s)" -ForegroundColor Green
        } catch {
            Write-Host "  Health:    NOT RESPONDING" -ForegroundColor Red
        }

        Write-Host "============================================" -ForegroundColor Cyan
    } else {
        Write-Host "============================================" -ForegroundColor Cyan
        Write-Host " $AppName - STOPPED" -ForegroundColor Red
        Write-Host "============================================" -ForegroundColor Cyan
        Write-Host "  Ports $HttpPort/$HttpsPort are not in use" -ForegroundColor White
        Write-Host "  Directory: $DeployDir" -ForegroundColor White
        if (Test-Path $LogFile) {
            Write-Host "  Last 3 log lines:" -ForegroundColor Gray
            Get-Content $LogFile -Tail 3 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
        }
        Write-Host "============================================" -ForegroundColor Cyan
    }
}

# ---- Dispatch ----
switch ($true) {
    $Start      { Start-App }
    $Stop       { Stop-App }
    $Restart    { Stop-App; Start-Sleep -Seconds 2; Start-App }
    $Status     { Show-Status }
    $Foreground { Start-App }
    default {
        Write-Host "Usage: .\run-deploy-server.ps1 -Start | -Stop | -Restart | -Status | -Foreground" -ForegroundColor White
        Write-Host "`nExamples:" -ForegroundColor Gray
        Write-Host "  .\run-deploy-server.ps1 -Start        # Start the gateway in background" -ForegroundColor Gray
        Write-Host "  .\run-deploy-server.ps1 -Stop         # Stop the running gateway" -ForegroundColor Gray
        Write-Host "  .\run-deploy-server.ps1 -Restart      # Restart the gateway" -ForegroundColor Gray
        Write-Host "  .\run-deploy-server.ps1 -Status       # Check if the gateway is running" -ForegroundColor Gray
        Write-Host "`nCurrent status:" -ForegroundColor White
        Show-Status
    }
}
