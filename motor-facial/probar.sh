#!/usr/bin/env bash
# PRUEBA DE HUMO del motor facial (auditoría 8, bloque 0.4). Lo arranca APARTE,
# en un puerto libre y con un token desechable; comprueba que /health
# responde, que sin token o con uno equivocado responde 401, que una
# comparación de ejemplo sale bien (la misma cara se reconoce y otra no) y que
# la prueba de vida rechaza un cuadro quieto. Al terminar lo apaga.
#
# No toca el motor que sirve al gimnasio en el 5101, ni el token guardado, ni
# las bases. Lo corren instalar.sh y verificar.sh.
#
#   bash ~/gymflow-backend/motor-facial/probar.sh
#   PUERTO=5102 bash ~/gymflow-backend/motor-facial/probar.sh
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
VENV="${GYMFLOW_MOTOR_VENV:-$AQUI/.venv}"
if [ ! -x "$VENV/bin/python" ]; then
  printf '  \033[31m✗ El motor facial no está instalado: bash %s/preparar.sh\033[0m\n' "$AQUI" >&2
  exit 1
fi
PUERTO="${PUERTO:-$("$VENV/bin/python" -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')}"
export FACE_SIDECAR_TOKEN
FACE_SIDECAR_TOKEN=$("$VENV/bin/python" -I -c 'import secrets; print(secrets.token_urlsafe(32))')
BITACORA=$(mktemp)
FACE_PORT="$PUERTO" bash "$AQUI/run.sh" > "$BITACORA" 2>&1 &
MOTOR=$!
# Al salir se apaga el motor de prueba y se conserva el resultado de la prueba.
trap 'r=$?; kill "$MOTOR" 2>/dev/null || true; wait "$MOTOR" 2>/dev/null || true; rm -f "$BITACORA"; exit $r' EXIT

echo "  Probando el motor facial aparte, en 127.0.0.1:$PUERTO…"
if "$VENV/bin/python" -I "$AQUI/prueba_motor.py" "http://127.0.0.1:$PUERTO"; then
  # Solo escucha en 127.0.0.1: nada en las demás direcciones.
  if ss -ltn 2>/dev/null | grep ":$PUERTO " | grep -vq "127.0.0.1:$PUERTO "; then
    printf '  \033[31m✗ El motor escucha fuera de 127.0.0.1\033[0m\n' >&2
    exit 1
  fi
  echo "  ✓ escucha solo en 127.0.0.1"
else
  echo "  Lo último de su bitácora:" >&2
  tail -15 "$BITACORA" | sed 's/^/    /' >&2
  exit 1
fi
