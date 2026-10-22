@echo off
REM ===========================================================================
REM  SmartFit - health data AUTO SYNC launcher
REM  ASCII only on purpose: .bat files are parsed with the console code page,
REM  so Chinese text here would turn into mojibake on some systems.
REM
REM  What it does:
REM    Watches a folder and pushes new health files (Apple Health export zip /
REM    export.xml / band CSV / JSON) to the platform automatically.
REM    No more "export -> convert to CSV -> upload in browser".
REM ===========================================================================
cd /d "%~dp0"
title SmartFit - auto sync health data

echo ============================================================
echo   SmartFit - health data auto sync
echo ============================================================
echo.
echo   Step 1: open the site - Devices page - section 4
echo           click "create token", copy the sft_... string
echo   Step 2: paste it below
echo   Step 3: keep this window open - closing it stops the sync
echo.
echo   Tip: use the PERMANENT online address so it also works
echo        when the local PC backend is not running:
echo        https://smartfit-qsyh.onrender.com
echo.

set "DEFAULT_URL=https://smartfit-qsyh.onrender.com"
set /p PLATFORM_URL=Platform url [%DEFAULT_URL%]:
if "%PLATFORM_URL%"=="" set "PLATFORM_URL=%DEFAULT_URL%"

set /p SYNC_TOKEN=Sync token (sft_...):
if "%SYNC_TOKEN%"=="" (
  echo.
  echo   No token entered - nothing to do. Run again and paste the token.
  pause
  exit /b 1
)

set "DEFAULT_DIR=%USERPROFILE%\iCloudDrive\SmartFit"
set /p WATCH_DIR=Watched folder [%DEFAULT_DIR%]:
if "%WATCH_DIR%"=="" set "WATCH_DIR=%DEFAULT_DIR%"
if not exist "%WATCH_DIR%" mkdir "%WATCH_DIR%"

echo.
echo   Watching : %WATCH_DIR%
echo   Platform : %PLATFORM_URL%
echo   Drop Apple Health export zip / band CSV into that folder.
echo.
node "tools\health-sync.mjs" --watch "%WATCH_DIR%" --url "%PLATFORM_URL%" --token "%SYNC_TOKEN%" --device "PC auto sync"
echo.
echo   Sync stopped.
pause
