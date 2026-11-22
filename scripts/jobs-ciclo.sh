#!/usr/bin/env bash
# EL CICLO DE LOS JOBS (auditoría 8, fase 1, bloque 1.16; 28-15, 11-09).
#
#   bash scripts/jobs-ciclo.sh uso-real|pruebas
#
# Se queda corriendo: cada 15 minutos corre el corredor de 15 minutos
# (clases terminadas, dinero en tránsito, firmas vencidas) y, al arrancar y
# una vez cada hora, el cierre diario (mora, vencimientos, avisos, bitácora).
# El cierre diario incluye los jobs frecuentes y NO repite lo que ya corrió
# bien hoy en cada gimnasio: correrlo cada hora solo hace trabajo la primera
# vez del día (pasada la medianoche del gimnasio) o cuando algo falló.
#
# Los dos corredores llevan candado en la base (`job_runs`): un `pnpm
# jobs:local` a mano mientras el ciclo corre no se cruza con él. Cada corrida
# deja su bitácora por fecha en ~/.gymflow-logs/jobs/<perfil>/ y su fila en
# `job_runs`; el estado se consulta con `pnpm jobs:local:estado`.
#
# Para apagarlo basta la señal TERM: se la pasa a la corrida en curso, que
# queda marcada como cortada en `job_runs`.
set -uo pipefail

perfil="${1:-}"
case "$perfil" in
  uso-real|pruebas) ;;
  *) echo "Uso: bash scripts/jobs-ciclo.sh uso-real|pruebas" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
CADA="${GYMFLOW_JOBS_CADA_SEGUNDOS:-900}"      # cada cuánto corre el corredor frecuente
DIARIO_CADA="${GYMFLOW_JOBS_DIARIO_CADA:-4}"   # cada cuántas vueltas va el cierre diario (4 × 15 min = 1 h)

hijo=""
apagar() {
  [ -n "$hijo" ] && kill -TERM "$hijo" 2>/dev/null && wait "$hijo" 2>/dev/null
  echo "$(date '+%F %T') ciclo de jobs ($perfil) apagado"
  exit 0
}
trap apagar TERM INT

vuelta=0
echo "$(date '+%F %T') ciclo de jobs ($perfil): corredor cada ${CADA}s, cierre diario cada ${DIARIO_CADA} vueltas"
while true; do
  if [ $((vuelta % DIARIO_CADA)) -eq 0 ]; then cual=run-daily; else cual=run-frequent; fi
  bash scripts/perfil.sh "$perfil" ./node_modules/.bin/tsx "src/platform/jobs/$cual.ts" &
  hijo=$!
  wait "$hijo"; codigo=$?
  hijo=""
  [ "$codigo" -ne 0 ] && echo "$(date '+%F %T') $cual terminó con código $codigo (ver arriba y: pnpm jobs:${perfil/uso-real/local}:estado)"
  vuelta=$((vuelta + 1))
  sleep "$CADA" &
  hijo=$!
  wait "$hijo"
  hijo=""
done
