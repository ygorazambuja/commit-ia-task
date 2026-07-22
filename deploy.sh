#!/usr/bin/env bash
set -euo pipefail

APP_NAME="commit-ia-task"
INSTALL_DIR="/usr/local/lib/${APP_NAME}"
BIN_PATH="/usr/local/bin/${APP_NAME}"
TMP_DIR="$(mktemp -d)"

cleanup() {
	rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if ! command -v bun >/dev/null 2>&1; then
	echo "Erro: bun não encontrado no PATH." >&2
	exit 1
fi

bun build ./src/index.ts --target=bun --outfile "$TMP_DIR/index.js"

cat >"$TMP_DIR/${APP_NAME}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

exec bun "${INSTALL_DIR}/index.js" "\$@"
EOF

chmod +x "$TMP_DIR/${APP_NAME}"

sudo mkdir -p "$INSTALL_DIR"
sudo install -m 0644 "$TMP_DIR/index.js" "$INSTALL_DIR/index.js"
sudo install -m 0755 "$TMP_DIR/${APP_NAME}" "$BIN_PATH"

echo "Instalado em ${BIN_PATH}"
