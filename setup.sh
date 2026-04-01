#!/usr/bin/env bash
# Instala o native messaging host para o Anti-Twitter no Firefox/Zen
# Execute uma vez: bash setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_PY="$SCRIPT_DIR/anti_twitter/app.py"
HOST_JSON="$SCRIPT_DIR/reader_gate_host.json"
INSTALL_DIR="$HOME/.mozilla/native-messaging-hosts"

# Verifica se o app.py existe
if [ ! -f "$APP_PY" ]; then
  echo "❌ Erro: $APP_PY não encontrado."
  exit 1
fi

# Torna o app.py executável
chmod +x "$APP_PY"

# Cria o diretório de native messaging se não existir
mkdir -p "$INSTALL_DIR"

# Gera o arquivo JSON com o caminho correto
cat > "$INSTALL_DIR/reader_gate_host.json" <<EOF
{
  "name": "reader_gate_host",
  "description": "Backend Python para o Anti-Twitter",
  "path": "$APP_PY",
  "type": "stdio",
  "allowed_extensions": ["anti-twitter@example.local"]
}
EOF

echo "✅ Native messaging host instalado em: $INSTALL_DIR/reader_gate_host.json"
echo "✅ Caminho do app.py: $APP_PY"
echo ""
echo "Agora recarregue a extensão no about:debugging e teste!"
