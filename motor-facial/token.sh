#!/usr/bin/env bash
# TOKEN DEL MOTOR FACIAL (auditoría 8, bloque 0.4; A5-N4): el secreto que
# comparten la API y el motor, en la cabecera X-Face-Token. Uno por
# computadora, porque el motor es uno solo para el uso real y las pruebas.
#
# Vive FUERA de los repositorios, con el MISMO valor en dos archivos:
#   ~/.gymflow/uso-real.env   FACE_SIDECAR_TOKEN=…     el que manda; junto a la
#                             contraseña propia del uso real (solo tu usuario lo lee)
#   gymflow-backend/.env      FACE_SIDECAR_TOKEN="…"   pruebas y la API arrancada
#                             a mano con pnpm (el .env no se comitea)
#
# Imprime el token (para quien arranca el motor y la API; los avisos van a la
# salida de error) y lo crea o lo copia si falta. Nunca cambia uno que ya
# existe: si los dos difieren, avisa. Para cambiarlo, borra su línea de los
# dos archivos y vuelve a arrancar GymFlow; nada está cifrado con él.
#
#   FACE_SIDECAR_TOKEN=$(bash ~/gymflow-backend/motor-facial/token.sh)
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
SECRETOS="${GYMFLOW_SECRETOS:-$HOME/.gymflow/uso-real.env}"
DOTENV="${GYMFLOW_BACKEND_ENV:-$(dirname "$AQUI")/.env}"
aviso() { echo "token.sh: $*" >&2; }
leer() { if [ -f "$1" ]; then sed -n 's/^FACE_SIDECAR_TOKEN=//p' "$1" | tail -1 | tr -d "\"' \r"; fi; }

guardado=$(leer "$SECRETOS")
del_env=$(leer "$DOTENV")
token=${guardado:-$del_env}
if [ -z "$token" ]; then
  # 32 bytes al azar en base64url: 43 caracteres sin signos que estorben en un .env.
  token=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))" 2>/dev/null \
    || python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
fi
if [ "${#token}" -lt 32 ] || [[ ! "$token" =~ ^[A-Za-z0-9_-]+$ ]]; then
  aviso "el FACE_SIDECAR_TOKEN guardado no sirve (32 caracteres o más, solo letras, números, - y _). Borra su línea de $SECRETOS y de $DOTENV y vuelve a correr."
  exit 1
fi

if [ -z "$guardado" ]; then
  mkdir -p "$(dirname "$SECRETOS")"
  chmod 700 "$(dirname "$SECRETOS")"
  ( umask 077
    printf '%s\n' "# Token del motor facial (cabecera X-Face-Token): el mismo en la API y en el motor. No se comitea." \
      "FACE_SIDECAR_TOKEN=${token}" >> "$SECRETOS" )
  chmod 600 "$SECRETOS"
  aviso "token del motor facial guardado en $SECRETOS"
fi

if [ ! -f "$DOTENV" ]; then
  aviso "no existe $DOTENV: una API arrancada a mano no tendrá el token (gymflow.sh se lo pasa igual)."
elif [ -z "$del_env" ]; then
  if grep -q '^FACE_SIDECAR_TOKEN=' "$DOTENV"; then
    # La línea vacía que trae .env.example: se llena ahí mismo.
    sed -i "s/^FACE_SIDECAR_TOKEN=.*$/FACE_SIDECAR_TOKEN=\"${token}\"/" "$DOTENV"
  else
    printf '\n%s\n%s\n' "# Token del motor facial: el mismo de ~/.gymflow/uso-real.env (lo copió motor-facial/token.sh)." \
      "FACE_SIDECAR_TOKEN=\"${token}\"" >> "$DOTENV"
  fi
  aviso "token del motor facial copiado a $DOTENV"
elif [ "$del_env" != "$token" ]; then
  aviso "$DOTENV trae OTRO FACE_SIDECAR_TOKEN. gymflow.sh usa el de $SECRETOS; una API arrancada a mano con pnpm usaría el del .env y el motor la rechazaría (401). Deja el mismo valor en los dos."
fi

printf '%s\n' "$token"
