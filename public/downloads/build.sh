#!/usr/bin/env bash
# ==============================================================================
# Berserker v0.4.0 - Auto-Detect Native C++ Compiler Script
# Detects CPU features (AVX2, BMI2, NEON) and compiles native binary
# ==============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== Berserker v0.4.0 Native Engine Build ==="

CXX=""
if command -v g++ >/dev/null 2>&1; then
    CXX="g++"
elif command -v clang++ >/dev/null 2>&1; then
    CXX="clang++"
else
    echo "ERROR: Neither g++ nor clang++ was found."
    echo "Please install build tools: 'sudo apt install build-essential' or 'xcode-select --install'"
    exit 1
fi

FLAGS="-std=c++17 -O3 -pthread -flto"

# Check CPU capabilities
if uname -m | grep -q 'arm\|aarch64'; then
    echo "Detected ARM64 architecture -> compiling with NEON SIMD..."
    FLAGS="$FLAGS -march=armv8-a+simd"
elif grep -q 'avx2' /proc/cpuinfo 2>/dev/null || sysctl -n hw.optional.avx2_0 2>/dev/null | grep -q 1; then
    echo "Detected x86_64 with AVX2/BMI2 support -> compiling with AVX2..."
    FLAGS="$FLAGS -mavx2 -mpopcnt -msse4.2"
else
    echo "Detected standard x86_64 -> compiling with generic modern flags..."
    FLAGS="$FLAGS -mpopcnt -msse4.2"
fi

$CXX $FLAGS berserker-v0.4.0.cpp -o berserker
echo "SUCCESS! Native binary generated at ./berserker"
echo "Test with: ./berserker"
