param(
    [switch]$Portable,
    [switch]$Installer
)

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

# Electron can be forced into plain Node mode by this environment variable.
# Clear it so both npm scripts and the packaged app build run in desktop mode.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

Write-Host "Installing dependencies..." -ForegroundColor Cyan
& npm.cmd install

if ($Portable -and $Installer) {
    throw "Use either -Portable or -Installer, not both."
}

if ($Portable) {
    Write-Host "Building portable Windows executable..." -ForegroundColor Cyan
    & npm.cmd run dist
    $outputPath = "dist\\InvisibleOverlay-1.0.0-x64-portable.exe"
}
elseif ($Installer) {
    Write-Host "Building Windows installer..." -ForegroundColor Cyan
    & npm.cmd run dist:installer
    $outputPath = "dist\\InvisibleOverlay Setup 1.0.0.exe"
}
else {
    Write-Host "Building unpacked Windows app folder..." -ForegroundColor Cyan
    & npm.cmd run pack
    $outputPath = "dist\\win-unpacked\\InvisibleOverlay.exe"
}

Write-Host ""
Write-Host "Build complete." -ForegroundColor Green
Write-Host "Run this file: $outputPath"
