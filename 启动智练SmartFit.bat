@echo off
REM ===========================================================================
REM  SmartFit launcher. This file is intentionally ASCII-only: .bat files are
REM  parsed using the active console code page, so Chinese text here would break
REM  under UTF-8 terminals. Chinese messages live in scripts\start-smartfit.ps1
REM ===========================================================================
cd /d "%~dp0"
title SmartFit Launcher
echo Starting SmartFit, please wait...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\start-smartfit.ps1"
set EXITCODE=%errorlevel%
echo.
if not "%EXITCODE%"=="0" echo Launcher exited with code %EXITCODE%, see logs\launcher.log
pause