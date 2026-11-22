import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { ALL_SECTIONS_UNLOCKED, MODULES, ROLES, normalizedNameKey, uuidv7 } from '@gymflow/core';
import { getDb } from '../src/platform/db/client.js';
import { ModuleStateRepository } from '../src/platform/modules/module-state.repository.js';
import { forgetModules } from '../src/platform/modules/module-state.js';
import { PASSWORD, loginAs, nombreUnico, publicarTextosDePrueba } from './helpers.js';

/**
 * UN GIMNASIO PROPIO PARA UN ARCHIVO DE PRUEBAS (bloque 1.17b).
 *
 * Las pruebas de reloj, de concurrencia y de jobs necesitan un gimnasio que
 * nadie más toque: fijan la fecha en el pasado, abren y cierran cajas, corren
 * el cierre diario de verdad. En el Gimnasio Demo eso movería las cuentas de
 * los demás archivos (y las de ellos, las de estas).
 *
 * DEJA DATOS, Y SE DECLARA: cada llamada crea un gimnasio nuevo («Propio …»)
 * que se queda en la base, porque los cobros y los cargos no se pueden borrar
 * ni con el rol dueño (el libro es de solo agregar). Lo que deja no lo ve
 * ningún otro archivo: todo cuelga de su `organizationId`. Las sedes se
 * archivan al terminar (`cerrar()`) para liberar su prefijo de socio.
 */
export type SedePropia = { id: string; code: string; name: string; timezone: string | null; cajas: string[] };

export type GimnasioPropio = {
  organizationId: string;
  sedes: SedePropia[];
  /** Correos de las cuentas (contraseña: la de siempre). El gerente es de todo el gimnasio; recepción, de la primera sede. */
  correos: { owner: string; gerente: string; gerente2: string; recepcion: string };
  ownerId: string;
  /** Plan mensual domiciliable de $600, se vende en todas las sedes. */
  planMensual: string;
  /** Archiva las sedes (libera su prefijo). Los turnos abiertos se cortan cuadrados en la base. */
  cerrar(): Promise<void>;
};

const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const letras = (n: number) => { const hex = randomUUID().replace(/-/g, ''); return Array.from({ length: n }, (_, i) => LETRAS[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 26]).join(''); };

export async function gimnasioPropio(opciones: {
  /** Zona del gimnasio (por omisión, la de la Ciudad de México). */
  zona?: string;
  /** Sedes: por omisión una, con dos cajas. `zona: null` hereda la del gimnasio. */
  sedes?: Array<{ name: string; zona?: string | null; cajas?: number }>;
} = {}): Promise<GimnasioPropio> {
  const db = getDb();
  const o = uuidv7();
  const marca = `Propio ${letras(8)}`;
  await db.organization.create({ data: { id: o, legalName: `${marca} S.A.`, tradeName: marca, ...(opciones.zona ? { timezone: opciones.zona } : {}) } });

  // Topes por puesto, como los siembra el catálogo (ADR-039): sin ellos nadie tiene tope para nada.
  for (const def of ROLES) {
    const role = await db.role.findFirst({ where: { organizationId: null, key: def.key } });
    if (role) await db.roleLimitSet.create({ data: { id: uuidv7(), organizationId: o, roleId: role.id, ...def.limits } as never });
  }

  const sedes: SedePropia[] = [];
  for (const s of opciones.sedes ?? [{ name: 'Sede única', cajas: 2 }]) {
    let creada: { id: string; code: string } | null = null;
    for (let intento = 0; intento < 25 && !creada; intento++) {
      const code = `${letras(3)}${randomUUID().slice(0, 4).toUpperCase()}`;
      try {
        const b = await db.branch.create({ data: { id: uuidv7(), organizationId: o, code, name: s.name, timezone: s.zona ?? null } });
        creada = { id: b.id, code: b.code };
      } catch (e) {
        if (!String(e).includes('Unique constraint') && !String(e).includes('prefix')) throw e;
      }
    }
    if (!creada) throw new Error('No se encontró un prefijo de sede libre');
    const cajas: string[] = [];
    for (let i = 0; i < (s.cajas ?? 1); i++) {
      const caja = await db.cashRegister.create({ data: { id: uuidv7(), organizationId: o, branchId: creada.id, code: `C${i + 1}`, name: `Caja ${i + 1}` } });
      cajas.push(caja.id);
    }
    sedes.push({ ...creada, name: s.name, timezone: s.zona ?? null, cajas });
  }

  const cuenta = async (roleKey: string, branchId: string | null): Promise<{ id: string; email: string }> => {
    const role = await db.role.findFirstOrThrow({ where: { organizationId: null, key: roleKey } });
    const id = uuidv7();
    const email = `${nombreUnico('propio').toLowerCase()}@propio.mx`;
    await db.user.create({
      data: {
        id, organizationId: o, email, fullName: `${nombreUnico('Cuenta')} ${roleKey}`,
        passwordHash: await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
        unlockedSections: [...ALL_SECTIONS_UNLOCKED],
      },
    });
    await db.roleAssignment.create({ data: { id: uuidv7(), organizationId: o, userId: id, roleId: role.id, branchId } });
    return { id, email };
  };
  const owner = await cuenta('OWNER', null);
  const gerente = await cuenta('MANAGER', null);
  const gerente2 = await cuenta('MANAGER', null);
  const recepcion = await cuenta('RECEPTION', sedes[0]!.id);

  const planMensual = uuidv7();
  await db.plan.create({
    data: {
      id: planMensual, organizationId: o, code: 'MENSUAL', name: 'Mensual', billingModel: 'RECURRING',
      durationUnit: 'MONTH', durationValue: 1, priceCents: 60_000n, allowFreeze: true,
    },
  });
  await db.planBranchAvailability.createMany({ data: sedes.map((s) => ({ planId: planMensual, branchId: s.id, organizationId: o })) });

  await publicarTextosDePrueba(o);
  const estado = new ModuleStateRepository(o);
  for (const m of MODULES) if (m.kind === 'optional') await estado.set(m.key, true, null, null);
  forgetModules(o);

  return {
    organizationId: o, sedes, ownerId: owner.id, planMensual,
    correos: { owner: owner.email, gerente: gerente.email, gerente2: gerente2.email, recepcion: recepcion.email },
    async cerrar() {
      for (const t of await db.cashSession.findMany({ where: { organizationId: o, status: 'OPEN' } })) {
        await db.cashSession.update({
          where: { id: t.id },
          data: { status: 'CLOSED', closedAt: new Date(), closedByUserId: t.openedByUserId, countedCashCents: t.openingFloatCents, expectedCashCents: t.openingFloatCents, varianceCents: 0n },
        }).catch(() => undefined);
      }
      await db.branch.updateMany({ where: { organizationId: o }, data: { deletedAt: new Date() } });
    },
  };
}

/** Un socio del gimnasio propio, directo en la base (el alta por la API tiene sus pruebas en `members` e `intake`). */
export async function socioPropio(g: GimnasioPropio, sede: SedePropia = g.sedes[0]!): Promise<string> {
  const nombre = nombreUnico('Socio');
  const apellido = nombreUnico('Propio');
  const m = await getDb().member.create({
    data: {
      id: uuidv7(), organizationId: g.organizationId, memberCode: `${sede.code.slice(0, 3)}-${randomUUID().slice(0, 10)}`,
      firstName: nombre, lastName: apellido, nameKey: normalizedNameKey(`${nombre} ${apellido}`),
      homeBranchId: sede.id, joinedAt: new Date(),
    },
  });
  return m.id;
}

/** Un cargo abierto (no de membresía) por `centavos`, con vencimiento `vence`. */
export async function cargoPropio(g: GimnasioPropio, memberId: string, centavos: bigint, sede: SedePropia = g.sedes[0]!, vence: Date = new Date()): Promise<string> {
  const c = await getDb().charge.create({
    data: {
      id: uuidv7(), organizationId: g.organizationId, memberId, branchId: sede.id, chargeType: 'MANUAL_ADJUSTMENT', status: 'OPEN',
      concept: 'Cargo de prueba', subtotalCents: centavos, taxCents: 0n, discountCents: 0n, amountCents: centavos, dueDate: vence, issuedAt: new Date(),
    },
  });
  return c.id;
}

/** Abre un turno en una caja por la API y devuelve su id. */
export async function abrirTurno(app: FastifyInstance, cookie: string, cashRegisterId: string, fondo = '50000'): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/cash-sessions', headers: { cookie }, payload: { cashRegisterId, openingFloatCents: fondo } });
  if (r.statusCode !== 201) throw new Error(`no se abrió el turno: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

/** Las sesiones de las cuatro cuentas del gimnasio propio. */
export async function sesionesDe(app: FastifyInstance, g: GimnasioPropio): Promise<{ owner: string; gerente: string; gerente2: string; recepcion: string }> {
  return {
    owner: await loginAs(app, g.correos.owner), gerente: await loginAs(app, g.correos.gerente),
    gerente2: await loginAs(app, g.correos.gerente2), recepcion: await loginAs(app, g.correos.recepcion),
  };
}
