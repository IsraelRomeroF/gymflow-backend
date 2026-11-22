# @gymflow/backend

API de GymFlow. **Monolito modular**: un solo despliegue hoy, módulos con
frontera dura para poder extraer cualquiera a servicio propio mañana.

## La regla que sostiene todo

> Un módulo solo puede importar el `index.ts` de otro. Nunca sus archivos
> internos.

No es una convención: está **verificada por dos mecanismos independientes**.

- `eslint.config.js` la marca en el editor.
- `test/module-boundaries.test.ts` la verifica leyendo el código fuente —
  también los imports de solo-tipo, que desaparecen al compilar pero siguen
  siendo acoplamiento de diseño.

Mientras se respete, extraer un módulo a servicio es cambiar lo que hay detrás
de su puerta. En cuanto se viole una vez, deja de serlo y hay que rastrear a
mano quién depende de qué.

## Estructura

```
src/
  main.ts            arranque
  app.ts             COMPOSICIÓN: el único archivo que conoce a todos los módulos
  platform/          lo que cualquier módulo puede usar
    db/              cliente, repositorio con tenant, errores de Prisma
    http/            registro de rutas, contrato del request
    audit/           bitácora (transversal: todos escriben en ella)
    time/            fecha de negocio por sucursal
    jobs/            contrato de job y runner diario
  modules/
    identity/        personal, roles, sesiones, MFA, autorización
    organization/    organizaciones y sucursales
    members/         expediente, consentimientos, prospectos
    catalog/         planes y precio efectivo por sucursal
    memberships/     contrato socio↔plan, calendario, paquetes de visitas
    billing/         cargos, pagos, aplicación N:M, cartera
    cash/            cajas, turnos, conteo, movimientos
```

**La dependencia va siempre módulo → plataforma, nunca al revés.** Si se
invirtiera, la plataforma no podría arrancar sin todos los módulos y la
extracción de cualquiera sería imposible. Hay una prueba que lo vigila.

Cada `index.ts` documenta **qué tablas posee** el módulo y **quién consume** su
superficie pública, que es la información que hace falta el día que se extraiga.

## Las otras dos reglas verificadas

- **Solo un repositorio toca la base de datos** (control nº2 de ADR-001). Sin
  ella, el aislamiento entre gimnasios depende de recordar el `organizationId`
  en cada `where`.
- **Ninguna ruta nace sin declarar su seguridad.** `route()` lo exige y el
  arranque falla si falta. `test/tenant-isolation.test.ts` genera sus casos
  desde el registro de rutas, así que un endpoint nuevo sin cobertura rompe CI.

## Uso

```bash
pnpm install
pnpm dev            # tsx watch
pnpm verify         # typecheck + lint + 145 pruebas
pnpm jobs:daily     # runner de jobs (hasta que llegue BullMQ)
pnpm build && pnpm start
```

Depende de `@gymflow/core` y `@gymflow/db` por `file:` a repo hermano. Ambos
deben estar construidos (`pnpm build`) antes de arrancar.
