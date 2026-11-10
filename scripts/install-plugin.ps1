# Copies the built plugin into Studio's Plugins folder.
param(
    [string]$PluginsDir = "$env:LOCALAPPDATA\Roblox\Plugins"
)

$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "..\plugin\RobloxMCP.rbxmx"
$source = [System.IO.Path]::GetFullPath($source)

if (-not (Test-Path $source)) {
    throw "Plugin model not found at $source. Run 'npm run build:plugin' first."
}

New-Item -ItemType Directory -Force -Path $PluginsDir | Out-Null
Copy-Item -Path $source -Destination (Join-Path $PluginsDir "RobloxMCP.rbxmx") -Force

Write-Host "Installed RobloxMCP.rbxmx to $PluginsDir"
Write-Host "Restart Roblox Studio, then open Plugins -> RobloxMCP."
