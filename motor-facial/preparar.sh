#!/usr/bin/env bash
# Instala el MOTOR FACIAL de GymFlow en esta computadora (auditoría 8, bloque
# 0.4; 27-03): su PROPIO entorno de Python con las versiones fijas de
# requirements.txt, en .venv, y el modelo buffalo_sc con su huella, en modelo/.
# Nada se toma de HRFlow en marcha. Si el modelo ya está en ~/.insightface (lo
# dejó HRFlow) y su huella es la esperada, se copia; si no, se descarga de
# InsightFace y se verifica.
#
#   bash ~/gymflow-backend/motor-facial/preparar.sh
#
# Se puede repetir: lo que ya está bien se salta. Lo llama instalar.sh y
# después se prueba con probar.sh. No usa sudo ni escribe fuera de esta carpeta.
# Variables opcionales: GYMFLOW_PYTHON (intérprete, 3.11 o más; por omisión
# python3), GYMFLOW_MOTOR_VENV (entorno) y FACE_MODEL_ROOT (modelo).
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
VENV="${GYMFLOW_MOTOR_VENV:-$AQUI/.venv}"
MODELO="${FACE_MODEL_ROOT:-$AQUI/modelo}/models/buffalo_sc"
PY="${GYMFLOW_PYTHON:-python3}"
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
alto() { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# El modelo validado: el mismo que usaba el sidecar de HRFlow con el que se
# registraron los rostros. Otro modelo daría otros números y nadie se reconocería.
MODELO_URL="https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip"
MODELO_ZIP=57d31b56b6ffa911c8a73cfc1707c73cab76efe7f13b675a05223bf42de47c72
declare -A HUELLA=(
  [det_500m.onnx]=5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a
  [w600k_mbf.onnx]=9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f
)
huella() { sha256sum "$1" 2>/dev/null | cut -c1-64; }
modelo_bien() {
  local f
  for f in "${!HUELLA[@]}"; do [ "$(huella "$1/$f")" = "${HUELLA[$f]}" ] || return 1; done
}

# ── 1. Python ───────────────────────────────────────────────────────────────
command -v "$PY" >/dev/null || alto "Falta Python 3.11 o más. En Ubuntu: sudo apt install -y python3 python3-venv"
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  || alto "$("$PY" -V 2>&1) es viejo: el motor facial pide Python 3.11 o más."

# ── 2. Entorno propio ───────────────────────────────────────────────────────
if ! "$VENV/bin/python" -c 'import sys' >/dev/null 2>&1; then
  # Solo se rehace una carpeta que sea un entorno (tiene pyvenv.cfg) o no exista.
  [ ! -e "$VENV" ] || [ -f "$VENV/pyvenv.cfg" ] || alto "$VENV existe y no es un entorno de Python: muévelo o indica otro con GYMFLOW_MOTOR_VENV."
  if "$PY" -c 'import ensurepip' >/dev/null 2>&1; then
    "$PY" -m venv --clear "$VENV"
  elif "$PY" -m virtualenv --version >/dev/null 2>&1; then
    "$PY" -m virtualenv -q --clear "$VENV"
  else
    alto "Python no puede crear entornos. En Ubuntu: sudo apt install -y python3-venv (o python3.X-venv con tu versión)"
  fi
fi

# Las dependencias se instalan cuando cambia requirements.txt (su huella queda en el entorno).
SELLO="$VENV/.gymflow-requisitos"
QUIERO=$(huella "$AQUI/requirements.txt")
if [ "$(cat "$SELLO" 2>/dev/null)" != "$QUIERO" ]; then
  echo "  Instalando las dependencias del motor facial (la primera vez tarda unos minutos)…"
  # -qq: solo errores (la caché de pip llena la pantalla de avisos inofensivos).
  PIP=("$VENV/bin/python" -m pip --disable-pip-version-check --no-input -qq)
  "${PIP[@]}" install -r "$AQUI/requirements.txt" \
    || alto "No se pudieron instalar las dependencias de requirements.txt. Revisa la conexión y vuelve a correr este guion."
  # insightface arrastra opencv-python (el completo, con ventanas), que pisa al
  # headless y pide libGL: se quita y se vuelve a poner el headless, igual que
  # la imagen de HRFlow en su servidor.
  HEADLESS=$(grep -E '^opencv-python-headless==' "$AQUI/requirements.txt")
  "${PIP[@]}" uninstall -y opencv-python >/dev/null 2>&1 || true
  "${PIP[@]}" install --force-reinstall --no-deps "$HEADLESS" \
    || alto "No se pudo dejar $HEADLESS como única versión de OpenCV."
  echo "$QUIERO" > "$SELLO"
fi
"$VENV/bin/python" -c 'import cv2, fastapi, insightface, numpy, onnxruntime, uvicorn' >/dev/null 2>&1 \
  || alto "El entorno $VENV está incompleto. Bórralo y vuelve a correr este guion."
ok "Entorno propio del motor facial: $("$VENV/bin/python" -V 2>&1) en $VENV"

# ── 3. Modelo ───────────────────────────────────────────────────────────────
if ! modelo_bien "$MODELO"; then
  mkdir -p "$MODELO"
  if modelo_bien "$HOME/.insightface/models/buffalo_sc"; then
    cp "$HOME/.insightface/models/buffalo_sc/det_500m.onnx" "$HOME/.insightface/models/buffalo_sc/w600k_mbf.onnx" "$MODELO/"
    echo "  Modelo copiado de ~/.insightface (misma huella que el validado)."
  else
    echo "  Descargando el modelo buffalo_sc de InsightFace (15 MB)…"
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT
    "$VENV/bin/python" -I -c 'import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' \
      "$MODELO_URL" "$TMP/buffalo_sc.zip" || alto "No se pudo descargar el modelo de $MODELO_URL. Revisa la conexión."
    [ "$(huella "$TMP/buffalo_sc.zip")" = "$MODELO_ZIP" ] || alto "El modelo descargado no tiene la huella esperada: no se usa."
    "$VENV/bin/python" -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$TMP/buffalo_sc.zip" "$MODELO"
  fi
  modelo_bien "$MODELO" || alto "El modelo en $MODELO no tiene la huella esperada."
fi
ok "Modelo buffalo_sc con su huella en $MODELO"
