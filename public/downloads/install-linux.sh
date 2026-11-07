#!/usr/bin/env bash
# ==============================================================================
# Berserker v0.4.0 - Linux System-Wide Installer
# Installs berserker CLI to /usr/local/bin/berserker
# ==============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="/usr/local/bin/berserker"
SHARE_DIR="/usr/local/share/berserker"

echo "=== Berserker v0.4.0 Linux Installer ==="

if [ "$EUID" -ne 0 ]; then
    echo "Elevating privileges with sudo..."
    exec sudo bash "$0" "$@"
fi

mkdir -p "$SHARE_DIR"
cp "$DIR/berserker-v0.4.0-cli.js" "$SHARE_DIR/berserker.js"

if [ -f "$DIR/berserker_brnnue_v040.nnue" ]; then
    cp "$DIR/berserker_brnnue_v040.nnue" "$SHARE_DIR/"
fi

cat << 'EOF' > "$TARGET"
#!/usr/bin/env bash
SHARE="/usr/local/share/berserker"
if command -v bun >/dev/null 2>&1; then
    exec bun "$SHARE/berserker.js" "$@"
else
    exec node "$SHARE/berserker.js" "$@"
fi
EOF

chmod +x "$TARGET"
chmod 755 "$SHARE_DIR"

echo "Installation complete!"
echo "Berserker v0.4.0 is now installed to $TARGET"
echo "Test by typing: 'berserker' in your terminal."
