@echo off
REM ===========================================================================
REM  SmartFit public tunnel launcher (ASCII only on purpose: .bat is parsed
REM  with the console code page)
REM  Starts an SSH reverse tunnel so the app can be opened from any network.
REM  Requires: npm run build + backend running on port 3000.
REM ===========================================================================
cd /d "%~dp0"
title SmartFit Public Tunnel
echo ============================================================
echo   SmartFit - public tunnel
echo ============================================================
echo.
echo   Make sure the backend is running on port 3000 first
echo   (double-click the local launcher, or run: npm run dev)
echo.
echo   The public https address will be printed below.
echo   Keep this window open - closing it kills the tunnel.
echo.
pause
node "tools\tunnel.mjs"
pause