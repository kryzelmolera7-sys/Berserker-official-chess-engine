#!/usr/bin/env bash
# ==============================================================================
# Berserker v0.4.0 UCI Engine - macOS Apple Silicon (M1 / M2 / M3 / M4)
# Double-click in macOS Finder to launch or load path into Banksia / CuteChess
# ==============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BERSERKER_ARCH="apple-silicon-neon"
export NODE_OPTIONS="--max-old-space-size=4096"

echo "=== Berserker v0.4.0 [macOS Apple Silicon] ==="

if command -v bun >/dev/null 2>&1; then
    exec bun "$DIR/berserker-v0.4.0-cli.js" "$@"
elif command -v node >/dev/null 2>&1; then
    exec node "$DIR/berserker-v0.4.0-cli.js" "$@"
elif [ -f "/opt/homebrew/bin/node" ]; then
    exec /opt/homebrew/bin/node "$DIR/berserker-v0.4.0-cli.js" "$@"
else
    echo "[Berserker ERROR] Node.js or Bun was not detected on your Mac."
    echo "Install via Homebrew: 'brew install node' or visit https://nodejs.org"
    read -p "Press Enter to close..."
    exit 1
fi
