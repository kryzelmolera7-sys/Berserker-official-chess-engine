@echo off
REM ==============================================================================
REM Berserker v0.4.0 - Windows Native C++ Compiler Script
REM Supports MSVC (cl.exe) and MinGW (g++.exe)
REM ==============================================================================

cd /d "%~dp0"
echo === Berserker v0.4.0 Windows Native Build ===

where g++ >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo Compiling with MinGW GCC (AVX2)...
    g++ -std=c++17 -O3 -mavx2 -mpopcnt -msse4.2 -pthread -flto berserker-v0.4.0.cpp -o berserker.exe
    goto :done
)

where cl >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo Compiling with Microsoft Visual C++ (AVX2)...
    cl /std:c++17 /O2 /Oi /Ot /GL /arch:AVX2 berserker-v0.4.0.cpp /Fe:berserker.exe
    goto :done
)

echo [ERROR] Neither MinGW g++ nor MSVC cl was found in PATH.
echo Install MinGW-w64 or Visual Studio C++ build tools.
pause
exit /b 1

:done
echo SUCCESS! Native binary compiled: berserker.exe
pause
