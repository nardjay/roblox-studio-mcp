@echo off
rem Double-click this file to save and upload every change to GitHub.
rem Optional: pass a message, e.g.  save.cmd "fixed the clicker costs"
setlocal
cd /d "%~dp0"
set "MSG=%~1"
if "%MSG%"=="" set /p "MSG=Describe the change: "
if "%MSG%"=="" set "MSG=Update"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\save.ps1" "%MSG%"
if "%~1"=="" pause
