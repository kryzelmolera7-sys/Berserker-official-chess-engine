@echo off
REM ============================================================================
REM Berserker v0.4.0 Official UCI Engine Windows Launcher
REM Author: Berserker Engine Team
REM ============================================================================

title Berserker v0.4.0 Standalone UCI Engine

where bun >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [Berserker] Launching via Bun runtime (high-performance)...
    start /b /high bun "%~dp0berserker-v0.4.0-cli.js" %*
    goto :eof
)

where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [Berserker] Launching via Node.js runtime...
    start /b /high node "%~dp0berserker-v0.4.0-cli.js" %*
    goto :eof
)

echo [ERROR] Neither Node.js nor Bun was found in your PATH.
echo Please install Node.js (https://nodejs.org) or Bun (https://bun.sh) to run Berserker v0.4.0.
pause
