@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
if errorlevel 1 pause
