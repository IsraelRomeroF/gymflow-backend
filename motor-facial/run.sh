#!/usr/bin/env bash
# Arranca el MOTOR FACIAL de GymFlow: SOLO en 127.0.0.1 y con token obligatorio
# (auditoría 8, bloque 0.4; 27-03 y A5-N4). Lo arranca gymflow.sh con el token
# de token.sh, el mismo que recibe la API. Desde fuera de esta computadora no
# se alcanza: solo la API, que corre aquí mismo, le habla.
#
#   FACE_SIDECAR_TOKEN=$(bash token.sh) bash run.sh                (puerto 5101)
#   FACE_PORT=5102 FACE_SIDECAR_TOKEN=… bash run.sh                (otro puerto, para probar)
#
# Lo instala preparar.sh (entorno en .venv y modelo en modelo/).
set -euo pipefail
cd "$(dirname "$0")"
VENV="${GYMFLOW_MOTOR_VENV:-$PWD/.venv}"
PORT="${FACE_PORT:-5101}"
if [ ! -x "$VENV/bin/python" ]; then
  echo "El motor facial no está instalado (falta su entorno en $VENV). Instálalo con: bash $PWD/preparar.sh" >&2
  exit 1
fi
TOKEN="${FACE_SIDECAR_TOKEN:-}"
if [ "${#TOKEN}" -lt 32 ]; then
  echo "Falta FACE_SIDECAR_TOKEN (32 caracteres o más): sin token el motor no arranca. gymflow.sh lo toma de token.sh." >&2
  exit 1
fi
export FACE_MODEL_ROOT="${FACE_MODEL_ROOT:-$PWD/modelo}"
# --host fijo: no hay variable para abrirlo a la red (A5-N4).
exec "$VENV/bin/python" -m uvicorn main:app --host 127.0.0.1 --port "$PORT" --no-server-header
