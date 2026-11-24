#!/usr/bin/env bash
# PERFILES DE ARRANQUE de la API (auditoría 8, fase 0.1): uno por base, con
# todo explícito. Pone las variables del perfil y ejecuta el comando.
#
#   bash scripts/perfil.sh uso-real <comando…>   gymflow_local · API 3001 · sin cobro en línea
#   bash scripts/perfil.sh pruebas  <comando…>   gymflow_pruebas · API 4001 · caja de arena
#
# Los valores viven aquí; las REGLAS, en src/platform/perfiles.ts: con una
# combinación inválida la API no arranca y dice qué está mal. El `.env` de
# desarrollo pone lo demás (llaves) y nunca pisa lo que se exporta aquí.
set -euo pipefail

perfil="${1:-}"
[ $# -ge 2 ] || { echo "Uso: bash scripts/perfil.sh uso-real|pruebas <comando…>" >&2; exit 2; }
shift

case "$perfil" in
  uso-real)
    # La contraseña propia de la base vive FUERA de los repositorios; la crea
    # `pnpm local:preparar` (rol gymflow_local_app). La de desarrollo está
    # publicada en el repositorio y la API la rechaza para el uso real.
    SECRETOS="${GYMFLOW_SECRETOS:-$HOME/.gymflow/uso-real.env}"
    CLAVE=$( (sed -n 's/^GYMFLOW_LOCAL_DB_PASSWORD=//p' "$SECRETOS" 2>/dev/null || true) | tail -1)
    if [ -z "$CLAVE" ]; then
      echo "Falta la contraseña propia del uso real en $SECRETOS." >&2
      echo "Prepárala (una vez) con:  cd ~/gymflow-backend && pnpm local:preparar" >&2
      exit 1
    fi
    export DATABASE_URL="postgresql://gymflow_local_app:${CLAVE}@127.0.0.1:5432/gymflow_local?schema=public"
    # Token del motor facial propio (0.4): el mismo que lee motor-facial/run.sh.
    TOKEN=$( (sed -n 's/^FACE_SIDECAR_TOKEN=//p' "$SECRETOS" 2>/dev/null || true) | tail -1)
    [ -n "$TOKEN" ] && export FACE_SIDECAR_TOKEN="$TOKEN"
    export API_PORT=3001
    # Sin procesador contratado: el portal dice «Paga en recepción» (25-01).
    export PAYMENT_PROVIDER=none
    # El proxy de Next y el túnel corren en esta misma computadora (24-01).
    export TRUSTED_PROXIES="127.0.0.1,::1"
    # DIRECCIÓN FIJA (D-01, fase 3): el dominio propio por el que se entra
    # desde fuera. Sus valores viven FUERA de los repositorios, en el mismo
    # archivo de secretos (GYMFLOW_PANEL_URL y GYMFLOW_PORTAL_URL, las dos con
    # https://). Con ellas la API conoce su dirección pública arranque como
    # arranque (gymflow.sh, los jobs a mano): los QR y los enlaces no cambian.
    # El túnel que la abre lo arranca gymflow.sh. Sin ellas, todo queda en esta
    # computadora, como siempre. El modo remoto provisional (túneles sin
    # cuenta) exporta las suyas antes de llamar aquí, y esas mandan.
    secreto() { (sed -n "s/^$1=//p" "$SECRETOS" 2>/dev/null || true) | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" | tr -d '\r'; }
    PANEL_FIJO=$(secreto GYMFLOW_PANEL_URL); PANEL_FIJO="${PANEL_FIJO%/}"
    PORTAL_FIJO=$(secreto GYMFLOW_PORTAL_URL); PORTAL_FIJO="${PORTAL_FIJO%/}"
    if [ -z "${PORTAL_PUBLIC_URL:-}" ] && { [ -n "$PANEL_FIJO" ] || [ -n "$PORTAL_FIJO" ]; }; then
      if [ -z "$PANEL_FIJO" ] || [ -z "$PORTAL_FIJO" ]; then
        echo "La dirección fija va completa en $SECRETOS: GYMFLOW_PANEL_URL y GYMFLOW_PORTAL_URL, las dos (falta una)." >&2
        exit 1
      fi
      export PANEL_PUBLIC_URL="$PANEL_FIJO" PORTAL_PUBLIC_URL="$PORTAL_FIJO"
      export CORS_ORIGINS="http://localhost:3003,http://localhost:3002,$PANEL_FIJO,$PORTAL_FIJO"
      export PORTAL_ORIGINS="http://localhost:3002,$PORTAL_FIJO"
      # Opcional: vacía, cada cookie vale solo en la dirección que la puso (lo más cerrado).
      DOMINIO=$(secreto SESSION_COOKIE_DOMAIN)
      [ -n "$DOMINIO" ] && export SESSION_COOKIE_DOMAIN="$DOMINIO"
    fi
    # Avisos al teléfono (llaves propias; las crea «bash gymflow.sh avisos») y,
    # si se quiere, las redes desde las que se opera la consola de plataforma.
    for variable in VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT PLATFORM_ALLOWED_IPS; do
      valor=$(secreto "$variable")
      [ -n "$valor" ] && export "$variable=$valor"
    done
    # El modo remoto agrega las direcciones del túnel antes de llamar aquí.
    export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:3003,http://localhost:3002}"
    export PORTAL_ORIGINS="${PORTAL_ORIGINS:-http://localhost:3002}"
    ;;
  pruebas)
    export DATABASE_URL="postgresql://gymflow_app:${GYMFLOW_APP_PASSWORD:-gymflow_app_dev}@127.0.0.1:5432/gymflow_pruebas?schema=public"
    export API_PORT=4001
    export PAYMENT_PROVIDER=sandbox
    export TRUSTED_PROXIES="127.0.0.1,::1"
    export CORS_ORIGINS="http://localhost:4003,http://localhost:4002"
    export PORTAL_ORIGINS="http://localhost:4002"
    # Lo que codifican los QR del panel de pruebas: el portal de pruebas.
    export PORTAL_PUBLIC_URL="${PORTAL_PUBLIC_URL:-http://localhost:4002}"
    ;;
  *)
    echo "Perfil desconocido: «$perfil». Usa uso-real o pruebas." >&2
    exit 2
    ;;
esac

exec "$@"
