@echo off
REM ===========================================================================
REM  SmartFit - open the phone QR page (ASCII only on purpose: .bat is parsed
REM  with the console code page).
REM  The page shows a QR code of the current public address; the phone just
REM  scans the screen. It also shows a same-Wi-Fi address that never changes.
REM ===========================================================================
cd /d "%~dp0"
if not exist "logs\tunnel-qr.html" (
  echo.
  echo   QR page not found.
  echo   Please start the public tunnel first:
  echo     double-click  "start public tunnel"  ^(start-tunnel.bat^)
  echo   ...or run:  node tools\tunnel.mjs
  echo.
  pause
  exit /b 1
)
start "" "%~dp0logs\tunnel-qr.html"
