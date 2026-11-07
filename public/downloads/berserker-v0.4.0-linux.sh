#!/usr/bin/env bash
# ============================================================================
# Berserker v0.4.0 Official UCI Engine Linux/macOS Launcher
# Author: Berserker Engine Team
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v bun >/dev/null 2>&1; then
    exec bun "${SCRIPT_DIR}/berserker-v0.4.0-cli.js" "$@"
elif command -v node >/dev/null 2>&1; then
    exec node "${SCRIPT_DIR}/berserker-v0.4.0-cli.js" "$@"
else
    echo "[ERROR] Neither Node.js nor Bun was found in PATH." >&2
    echo "Please install Node.js (https://nodejs.org) or Bun (https://bun.sh)." >&2
    exit 1
fi
