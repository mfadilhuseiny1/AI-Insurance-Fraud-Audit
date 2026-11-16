@echo off
rem AI JKN Synthetic: starts its PostgreSQL (5435), the API (localhost:8300) and the UI (localhost:9300) and opens /aip-jkn.
rem Local only. A double-click works whatever the PowerShell execution policy is.
title AI JKN Synthetic
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 (pause) else (timeout /t 4 >nul)
