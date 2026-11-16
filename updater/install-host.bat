@echo off
REM install-host.bat - runs the PowerShell installer once (double-click).
REM No admin rights needed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-host.ps1"
pause
