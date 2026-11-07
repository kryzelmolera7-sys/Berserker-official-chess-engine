@echo off
REM ============================================================================
REM Berserker v0.4.0 UCI Engine - Windows ARM64
REM Target: Snapdragon X Elite / Qualcomm Snapdragon / Surface Pro Copilot+ PCs
REM ============================================================================

title Berserker v0.4.0 [Windows ARM64]
set BERSERKER_ARCH=arm64-neon
set NODE_OPTIONS=--max-old-space-size=4096

where bun >nul 2>nul
if %ERRORLEVEL% equ 0 (
    start /b /high bun "%~dp0berserker-v0.4.0-cli.js" %*
    goto :eof
)

where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
    start /b /high node "%~dp0berserker-v0.4.0-cli.js" %*
    goto :eof
)

echo [ERROR] Neither Node.js nor Bun was found in PATH.
echo Please install Node.js (ARM64 build) from https://nodejs.org or Bun from https://bun.sh
pause
