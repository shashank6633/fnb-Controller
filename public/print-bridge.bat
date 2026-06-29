@echo off
title FnB Print Bridge
cd /d "%~dp0"

REM ============================================================
REM  F&B Controller - Print Bridge launcher (Windows)
REM  Double-click this file on the counter PC to start printing.
REM  Keep the window that opens OPEN while you use the POS.
REM ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is NOT installed on this PC.
  echo  1^) Open https://nodejs.org and download the "LTS" Windows installer.
  echo  2^) Run it and click Next through the defaults.
  echo  3^) Then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "print-bridge.mjs" (
  echo.
  echo  print-bridge.mjs was not found in this folder:
  echo    %cd%
  echo  Download it from the POS website -^> "KOT and Bill Printers" page,
  echo  save it in the SAME folder as this file, then run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo  Starting the print bridge...
echo  KEEP THIS WINDOW OPEN while you use the POS and print KOTs / bills.
echo  Closing this window stops printing.
echo.
node print-bridge.mjs

echo.
echo  The print bridge has stopped.
pause
