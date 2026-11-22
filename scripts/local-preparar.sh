#!/usr/bin/env bash
# Prepara la BASE DE TRABAJO local (gymflow_local): la que se usa de verdad,
# empezando por dar de alta el primer gimnasio desde la consola de plataforma.
#
# No trae gimnasios, socios ni cuentas: solo el esquema y el catálogo del
# sistema (permisos, puestos y ejercicios). Es seguro repetirlo: crea lo que
# falta y aplica las migraciones pendientes; NUNCA borra datos.
#
# El uso real se abre con su PROPIA contraseña (auditoría 8, fase 0.1): la de
# desarrollo (gymflow_app_dev) está publicada en el repositorio y la comparten
# las bases de pruebas. Aquí se crea, una vez, el rol gymflow_local_app (mismos
# permisos que gymflow_app, sin ser dueño de nada) con una contraseña al azar
# guardada FUERA de los repositorios, en ~/.gymflow/uso-real.env, y la base
# deja de aceptar conexiones de los roles de desarrollo de la aplicación.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DBREPO="$HERE/../gymflow-db"
BASE="${GYMFLOW_LOCAL_DB:-gymflow_local}"
ADMIN_URL="${PGADMIN_URL:-postgresql://postgres@localhost/postgres?host=/tmp}"
OWNER_PW="${GYMFLOW_OWNER_PASSWORD:-gymflow_owner_dev}"
APP_PW="${GYMFLOW_APP_PASSWORD:-gymflow_app_dev}"
SECRETOS="${GYMFLOW_SECRETOS:-$HOME/.gymflow/uso-real.env}"
# El rol propio solo para la base del uso real (o para ensayarlo en una desechable).
ROL="${GYMFLOW_LOCAL_ROLE:-}"
[ "$BASE" = gymflow_local ] && ROL="${ROL:-gymflow_local_app}"
export DATABASE_URL="postgresql://gymflow_app:${APP_PW}@127.0.0.1:5432/${BASE}?schema=public"
export DATABASE_URL_MIGRATOR="postgresql://gymflow_owner:${OWNER_PW}@127.0.0.1:5432/${BASE}?schema=public"

echo "── 1/4 · Base ${BASE}"
(cd "$DBREPO" && GYMFLOW_DB="$BASE" PGADMIN_URL="$ADMIN_URL" node scripts/bootstrap-db.mjs | grep -E "^base" || true)

echo "── 2/4 · Contraseña propia"
if [ -n "$ROL" ]; then
  if ! grep -q '^GYMFLOW_LOCAL_DB_PASSWORD=.' "$SECRETOS" 2>/dev/null; then
    mkdir -p "$(dirname "$SECRETOS")"
    chmod 700 "$(dirname "$SECRETOS")"
    CLAVE_NUEVA=$(node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))")
    ( umask 077
      printf '%s\n' "# Secretos del USO REAL de GymFlow (${BASE}). Fuera de los repositorios: no se comitea." \
        "# Sin este archivo el uso real no arranca. Respáldalo junto con la llave de los datos sensibles." \
        "GYMFLOW_LOCAL_DB_PASSWORD=${CLAVE_NUEVA}" >> "$SECRETOS" )
    echo "  contraseña nueva guardada en $SECRETOS"
  fi
  chmod 600 "$SECRETOS"
  CLAVE=$(sed -n 's/^GYMFLOW_LOCAL_DB_PASSWORD=//p' "$SECRETOS" | tail -1)
  (cd "$DBREPO" && CLAVE="$CLAVE" node -e "
    const pg = require('pg');
    const [admin, base, rol] = process.argv.slice(1);
    const id = (s) => { if (!/^[a-z_][a-z0-9_]*\$/.test(s)) throw new Error('nombre inválido: ' + s); return s; };
    const lit = (s) => \"'\" + s.replace(/'/g, \"''\") + \"'\";
    (async () => {
      const c = new pg.Client({ connectionString: admin });
      await c.connect();
      const ya = (await c.query('select 1 from pg_roles where rolname = \$1', [rol])).rowCount > 0;
      // Con los permisos de gymflow_app (las migraciones se los dan a él) y sin ser dueño de nada.
      await c.query((ya ? 'ALTER' : 'CREATE') + ' ROLE ' + id(rol) + ' LOGIN INHERIT PASSWORD ' + lit(process.env.CLAVE));
      await c.query('GRANT gymflow_app TO ' + id(rol));
      // La base del uso real ya no acepta a los roles de desarrollo de la aplicación.
      await c.query('REVOKE CONNECT ON DATABASE ' + id(base) + ' FROM PUBLIC');
      await c.query('GRANT CONNECT ON DATABASE ' + id(base) + ' TO ' + id(rol));
      await c.end();
      console.log('  rol ' + rol + ': ' + (ya ? 'contraseña al día' : 'creado') + '; ' + base + ' solo acepta ese rol y al dueño');
    })().catch((e) => { console.error('  ' + e.message); process.exit(1); });
  " "$ADMIN_URL" "$BASE" "$ROL")
  export DATABASE_URL="postgresql://${ROL}:${CLAVE}@127.0.0.1:5432/${BASE}?schema=public"
else
  echo "  (solo para gymflow_local; ${BASE} sigue con la de desarrollo)"
fi

echo "── 3/4 · Migraciones"
(cd "$DBREPO" && pnpm -s exec prisma migrate deploy 2>&1 | tail -1)
echo "── 4/4 · Catálogo del sistema (permisos, puestos y ejercicios)"
(cd "$DBREPO" && pnpm -s exec tsx src/seed.ts >/dev/null && echo "listo")

CUENTAS=$(cd "$DBREPO" && DATABASE_URL="$DATABASE_URL" node -e "
  const pg = require('pg');
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  c.connect().then(() => c.query('select count(*)::int n from users where \"organizationId\" is null and \"deletedAt\" is null')).then((r) => { console.log(r.rows[0].n); return c.end(); });
")
echo
if [ "$CUENTAS" = "0" ]; then
  echo "Falta la cuenta de plataforma. Créala con:"
  echo "  cd ~/gymflow-backend && pnpm plataforma:alta tu@correo.com \"Tu nombre\""
else
  echo "Base ${BASE} lista (${CUENTAS} cuenta(s) de plataforma)."
fi
