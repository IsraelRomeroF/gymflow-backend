import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7, normalizedNameKey } from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

async function crearSocio(orgId: string, branchId: string, sufijo: string) {
  const db = getDb();
  return db.member.create({
    data: {
      id: uuidv7(), organizationId: orgId, memberCode: `TST-${sufijo}`,
      homeBranchId: branchId, firstName: 'Prueba', lastName: `Motor${sufijo}`,
      nameKey: normalizedNameKey(`Prueba Motor${sufijo}`), joinedAt: new Date(),
    },
  });
}

describe('motor de membresías', () => {
  let app: FastifyInstance;
  let cookie: string;
  let orgId: string;
  let branchCen: string;
  let planMensual: string;
  let planMulti: string;
  let planVisitas: string;
  let n = 0;
  const socios: string[] = [];

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    cookie = await loginAs(app, 'gerencia@demo.mx');
    const { demo } = await orgFixtures();
    orgId = demo.id;

    const branches = (await app.inject({ method: 'GET', url: '/branches', headers: { cookie } })).json();
    branchCen = branches.find((b: { code: string }) => b.code === 'CEN').id;

    const plans = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie } })).json();
    planMensual = plans.find((p: { code: string }) => p.code === 'MEN').id;
    planMulti = plans.find((p: { code: string }) => p.code === 'MULTI').id;
    planVisitas = plans.find((p: { code: string }) => p.code === 'V10').id;
  });

  afterAll(async () => {
    const db = getDb();
    if (socios.length) {
      await db.membershipEvent.deleteMany({ where: { membership: { memberId: { in: socios } } } }).catch(() => undefined);
      await db.member.updateMany({ where: { id: { in: socios } }, data: { deletedAt: new Date(), status: 'ARCHIVED' } });
    }
    await app.close();
    await closeDb();
  });

  const nuevoSocio = async () => {
    const m = await crearSocio(orgId, branchCen, `${Date.now()}${n++}`.slice(-9));
    socios.push(m.id);
    return m.id;
  };

  const alta = async (memberId: string, planId = planMensual, body: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST', url: `/members/${memberId}/memberships`, headers: { cookie },
      payload: { reason: 'Fixture de prueba', planId, soldAtBranchId: branchCen, ...body },
    });

  // ── Ciclo de vida ─────────────────────────────────────────────────────────

  it('el alta nace en PENDING y NO otorga acceso hasta pagar', async () => {
    const memberId = await nuevoSocio();
    const res = await alta(memberId);
    expect(res.statusCode).toBe(201);
    const m = res.json();
    expect(m.status).toBe('PENDING');
    expect(m.grantsAccess).toBe(false);
    expect(m.billingAnchorDay).toBeGreaterThanOrEqual(1);
  });

  it('activar otorga acceso', async () => {
    const memberId = await nuevoSocio();
    const created = (await alta(memberId)).json();
    const res = await app.inject({ method: 'POST', url: `/memberships/${created.id}/activate`, headers: { cookie }, payload: { reason: 'Fixture de prueba' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
    expect(res.json().grantsAccess).toBe(true);
  });

  it('CONSTRAINT CRÍTICA: un socio no puede tener dos membresías vigentes', async () => {
    const memberId = await nuevoSocio();
    expect((await alta(memberId)).statusCode).toBe(201);

    // Por servicio: mensaje explicativo.
    const segunda = await alta(memberId, planMulti);
    expect(segunda.statusCode).toBe(409);
    expect(segunda.json().message).toContain('vigente');

    // Y saltándose el servicio, la BASE también lo impide.
    const db = getDb();
    await expect(db.membership.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId, planId: planMulti,
        status: 'ACTIVE', startDate: new Date(), currentPeriodStart: new Date(),
        currentPeriodEnd: addDays(new Date(), 30), billingAnchorDay: 1,
      },
    })).rejects.toThrow();
  });

  it('una membresía CANCELADA libera el hueco para una nueva', async () => {
    const memberId = await nuevoSocio();
    const primera = (await alta(memberId)).json();
    const cancel = await app.inject({
      method: 'POST', url: `/memberships/${primera.id}/cancel`, headers: { cookie },
      payload: { reason: 'Se mudó de ciudad' },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe('CANCELED');

    expect((await alta(memberId, planMulti)).statusCode).toBe(201);
  });

  it('cancelar EXIGE motivo', async () => {
    const memberId = await nuevoSocio();
    const m = (await alta(memberId)).json();
    const res = await app.inject({
      method: 'POST', url: `/memberships/${m.id}/cancel`, headers: { cookie }, payload: { reason: '' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rechaza una transición imposible con 409, no con 500', async () => {
    const memberId = await nuevoSocio();
    const m = (await alta(memberId)).json();
    // PENDING no se puede congelar: primero hay que activarla.
    const res = await app.inject({
      method: 'POST', url: `/memberships/${m.id}/freeze`, headers: { cookie },
      payload: { days: 10, reason: 'Viaje' },
    });
    expect(res.statusCode).toBe(409);
  });

  // ── Congelamiento ─────────────────────────────────────────────────────────

  it('FROZEN no da acceso, y al reactivar EXTIENDE el periodo', async () => {
    const memberId = await nuevoSocio();
    const created = (await alta(memberId)).json();
    await app.inject({ method: 'POST', url: `/memberships/${created.id}/activate`, headers: { cookie }, payload: { reason: 'Fixture de prueba' } });

    const antes = (await app.inject({ method: 'GET', url: `/memberships/${created.id}`, headers: { cookie } })).json();

    const frozen = await app.inject({
      method: 'POST', url: `/memberships/${created.id}/freeze`, headers: { cookie },
      payload: { days: 10, reason: 'Lesión de rodilla' },
    });
    expect(frozen.statusCode).toBe(200);
    expect(frozen.json().status).toBe('FROZEN');
    expect(frozen.json().grantsAccess).toBe(false);
    expect(frozen.json().frozenDaysUsedThisYear).toBe(10);

    const unfrozen = await app.inject({ method: 'POST', url: `/memberships/${created.id}/unfreeze`, headers: { cookie } });
    expect(unfrozen.json().status).toBe('ACTIVE');
    // Reactivado el mismo día: 0 días efectivos pausados, así que el periodo
    // no se mueve. Lo importante es que NO se acorta.
    expect(unfrozen.json().currentPeriodEnd >= antes.currentPeriodEnd).toBe(true);
  });

  it('congelar EXIGE motivo y respeta el mínimo del plan', async () => {
    const memberId = await nuevoSocio();
    const created = (await alta(memberId)).json();
    await app.inject({ method: 'POST', url: `/memberships/${created.id}/activate`, headers: { cookie }, payload: { reason: 'Fixture de prueba' } });

    const sinMotivo = await app.inject({
      method: 'POST', url: `/memberships/${created.id}/freeze`, headers: { cookie },
      payload: { days: 10, reason: '' },
    });
    expect(sinMotivo.statusCode).toBe(422);

    const muyCorto = await app.inject({
      method: 'POST', url: `/memberships/${created.id}/freeze`, headers: { cookie },
      payload: { days: 2, reason: 'Viaje corto' },
    });
    expect(muyCorto.statusCode).toBe(422);
    expect(muyCorto.json().message).toContain('mínimo');
  });

  it('el cupo anual de congelamiento se agota', async () => {
    const memberId = await nuevoSocio();
    const created = (await alta(memberId)).json();
    await app.inject({ method: 'POST', url: `/memberships/${created.id}/activate`, headers: { cookie }, payload: { reason: 'Fixture de prueba' } });

    await app.inject({
      method: 'POST', url: `/memberships/${created.id}/freeze`, headers: { cookie },
      payload: { days: 30, reason: 'Primer congelamiento' },
    });
    await app.inject({ method: 'POST', url: `/memberships/${created.id}/unfreeze`, headers: { cookie } });

    const segundo = await app.inject({
      method: 'POST', url: `/memberships/${created.id}/freeze`, headers: { cookie },
      payload: { days: 10, reason: 'Segundo congelamiento' },
    });
    expect(segundo.statusCode).toBe(422);
    expect(segundo.json().message).toContain('quedan');
  });

  // ── Cambio de plan ────────────────────────────────────────────────────────

  it('cambio de plan devuelve prorrateo por DÍAS REALES y conserva el ancla', async () => {
    const memberId = await nuevoSocio();
    const created = (await alta(memberId, planMensual, { billingAnchorDay: 31 })).json();
    await app.inject({ method: 'POST', url: `/memberships/${created.id}/activate`, headers: { cookie }, payload: { reason: 'Fixture de prueba' } });

    const res = await app.inject({
      method: 'POST', url: `/memberships/${created.id}/change-plan`, headers: { cookie },
      payload: { planId: planMulti, reason: 'El socio quiere acceso multisede' },
    });
    expect(res.statusCode).toBe(200);
    const { membership, proration } = res.json();
    expect(membership.planId).toBe(planMulti);
    expect(membership.billingAnchorDay).toBe(31); // el ancla NO se pierde
    // La invariante que importa: las partes suman el ciclo exacto, sin
    // días huérfanos ni contados dos veces.
    expect(proration.usedDays + proration.remainingDays).toBe(proration.cycleDays);
    expect(proration.cycleDays).toBeGreaterThan(0);
  });

  it('con ancla propia, el PRIMER periodo se alarga para alinearse al día de corte', async () => {
    const memberId = await nuevoSocio();
    // Alta hoy con corte el día 5: el primer ciclo llega hasta el próximo
    // día 5, así que dura más (o menos) de un mes. Es deliberado: alinea al
    // socio con la fecha de corte pactada desde el primer periodo.
    const created = (await alta(memberId, planMensual, { billingAnchorDay: 5 })).json();
    expect(created.billingAnchorDay).toBe(5);
    expect(created.currentPeriodEnd.slice(-2)).toBe('05');

    // A partir del SEGUNDO ciclo, la duración ya es la del plan.
    await app.inject({ method: 'POST', url: `/memberships/${created.id}/activate`, headers: { cookie }, payload: { reason: 'Fixture de prueba' } });
    const renovada = (await app.inject({
      method: 'POST', url: `/memberships/${created.id}/renew`, headers: { cookie }, payload: { reason: 'Fixture de prueba' },
    })).json();
    expect(renovada.currentPeriodStart).toBe(created.currentPeriodEnd); // contiguos
    expect(renovada.currentPeriodEnd.slice(-2)).toBe('05');
  });

  it('cambiar al MISMO plan se rechaza', async () => {
    const memberId = await nuevoSocio();
    const created = (await alta(memberId)).json();
    await app.inject({ method: 'POST', url: `/memberships/${created.id}/activate`, headers: { cookie }, payload: { reason: 'Fixture de prueba' } });
    const res = await app.inject({
      method: 'POST', url: `/memberships/${created.id}/change-plan`, headers: { cookie },
      payload: { planId: planMensual, reason: 'Sin cambio' },
    });
    expect(res.statusCode).toBe(422);
  });

  // ── Terminales y reactivación ─────────────────────────────────────────────

  it('reactivar crea una membresía NUEVA y la antigüedad del socio NO cambia', async () => {
    const db = getDb();
    const memberId = await nuevoSocio();
    const antiguedadOriginal = (await db.member.findUniqueOrThrow({ where: { id: memberId } })).joinedAt;

    const primera = (await alta(memberId)).json();
    await app.inject({
      method: 'POST', url: `/memberships/${primera.id}/cancel`, headers: { cookie },
      payload: { reason: 'Baja temporal' },
    });

    const res = await app.inject({
      method: 'POST', url: `/memberships/${primera.id}/reactivate`, headers: { cookie },
      payload: { reason: 'Fixture de prueba', planId: planMulti },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).not.toBe(primera.id); // es OTRA membresía

    const despues = await db.member.findUniqueOrThrow({ where: { id: memberId } });
    expect(despues.joinedAt.getTime()).toBe(antiguedadOriginal.getTime());

    const historial = (await app.inject({
      method: 'GET', url: `/members/${memberId}/memberships`, headers: { cookie },
    })).json();
    expect(historial).toHaveLength(2);
  });

  it('cada transición deja un evento en la historia del contrato', async () => {
    const memberId = await nuevoSocio();
    const created = (await alta(memberId)).json();
    await app.inject({ method: 'POST', url: `/memberships/${created.id}/activate`, headers: { cookie }, payload: { reason: 'Fixture de prueba' } });
    await app.inject({
      method: 'POST', url: `/memberships/${created.id}/cancel`, headers: { cookie },
      payload: { reason: 'Prueba de historial' },
    });

    const eventos = (await app.inject({
      method: 'GET', url: `/memberships/${created.id}/events`, headers: { cookie },
    })).json();
    const tipos = eventos.map((e: { eventType: string }) => e.eventType);
    expect(tipos).toContain('ACTIVATED');
    expect(tipos).toContain('CANCELED');
    const cancelEvent = eventos.find((e: { eventType: string }) => e.eventType === 'CANCELED');
    expect(cancelEvent.reason).toBe('Prueba de historial');
  });

  it('la bitácora de transiciones es APPEND-ONLY', async () => {
    const db = getDb();
    const evento = await db.membershipEvent.findFirst();
    expect(evento).toBeTruthy();
    await expect(db.membershipEvent.update({
      where: { id: evento!.id }, data: { reason: 'reescrito' },
    })).rejects.toThrow();
  });

  // ── Paquetes de visitas ───────────────────────────────────────────────────

  it('vender un paquete crea el asiento de compra y su saldo', async () => {
    const memberId = await nuevoSocio();
    const res = await app.inject({
      method: 'POST', url: `/members/${memberId}/visit-packs`, headers: { cookie },
      payload: { planId: planVisitas, soldAtBranchId: branchCen, saleKey: crypto.randomUUID(), payment: { method: 'SPEI_TRANSFER', externalRef: 'SPEI-PAQUETE' } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().balance).toBe(10);
    expect(res.json().expiresOn).toBeTruthy();
  });

  it('consumir descuenta del LIBRO, no de un contador', async () => {
    const memberId = await nuevoSocio();
    const pack = (await app.inject({
      method: 'POST', url: `/members/${memberId}/visit-packs`, headers: { cookie },
      payload: { planId: planVisitas, soldAtBranchId: branchCen, saleKey: crypto.randomUUID(), payment: { method: 'SPEI_TRANSFER', externalRef: 'SPEI-PAQUETE' } },
    })).json();

    await app.inject({
      method: 'POST', url: `/visit-packs/${pack.id}/consume`, headers: { cookie },
      payload: { branchId: branchCen },
    });
    const detalle = (await app.inject({ method: 'GET', url: `/visit-packs/${pack.id}`, headers: { cookie } })).json();
    expect(detalle.balance).toBe(9);
    expect(detalle.entries).toHaveLength(2); // compra + consumo
    expect(detalle.entries[1].entryType).toBe('CONSUME');
    expect(detalle.entries[1].branchId).toBe(branchCen);
  });

  it('ANTI DOBLE CONSUMO: el mismo check-in no descuenta dos visitas', async () => {
    const memberId = await nuevoSocio();
    const pack = (await app.inject({
      method: 'POST', url: `/members/${memberId}/visit-packs`, headers: { cookie },
      payload: { planId: planVisitas, soldAtBranchId: branchCen, saleKey: crypto.randomUUID(), payment: { method: 'SPEI_TRANSFER', externalRef: 'SPEI-PAQUETE' } },
    })).json();

    const checkInId = uuidv7();
    const primero = await app.inject({
      method: 'POST', url: `/visit-packs/${pack.id}/consume`, headers: { cookie },
      payload: { branchId: branchCen, attendanceEventId: checkInId },
    });
    expect(primero.statusCode).toBe(201);
    expect(primero.json().balance).toBe(9);

    // Doble paso del torniquete o resincronización offline: la base lo rechaza.
    const repetido = await app.inject({
      method: 'POST', url: `/visit-packs/${pack.id}/consume`, headers: { cookie },
      payload: { branchId: branchCen, attendanceEventId: checkInId },
    });
    expect(repetido.statusCode).toBeGreaterThanOrEqual(400);

    const detalle = (await app.inject({ method: 'GET', url: `/visit-packs/${pack.id}`, headers: { cookie } })).json();
    expect(detalle.balance).toBe(9); // sigue en 9, no en 8
  });

  it('al agotarse pasa a EXHAUSTED y ya no se puede consumir', async () => {
    const memberId = await nuevoSocio();
    const pack = (await app.inject({
      method: 'POST', url: `/members/${memberId}/visit-packs`, headers: { cookie },
      payload: { planId: planVisitas, soldAtBranchId: branchCen, saleKey: crypto.randomUUID(), payment: { method: 'SPEI_TRANSFER', externalRef: 'SPEI-PAQUETE' } },
    })).json();

    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: 'POST', url: `/visit-packs/${pack.id}/consume`, headers: { cookie },
        payload: { branchId: branchCen },
      });
    }
    const detalle = (await app.inject({ method: 'GET', url: `/visit-packs/${pack.id}`, headers: { cookie } })).json();
    expect(detalle.balance).toBe(0);
    expect(detalle.status).toBe('EXHAUSTED');

    const extra = await app.inject({
      method: 'POST', url: `/visit-packs/${pack.id}/consume`, headers: { cookie },
      payload: { branchId: branchCen },
    });
    expect(extra.statusCode).toBe(422);
  });

  it('ajustar visitas exige motivo Y aprobación de un segundo', async () => {
    const memberId = await nuevoSocio();
    const pack = (await app.inject({
      method: 'POST', url: `/members/${memberId}/visit-packs`, headers: { cookie },
      payload: { planId: planVisitas, soldAtBranchId: branchCen, saleKey: crypto.randomUUID(), payment: { method: 'SPEI_TRANSFER', externalRef: 'SPEI-PAQUETE' } },
    })).json();

    const sinAprobacion = await app.inject({
      method: 'POST', url: `/visit-packs/${pack.id}/adjust`, headers: { cookie },
      payload: { delta: 2, reason: 'Cortesía por avería del equipo' },
    });
    expect(sinAprobacion.statusCode).toBe(428); // REQUIRE_APPROVAL

    const conAprobacion = await app.inject({
      method: 'POST', url: `/visit-packs/${pack.id}/adjust`, headers: { cookie },
      payload: { delta: 2, reason: 'Cortesía por avería del equipo', approvalToken: await aprobacion(app, cookie, 'memberships:visitpack:adjust', undefined, undefined, { resourceId: pack.id }) },
    });
    expect(conAprobacion.statusCode).toBe(201);
    expect(conAprobacion.json().balance).toBe(12);
  });

  it('el libro de visitas es APPEND-ONLY: un consumo se compensa, no se borra', async () => {
    const db = getDb();
    const entry = await db.visitLedgerEntry.findFirst({ where: { entryType: 'CONSUME' } });
    expect(entry).toBeTruthy();
    await expect(db.visitLedgerEntry.update({ where: { id: entry!.id }, data: { delta: 0 } })).rejects.toThrow();
    await expect(db.visitLedgerEntry.delete({ where: { id: entry!.id } })).rejects.toThrow();
  });
});

describe('jobs diarios del motor', () => {
  let app: FastifyInstance;
  let orgId: string;
  const socios: string[] = [];

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    const { demo } = await orgFixtures();
    orgId = demo.id;
  });
  afterAll(async () => {
    const db = getDb();
    if (socios.length) {
      await db.member.updateMany({ where: { id: { in: socios } }, data: { deletedAt: new Date(), status: 'ARCHIVED' } });
    }
    await app.close();
    await closeDb();
  });

  /** Crea una membresía directamente en el estado y fechas que hace falta probar. */
  async function sembrar(status: string, overrides: Record<string, unknown> = {}) {
    const db = getDb();
    const branch = await db.branch.findFirstOrThrow({ where: { organizationId: orgId, code: 'CEN' } });
    const plan = await db.plan.findFirstOrThrow({ where: { organizationId: orgId, code: 'MEN' } });
    const sufijo = `${Date.now()}${socios.length}`.slice(-9);
    const member = await crearSocio(orgId, branch.id, sufijo);
    socios.push(member.id);
    const ayer = addDays(new Date(), -1);
    const membership = await db.membership.create({
      data: {
        id: uuidv7(), organizationId: orgId, memberId: member.id, planId: plan.id,
        soldAtBranchId: branch.id, status: status as never,
        startDate: addDays(new Date(), -40),
        currentPeriodStart: addDays(new Date(), -40),
        currentPeriodEnd: ayer,
        // El ancla es el día en que termina el periodo, como la fija el alta.
        // Con ancla 1 y fin el 30, el 1.º de mes salía un periodo de un día.
        billingAnchorDay: ((overrides.currentPeriodEnd as Date | undefined) ?? ayer).getUTCDate(), autoRenew: true,
        ...overrides,
      },
    });
    return { member, membership };
  }

  it('AUTORRENOVACIÓN: al vencer el periodo pasa al siguiente y emite su cuota', async () => {
    const { membership } = await sembrar('ACTIVE');
    const { rollPeriods } = await import('../src/modules/billing/billing.jobs.js');
    const res = await rollPeriods(orgId);
    expect(res.errors.filter((e) => e.entityId === membership.id)).toEqual([]);

    const db = getDb();
    const after = await db.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(after.status).toBe('ACTIVE');
    // El periodo nuevo arranca donde terminó el anterior: sin huecos.
    expect(iso(after.currentPeriodStart)).toBe(iso(membership.currentPeriodEnd));
    const cuota = await db.charge.findFirst({
      where: { membershipId: membership.id, chargeType: 'MEMBERSHIP_PERIOD', periodStart: after.currentPeriodStart },
    });
    expect(cuota).toBeTruthy();
  });

  it('la mora la dispara la CUOTA vencida, y la membresía SIGUE dando acceso', async () => {
    // Hace 3 días y no "ayer": de noche en México, el ayer de UTC es hoy.
    const { membership } = await sembrar('ACTIVE', {
      currentPeriodStart: addDays(new Date(), -33), currentPeriodEnd: addDays(new Date(), -3),
    });
    const { rollPeriods, markMembershipsPastDue } = await import('../src/modules/billing/billing.jobs.js');
    await rollPeriods(orgId);
    // La cuota nueva venció ayer (arranque del periodo) y nadie la pagó.
    const res = await markMembershipsPastDue(orgId);
    expect(res.errors.filter((e) => e.entityId === membership.id)).toEqual([]);

    const db = getDb();
    const after = await db.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(after.status).toBe('PAST_DUE');
    expect(after.graceUntil).toBeTruthy(); // se fijó la gracia
  });

  it('SIN deuda no hay mora: un periodo vencido ya NO basta', async () => {
    // Periodo en curso, sin cargos pendientes: antes bastaba con la fecha.
    const { membership } = await sembrar('ACTIVE', { currentPeriodEnd: addDays(new Date(), 10) });
    const { markMembershipsPastDue } = await import('../src/modules/billing/billing.jobs.js');
    await markMembershipsPastDue(orgId);
    const after = await getDb().membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(after.status).toBe('ACTIVE');
  });

  it('una membresía atrasada DOS periodos se pone al día con una cuota por periodo', async () => {
    const { membership } = await sembrar('ACTIVE', {
      startDate: addDays(new Date(), -75), currentPeriodStart: addDays(new Date(), -75),
      currentPeriodEnd: addDays(new Date(), -45),
    });
    const { rollPeriods } = await import('../src/modules/billing/billing.jobs.js');
    await rollPeriods(orgId);
    const db = getDb();
    const after = await db.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(after.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() - 86_400_000);
    const cuotas = await db.charge.count({ where: { membershipId: membership.id, chargeType: 'MEMBERSHIP_PERIOD' } });
    expect(cuotas).toBe(2);
  });

  it('SUSPENDED NO extiende el periodo (contraste con FROZEN)', async () => {
    // La gracia SIEMPRE es posterior al corte que la origina; la base lo
    // impone con un CHECK, así que los datos de prueba también lo cumplen.
    const { membership } = await sembrar('PAST_DUE', {
      currentPeriodEnd: addDays(new Date(), -8),
      graceUntil: addDays(new Date(), -2),
    });
    const db = getDb();
    const antes = await db.membership.findUniqueOrThrow({ where: { id: membership.id } });

    const { suspendExpiredGrace } = await import('../src/modules/memberships/membership.jobs.js');
    await suspendExpiredGrace(orgId);

    const despues = await db.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(despues.status).toBe('SUSPENDED');
    // El socio PERDIÓ esos días: el periodo es idéntico.
    expect(iso(despues.currentPeriodEnd)).toBe(iso(antes.currentPeriodEnd));
  });

  it('el descongelamiento programado SÍ extiende el periodo', async () => {
    const hace5 = addDays(new Date(), -5);
    const { membership } = await sembrar('FROZEN', {
      frozenSince: hace5, frozenUntil: addDays(new Date(), -1),
      currentPeriodEnd: addDays(new Date(), 10),
    });
    const db = getDb();
    const antes = await db.membership.findUniqueOrThrow({ where: { id: membership.id } });

    const { unfreezeScheduled } = await import('../src/modules/memberships/membership.jobs.js');
    await unfreezeScheduled(orgId);

    const despues = await db.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(despues.status).toBe('ACTIVE');
    expect(despues.currentPeriodEnd.getTime()).toBeGreaterThan(antes.currentPeriodEnd.getTime());
    expect(despues.frozenSince).toBeNull();
  });

  it('un prepago SIN autorrenovación EXPIRA, no entra en mora', async () => {
    const { membership } = await sembrar('ACTIVE', { autoRenew: false });
    const { expireMemberships } = await import('../src/modules/memberships/membership.jobs.js');
    await expireMemberships(orgId);

    const db = getDb();
    const after = await db.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(after.status).toBe('EXPIRED');
  });

  it('LOS JOBS SON IDEMPOTENTES: correrlos dos veces no duplica efectos', async () => {
    const { membership } = await sembrar('ACTIVE');
    const { rollPeriods, markMembershipsPastDue } = await import('../src/modules/billing/billing.jobs.js');
    const db = getDb();

    await rollPeriods(orgId);
    await markMembershipsPastDue(orgId);
    const eventosTras1 = await db.membershipEvent.count({ where: { membershipId: membership.id } });
    const cargosTras1 = await db.charge.count({ where: { membershipId: membership.id } });

    await rollPeriods(orgId);
    await markMembershipsPastDue(orgId);
    // La segunda ejecución ya no encuentra nada que avanzar ni que marcar.
    expect(await db.membershipEvent.count({ where: { membershipId: membership.id } })).toBe(eventosTras1);
    expect(await db.charge.count({ where: { membershipId: membership.id } })).toBe(cargosTras1);
  });

  it('el job DRENA la cola: no se detiene en el primer lote', async () => {
    const db = getDb();
    const branch = await db.branch.findFirstOrThrow({ where: { organizationId: orgId, code: 'CEN' } });
    const plan = await db.plan.findFirstOrThrow({ where: { organizationId: orgId, code: 'MEN' } });

    // Más candidatos que el tamaño de lote (500). Sin drenado, un job diario
    // limitado a un lote nunca se pondría al corriente.
    const CANDIDATOS = 520;
    const nuevos = Array.from({ length: CANDIDATOS }, (_, i) => ({
      id: uuidv7(), organizationId: orgId,
      memberCode: `DRN-${Date.now() % 100000}-${i}`,
      homeBranchId: branch.id, firstName: 'Drenado', lastName: `Lote${i}`,
      nameKey: normalizedNameKey(`Drenado Lote${i}`), joinedAt: new Date(),
    }));
    await db.member.createMany({ data: nuevos as never });
    socios.push(...nuevos.map((m) => m.id));

    const ayer = addDays(new Date(), -1);
    await db.membership.createMany({
      data: nuevos.map((m) => ({
        id: uuidv7(), organizationId: orgId, memberId: m.id, planId: plan.id,
        soldAtBranchId: branch.id, status: 'ACTIVE' as never,
        startDate: addDays(new Date(), -40), currentPeriodStart: addDays(new Date(), -40),
        currentPeriodEnd: ayer, billingAnchorDay: 1, autoRenew: true,
      })) as never,
    });

    const { rollPeriods } = await import('../src/modules/billing/billing.jobs.js');
    const res = await rollPeriods(orgId);

    expect(res.processed).toBeGreaterThanOrEqual(CANDIDATOS);
    expect(res.batches).toBeGreaterThan(1); // hizo falta más de un lote
    expect(res.truncated).toBe(false);

    // Y la segunda pasada no hace nada: idempotencia a escala.
    const segunda = await rollPeriods(orgId);
    expect(segunda.processed).toBe(0);
    // Es una prueba de volumen (520 periodos avanzados, cada uno en su unidad de dinero): en la suite
    // completa, con los demás archivos corriendo a la vez, pasó de los 60 s generales tres veces.
  }, 180_000);

  it('la caducidad de un paquete deja ASIENTO de las visitas perdidas', async () => {
    const db = getDb();
    const branch = await db.branch.findFirstOrThrow({ where: { organizationId: orgId, code: 'CEN' } });
    const member = await crearSocio(orgId, branch.id, `exp${Date.now()}`.slice(-9));
    socios.push(member.id);

    const packId = uuidv7();
    await db.visitPack.create({
      data: {
        id: packId, organizationId: orgId, memberId: member.id, visitsPurchased: 10,
        purchasedOn: addDays(new Date(), -100), expiresOn: addDays(new Date(), -1), status: 'ACTIVE',
      },
    });
    await db.visitLedgerEntry.create({
      data: {
        id: uuidv7(), organizationId: orgId, visitPackId: packId,
        entryType: 'PURCHASE', delta: 10, businessDate: addDays(new Date(), -100),
      },
    });

    const { expireVisitPacks } = await import('../src/modules/memberships/membership.jobs.js');
    const res = await expireVisitPacks(orgId);
    expect(res.processed).toBeGreaterThan(0);

    const pack = await db.visitPack.findUniqueOrThrow({ where: { id: packId } });
    expect(pack.status).toBe('EXPIRED');
    expect(pack.expiredAt).toBeTruthy(); // la caducidad es un EVENTO con fecha

    const entries = await db.visitLedgerEntry.findMany({ where: { visitPackId: packId } });
    const expiry = entries.find((e) => e.entryType === 'EXPIRE');
    expect(expiry).toBeTruthy();
    expect(expiry!.delta).toBe(-10); // queda constancia de cuánto se perdió
    expect(entries.reduce((a, e) => a + e.delta, 0)).toBe(0);
  });
});

describe('privilegios de las tablas nuevas (anti-regresión)', () => {
  afterAll(async () => { await closeDb(); });

  it('gymflow_app no puede modificar ni borrar el libro de visitas ni la historia del contrato', async () => {
    const db = getDb();
    for (const table of ['visit_ledger_entries', 'membership_events']) {
      const rows = await db.$queryRawUnsafe<Array<{ privilege_type: string }>>(
        `SELECT privilege_type FROM information_schema.table_privileges
         WHERE grantee = 'gymflow_app' AND table_name = '${table}'`,
      );
      expect(rows.map((r) => r.privilege_type).sort(), table).toEqual(['INSERT', 'SELECT']);
    }
  });
});
