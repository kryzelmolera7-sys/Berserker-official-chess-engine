#!/usr/bin/env bash
# ==============================================================================
# Berserker v0.4.0 UCI Engine - macOS Intel x64 (AVX2 / SSE4.2)
# Double-click in macOS Finder to launch or load path into Banksia / CuteChess
# ==============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BERSERKER_ARCH="macos-x64-avx2"
export NODE_OPTIONS="--max-old-space-size=4096"

echo "=== Berserker v0.4.0 [macOS Intel x64] ==="

if command -v bun >/dev/null 2>&1; then
    exec bun "$DIR/berserker-v0.4.0-cli.js" "$@"
elif command -v node >/dev/null 2>&1; then
    exec node "$DIR/berserker-v0.4.0-cli.js" "$@"
elif [ -f "/usr/local/bin/node" ]; then
    exec /usr/local/bin/node "$DIR/berserker-v0.4.0-cli.js" "$@"
else
    echo "[Berserker ERROR] Node.js or Bun was not detected on your Mac."
    echo "Install via Homebrew: 'brew install node' or visit https://nodejs.org"
    read -p "Press Enter to close..."
    exit 1
fi
