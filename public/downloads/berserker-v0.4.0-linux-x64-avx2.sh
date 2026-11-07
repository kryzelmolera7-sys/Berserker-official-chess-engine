#!/usr/bin/env bash
# ==============================================================================
# Berserker v0.4.0 UCI Engine - Linux x64 (AVX2 Optimized)
# Target: Intel Haswell+ / AMD Ryzen x86_64 distributions
# ==============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BERSERKER_ARCH="x64-avx2"
export NODE_OPTIONS="--max-old-space-size=4096"

if command -v bun >/dev/null 2>&1; then
    exec nice -n -5 bun "$DIR/berserker-v0.4.0-cli.js" "$@"
elif command -v node >/dev/null 2>&1; then
    exec nice -n -5 node "$DIR/berserker-v0.4.0-cli.js" "$@"
else
    echo "[Berserker ERROR] Neither Bun nor Node.js found in PATH." >&2
    echo "Install via your package manager: 'sudo apt install nodejs' or 'curl -fsSL https://bun.sh/install | bash'" >&2
    exit 1
fi
