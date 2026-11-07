@echo off
REM ============================================================================
REM Berserker v0.4.0 UCI Engine - Windows x64 (AVX2 Optimized)
REM Target: Intel Core 4th Gen+ / AMD Ryzen (Haswell, Zen, and newer)
REM ============================================================================

title Berserker v0.4.0 [Windows x64 AVX2]
set BERSERKER_ARCH=x64-avx2
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
echo Please install Node.js from https://nodejs.org or Bun from https://bun.sh
pause
