@echo off
REM ============================================================================
REM Berserker v0.4.0 UCI Engine - Windows x64 (Modern / SSE4.2 Compatibility)
REM Target: Intel Nehalem / Sandy Bridge / AMD Bulldozer / Older 64-bit systems
REM ============================================================================

title Berserker v0.4.0 [Windows x64 Modern]
set BERSERKER_ARCH=x64-modern
set NODE_OPTIONS=--max-old-space-size=2048

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
echo Please install Node.js from https://nodejs.org or Bun from https://bun.sh
pause
