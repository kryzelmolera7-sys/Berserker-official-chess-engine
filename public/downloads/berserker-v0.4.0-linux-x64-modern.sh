#!/usr/bin/env bash
# ==============================================================================
# Berserker v0.4.0 UCI Engine - Linux x64 (Modern SSE4.2 Compatibility)
# Target: Older x86_64 machines (Intel Core 2 Quad, Nehalem, Sandy Bridge)
# ==============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BERSERKER_ARCH="x64-modern"
export NODE_OPTIONS="--max-old-space-size=2048"

if command -v bun >/dev/null 2>&1; then
    exec nice -n -2 bun "$DIR/berserker-v0.4.0-cli.js" "$@"
elif command -v node >/dev/null 2>&1; then
    exec nice -n -2 node "$DIR/berserker-v0.4.0-cli.js" "$@"
else
    echo "[Berserker ERROR] Neither Bun nor Node.js found in PATH." >&2
    echo "Install via: 'sudo apt install nodejs' or 'curl -fsSL https://bun.sh/install | bash'" >&2
    exit 1
fi
