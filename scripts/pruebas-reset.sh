#!/usr/bin/env bash
# Regenera desde cero la base de PRUEBAS AUTOMÁTICAS (gymflow_pruebas):
# gimnasios ficticios que usan los recorridos de navegador. No es la base de trabajo.
#
# Es una base aparte a propósito: las pruebas escriben en gymflow_dev y la
# llenan de sucursales "Padrón de prueba" y textos "Prueba PRIVACY_NOTICE",
# que es exactamente lo que no debe verse en la base de trabajo (gymflow_local).
#
# Solo borra gymflow_pruebas. El nombre está fijo aquí y no se lee del entorno.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DBREPO="$HERE/../gymflow-db"
BASE_PRUEBAS=gymflow_pruebas
ADMIN_URL="${PGADMIN_URL:-postgresql://postgres@localhost/postgres?host=/tmp}"
OWNER_PW="${GYMFLOW_OWNER_PASSWORD:-gymflow_owner_dev}"
APP_PW="${GYMFLOW_APP_PASSWORD:-gymflow_app_dev}"

export DATABASE_URL="postgresql://gymflow_app:${APP_PW}@127.0.0.1:5432/${BASE_PRUEBAS}?schema=public"
export DATABASE_URL_MIGRATOR="postgresql://gymflow_owner:${OWNER_PW}@127.0.0.1:5432/${BASE_PRUEBAS}?schema=public"
export SHADOW_DATABASE_URL="postgresql://gymflow_owner:${OWNER_PW}@127.0.0.1:5432/${BASE_PRUEBAS}_shadow?schema=public"
# El puerto del perfil de PRUEBAS (fase 0.1): el sembrado arma la API en memoria y
# la API se niega a ver gymflow_pruebas con el 3001 del uso real que trae el .env.
export API_PORT=4001

echo "── 1/5 · Borrando y recreando ${BASE_PRUEBAS}"
(cd "$DBREPO" && node -e "
  const pg = require('pg');
  const c = new pg.Client({ connectionString: process.argv[1] });
  (async () => {
    await c.connect();
    await c.query(\"select pg_terminate_backend(pid) from pg_stat_activity where datname = '${BASE_PRUEBAS}' and pid <> pg_backend_pid()\");
    await c.query('DROP DATABASE IF EXISTS ${BASE_PRUEBAS}');
    await c.end();
  })().catch((e) => { console.error(e.message); process.exit(1); });
" "$ADMIN_URL")
(cd "$DBREPO" && GYMFLOW_DB="$BASE_PRUEBAS" PGADMIN_URL="$ADMIN_URL" node scripts/bootstrap-db.mjs | tail -2)

echo "── 2/5 · Migraciones"
(cd "$DBREPO" && pnpm -s exec prisma migrate deploy 2>&1 | tail -1)

echo "── 3/5 · Catálogo y gimnasios de prueba"
(cd "$DBREPO" && pnpm -s exec tsx src/seed.ts >/dev/null && pnpm -s exec tsx src/seed-demo.ts | tail -3)

echo "── 4/5 · Gimnasio en operación"
(cd "$HERE" && pnpm -s exec tsx scripts/seed-presentacion.ts)

echo "── 5/5 · Jobs diarios (adeudos vencidos, estados de membresía)"
(cd "$HERE" && pnpm -s exec tsx src/platform/jobs/run-daily.ts | tail -12)

echo
echo "Base ${BASE_PRUEBAS} lista. Para usarla:  pnpm dev:pruebas"
