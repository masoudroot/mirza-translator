@echo off
REM host-launcher.bat - Chrome starts the update host through this file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0host.ps1"
