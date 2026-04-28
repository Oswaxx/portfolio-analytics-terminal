#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Instala PortfolioWeb como servicio de Windows usando NSSM.
    Ejecutar como Administrador: Right-click → "Run with PowerShell"
#>

$ServiceName  = "PortfolioWeb"
$DisplayName  = "Portfolio PRO Terminal (Flask)"
$Description  = "Servidor Flask del portfolio tracker. Puerto 5000."
$AppDir       = "C:\Users\oswal\.gemini\antigravity\scratch\portfolio_web"
$PythonExe    = "C:\Python314\python.exe"
$AppScript    = "$AppDir\app.py"
$LogDir       = "$AppDir\logs"
$NssmDir      = "C:\nssm"
$NssmExe      = "$NssmDir\nssm.exe"

# ── 1. Crear carpeta de logs ──────────────────────────────────────────────────
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
    Write-Host "[OK] Carpeta de logs creada: $LogDir"
}

# ── 2. Descargar NSSM si no existe ───────────────────────────────────────────
if (-not (Test-Path $NssmExe)) {
    Write-Host "Descargando NSSM..."
    $NssmZip = "$env:TEMP\nssm.zip"
    $NssmUrl = "https://nssm.cc/release/nssm-2.24.zip"

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $NssmUrl -OutFile $NssmZip -UseBasicParsing
        Expand-Archive -Path $NssmZip -DestinationPath "$env:TEMP\nssm_extracted" -Force

        # El zip contiene nssm-2.24\win64\nssm.exe
        $Extracted = Get-ChildItem "$env:TEMP\nssm_extracted" -Recurse -Filter "nssm.exe" |
                     Where-Object { $_.FullName -match "win64" } |
                     Select-Object -First 1

        if (-not $Extracted) {
            # Fallback: tomar cualquier nssm.exe
            $Extracted = Get-ChildItem "$env:TEMP\nssm_extracted" -Recurse -Filter "nssm.exe" |
                         Select-Object -First 1
        }

        New-Item -ItemType Directory -Path $NssmDir -Force | Out-Null
        Copy-Item $Extracted.FullName -Destination $NssmExe -Force
        Write-Host "[OK] NSSM instalado en $NssmExe"
    } catch {
        Write-Error "No se pudo descargar NSSM: $_"
        Write-Host ""
        Write-Host "Descarga manual: https://nssm.cc/release/nssm-2.24.zip"
        Write-Host "Copia nssm.exe a $NssmDir y vuelve a ejecutar este script."
        exit 1
    }
} else {
    Write-Host "[OK] NSSM ya existe en $NssmExe"
}

# ── 3. Eliminar servicio previo si existe ────────────────────────────────────
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Eliminando servicio anterior..."
    & $NssmExe stop $ServiceName 2>$null
    & $NssmExe remove $ServiceName confirm
    Start-Sleep -Seconds 2
}

# ── 4. Instalar el servicio ───────────────────────────────────────────────────
Write-Host "Instalando servicio $ServiceName..."
& $NssmExe install $ServiceName $PythonExe $AppScript

# ── 5. Configurar parámetros del servicio ────────────────────────────────────
& $NssmExe set $ServiceName AppDirectory       $AppDir
& $NssmExe set $ServiceName DisplayName        $DisplayName
& $NssmExe set $ServiceName Description        $Description
& $NssmExe set $ServiceName Start              SERVICE_AUTO_START
& $NssmExe set $ServiceName AppStdout          "$LogDir\flask_stdout.log"
& $NssmExe set $ServiceName AppStderr          "$LogDir\flask_stderr.log"
& $NssmExe set $ServiceName AppRotateFiles     1
& $NssmExe set $ServiceName AppRotateSeconds   86400
& $NssmExe set $ServiceName AppRotateBytes     5242880
& $NssmExe set $ServiceName AppRestartDelay    3000
& $NssmExe set $ServiceName AppEnvironmentExtra "PYTHONPATH=C:\Users\oswal\AppData\Roaming\Python\Python314\site-packages" "FLASK_ENV=production"

# ── 6. Iniciar el servicio ────────────────────────────────────────────────────
Write-Host "Iniciando servicio..."
& $NssmExe start $ServiceName
Start-Sleep -Seconds 3

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host ""
    Write-Host "============================================="
    Write-Host " [OK] Servicio '$ServiceName' ACTIVO"
    Write-Host " URL: http://localhost:5000"
    Write-Host " Logs: $LogDir"
    Write-Host "============================================="
} else {
    Write-Warning "El servicio no arrancó. Revisa los logs en $LogDir"
    Write-Host "Para diagnosticar: Get-Content '$LogDir\flask_stderr.log'"
}
