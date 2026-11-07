#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# Berserker v0.4.0 - Android Termux 1-Command Installer
# Installs Node.js in Termux and links berserker to $PREFIX/bin/berserker
# ==============================================================================
set -e

echo "=== Berserker v0.4.0 Android Termux Setup ==="
pkg update -y
pkg install -y nodejs-lts

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$PREFIX/share/berserker"
cp "$DIR/berserker-v0.4.0-cli.js" "$PREFIX/share/berserker/"
if [ -f "$DIR/berserker_brnnue_v040.nnue" ]; then
    cp "$DIR/berserker_brnnue_v040.nnue" "$PREFIX/share/berserker/"
fi

cat << 'EOF' > "$PREFIX/bin/berserker"
#!/data/data/com.termux/files/usr/bin/bash
exec node "$PREFIX/share/berserker/berserker-v0.4.0-cli.js" "$@"
EOF

chmod +x "$PREFIX/bin/berserker"
echo "Berserker v0.4.0 installed successfully in Termux!"
echo "Run 'berserker' anytime to start the UCI engine."
