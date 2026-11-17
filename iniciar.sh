#!/usr/bin/env bash
# Arranca CobraYa. Uso: ./iniciar.sh [puerto]
set -euo pipefail
cd "$(dirname "$0")"
PUERTO="${1:-8787}"
exec python3 servidor.py --puerto "$PUERTO"
