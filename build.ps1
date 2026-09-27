param(
    [switch]$Portable,
    [switch]$Installer
)

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

if ($Portable -and $Installer) {
    throw "Use either -Portable or -Installer, not both."
}

# Electron can be forced into plain Node mode by this environment variable
# (VS Code terminals set it). Clear it so the build and the app run as desktop Electron.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

Write-Host "Installing dependencies..." -ForegroundColor Cyan
& npm.cmd install
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

Write-Host "Building the UI (dist-vue)..." -ForegroundColor Cyan
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "vite build failed." }

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version

if ($Portable) {
    Write-Host "Building portable Windows executable..." -ForegroundColor Cyan
    & npm.cmd run dist
    $outputPath = "dist\Screnshield-$version-x64-portable.exe"
}
elseif ($Installer) {
    Write-Host "Building Windows installer..." -ForegroundColor Cyan
    & npm.cmd run dist:installer
    $outputPath = "dist\Screnshield Setup $version.exe"
}
else {
    Write-Host "Building unpacked Windows app folder..." -ForegroundColor Cyan
    & npm.cmd run pack
    $outputPath = "dist\win-unpacked\Screnshield.exe"
}
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed." }

Write-Host ""
Write-Host "Build complete." -ForegroundColor Green
Write-Host "Run this file: $outputPath"
Write-Host "Put jd.txt and resume.txt in the same folder as the exe."
