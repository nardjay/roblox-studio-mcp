# Saves every change in this repo to GitHub.
# Called by save.cmd, or run directly:  powershell -ExecutionPolicy Bypass -File scripts/save.ps1 "what changed"
param([string]$Message = "Update")

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "git is not installed." -ForegroundColor Red
    exit 1
}

# Pick up anything you changed directly on github.com, so the push is never
# rejected as "remote contains work that you do not have locally".
git pull --rebase --autostash origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "Could not sync with GitHub (conflict?). Fix the conflict, then run: git rebase --continue" -ForegroundColor Red
    exit $LASTEXITCODE
}

git add -A

$pending = git status --porcelain
if (-not $pending) {
    Write-Host "Nothing to save - GitHub already has the latest version." -ForegroundColor Yellow
    exit 0
}

Write-Host "Saving:" -ForegroundColor Cyan
$pending | ForEach-Object { Write-Host "  $_" }

git commit -m $Message
if ($LASTEXITCODE -ne 0) {
    Write-Host "Commit failed." -ForegroundColor Red
    exit $LASTEXITCODE
}

git push
if ($LASTEXITCODE -ne 0) {
    Write-Host "Commit is saved locally, but the push failed. Check your GitHub sign-in and run: git push" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "Done - pushed to https://github.com/nardjay/roblox-studio-mcp" -ForegroundColor Green
