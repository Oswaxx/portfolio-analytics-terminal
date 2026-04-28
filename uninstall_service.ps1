#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Detiene y elimina el servicio PortfolioWeb.
    Ejecutar como Administrador.
#>

$ServiceName = "PortfolioWeb"
$NssmExe     = "C:\nssm\nssm.exe"

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host "El servicio '$ServiceName' no existe."
    exit 0
}

Write-Host "Deteniendo servicio..."
& $NssmExe stop $ServiceName
Start-Sleep -Seconds 2

Write-Host "Eliminando servicio..."
& $NssmExe remove $ServiceName confirm

Write-Host "[OK] Servicio '$ServiceName' eliminado."
