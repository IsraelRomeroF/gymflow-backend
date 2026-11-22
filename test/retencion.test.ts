import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import {
  FollowUpContact, FollowUpLatest, RetentionAlerts, RetentionSummary, diferenciasConElContrato,
} from '@gymflow/core/contracts';
import {
  makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, sedeDesechable, archivarSede, cuentaDePrueba, CONSENTIMIENTOS,
} from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

const MS_DIA = 86_400_000;

/**
 * RETENCIÓN (auditoría 8, bloque 1.15): a quién se mide, las cifras sin
 * nombres para la dueña y los contactos acotados a la sede.
 *
 * Todo ocurre en una sede propia de la prueba: la lista de Centro la llenan
 * los socios de otras corridas y aquí se cuentan filas exactas.
 */
describe('retención: reglas, cifras para la dueña y contactos por sede', () => {
  let app: FastifyInstance;
  let gerencia: string;
  let duena: string;
  let conLlave: string;
  let orgId: string;
  let cen: string;
  let sede: { id: string; code: string };
  let planId: string;
  /** El día del gimnasio con el que cuenta la API. */
  let hoy: Date;

  const socios: Record<'activo' | 'congelado' | 'sinActivar' | 'descongelado15' | 'descongelado2', string> = {
    activo: '', congelado: '', sinActivar: '', descongelado15: '', descongelado2: '',
  };
  const membresias: Record<string, string> = {};

  async function socio(clave: keyof typeof socios, opts: { activar: boolean; altaHaceDias: number }): Promise<void> {
    const alta = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: gerencia },
      payload: { firstName: nombreUnico('Ret'), lastName: nombreUnico('Encion'), phoneE164: telefonoUnico(), homeBranchId: sede.id, consents: CONSENTIMIENTOS },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const memberId = alta.json().id as string;
    const mem = await app.inject({
      method: 'POST', url: `/members/${memberId}/memberships`, headers: { cookie: gerencia },
      payload: { reason: 'Fixture de prueba', planId, soldAtBranchId: cen },
    });
    expect(mem.statusCode, mem.body).toBe(201);
    if (opts.activar) {
      const activa = await app.inject({
        method: 'POST', url: `/memberships/${mem.json().id}/activate`, headers: { cookie: gerencia }, payload: { reason: 'Fixture de prueba' },
      });
      expect(activa.statusCode, activa.body).toBe(200);
    }
    await getDb().member.update({ where: { id: memberId }, data: { joinedAt: new Date(Date.now() - opts.altaHaceDias * MS_DIA) } });
    socios[clave] = memberId;
    membresias[clave] = mem.json().id as string;
  }

  /** La membresía se descongeló hace `dias` días del gimnasio (el evento que deja el servicio o el trabajo nocturno). */
  async function descongelo(clave: keyof typeof socios, dias: number): Promise<void> {
    await getDb().membershipEvent.create({
      data: {
        id: uuidv7(), organizationId: orgId, membershipId: membresias[clave]!, eventType: 'UNFROZEN',
        fromStatus: 'FROZEN', toStatus: 'ACTIVE', at: new Date(Date.now() - dias * MS_DIA),
        businessDate: new Date(hoy.getTime() - dias * MS_DIA),
      },
    });
  }

  const lista = async (cookie = gerencia) => app.inject({ method: 'GET', url: `/retention/alerts?branchId=${sede.id}&limit=500`, headers: { cookie } });
  const cifras = async (cookie: string, q = `?branchId=${sede.id}&fresh=1`) => app.inject({ method: 'GET', url: `/retention/summary${q}`, headers: { cookie } });

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    gerencia = await loginAs(app, 'gerencia@demo.mx');
    duena = await loginAs(app, 'owner@demo.mx');
    const { demo, demoBranches } = await orgFixtures();
    orgId = demo.id;
    cen = demoBranches.find((b) => b.code === 'CEN')!.id;
    planId = (await getDb().plan.findFirstOrThrow({ where: { organizationId: orgId, code: 'MEN' } })).id;
    sede = await sedeDesechable(orgId, 'Sede de prueba de retención');

    // Recepción de Centro con la llave de Retención liberada.
    const email = await cuentaDePrueba(orgId, 'RECEPTION', [cen]);
    await getDb().user.updateMany({ where: { email }, data: { unlockedSections: ['retencion'] } });
    conLlave = await loginAs(app, email);

    const vacia = await lista();
    expect(vacia.statusCode, vacia.body).toBe(200);
    hoy = new Date(`${vacia.json().asOf}T00:00:00Z`);

    await socio('activo', { activar: true, altaHaceDias: 30 });
    await socio('congelado', { activar: true, altaHaceDias: 30 });
    await socio('sinActivar', { activar: false, altaHaceDias: 30 });
    await socio('descongelado15', { activar: true, altaHaceDias: 100 });
    await socio('descongelado2', { activar: true, altaHaceDias: 100 });
    await getDb().membership.update({ where: { id: membresias.congelado! }, data: { status: 'FROZEN', frozenSince: new Date(hoy.getTime() - 5 * MS_DIA) } });
    await descongelo('descongelado15', 15);
    await descongelo('descongelado2', 2);
  }, 120_000);

  afterAll(async () => {
    if (sede) await archivarSede(sede.id);
    await app.close();
    await closeDb();
  });

  it('la lista cumple su contrato y trae el total real, no el del recorte', async () => {
    const r = await lista();
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(RetentionAlerts, r.json())).toEqual([]);
    expect(r.json().total).toBe(2);

    const recortada = await app.inject({ method: 'GET', url: `/retention/alerts?branchId=${sede.id}&limit=1`, headers: { cookie: gerencia } });
    expect(recortada.json().outreach).toHaveLength(1);
    expect(recortada.json().total).toBe(2);
  });

  it('15-05 · el congelado y el alta sin activar NO están en la lista ni en las cuentas', async () => {
    const r = (await lista()).json();
    const ids = r.outreach.map((m: { memberId: string }) => m.memberId);
    expect(ids).toContain(socios.activo);
    expect(ids).not.toContain(socios.congelado);
    expect(ids).not.toContain(socios.sinActivar);
    // Tres socios medidos en la sede: el activo, y los dos que descongelaron.
    expect(Object.values(r.counts as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(3);
    expect(r.outreach.find((m: { memberId: string }) => m.memberId === socios.activo).state).toBe('ONBOARDING_AT_RISK');
  });

  it('D15-07 · al descongelar hay una semana de gracia; después, los días se cuentan desde que se reanudó', async () => {
    const r = (await lista()).json();
    // Descongeló hace 2 días: todavía no se le llama (sin la pausa sería «perdido»: 100 días de alta sin venir).
    expect(r.outreach.map((m: { memberId: string }) => m.memberId)).not.toContain(socios.descongelado2);
    expect(r.counts.REGULAR).toBe(1);
    expect(r.counts.LOST).toBe(0);
    // Descongeló hace 15 días y no ha vuelto: afloja, y la fila lo dice.
    const m = r.outreach.find((x: { memberId: string }) => x.memberId === socios.descongelado15);
    expect(m, JSON.stringify(r.outreach)).toBeTruthy();
    expect(m.state).toBe('SLIPPING');
    expect(m.detail).toMatch(/Descongeló hace 15 días y no ha vuelto/);
    expect(m.daysSinceLastVisit).toBeNull();
  });

  it('15-01 · la dueña ve las cifras sin nombres y NO la lista', async () => {
    const r = await cifras(duena);
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(RetentionSummary, r.json())).toEqual([]);
    expect(r.json()).toMatchObject({ branchId: sede.id, atRisk: 2, counts: { ONBOARDING_AT_RISK: 1, SLIPPING: 1, DORMANT: 0, REGULAR: 1 } });
    expect(r.body).not.toMatch(/fullName|phoneE164|memberCode/);

    // Todo el gimnasio, sin elegir sede: su alcance es la organización.
    const todo = await cifras(duena, '');
    expect(todo.statusCode, todo.body).toBe(200);
    expect(todo.json().branchId).toBeNull();
    expect(todo.json().atRisk).toBeGreaterThanOrEqual(2);

    // La lista trae nombres y teléfonos: es de la operación (ADR-039).
    expect((await lista(duena)).statusCode).toBe(403);
  });

  it('las cifras y la lista salen de la misma cuenta', async () => {
    const l = (await lista()).json();
    const c = (await cifras(gerencia)).json();
    expect(c.counts).toEqual(l.counts);
    expect(c.atRisk).toBe(l.total);
    expect(c.atRisk).toBe(c.counts.ONBOARDING_AT_RISK + c.counts.SLIPPING + c.counts.DORMANT);
    expect(c.asOf).toBe(l.asOf);
  });

  it('las cifras respetan la sede: recepción con la llave ve la suya; el coach, nada', async () => {
    const suya = await cifras(conLlave, '?fresh=1');
    expect(suya.statusCode, suya.body).toBe(200);
    expect(suya.json().branchId).toBe(cen);
    expect((await cifras(conLlave)).statusCode).toBe(403);

    const coach = await loginAs(app, 'coach@demo.mx');
    expect((await cifras(coach, '')).statusCode).toBe(403);
    const recepcion = await loginAs(app, 'recepcion@demo.mx');
    expect((await cifras(recepcion, '')).statusCode).toBe(403);
  });

  it('15-13 · el último contacto solo se lee de los socios de las sedes de quien pide', async () => {
    const llamada = await app.inject({
      method: 'POST', url: `/members/${socios.activo}/follow-ups`, headers: { cookie: gerencia },
      payload: { channel: 'CALL', outcome: 'NO_ANSWER', nextStepOn: '2026-12-01' },
    });
    expect(llamada.statusCode, llamada.body).toBe(201);
    expect(diferenciasConElContrato(FollowUpContact, llamada.json())).toEqual([]);

    const gerente = await app.inject({ method: 'GET', url: `/members/follow-ups/latest?ids=${socios.activo},${socios.congelado}`, headers: { cookie: gerencia } });
    expect(gerente.statusCode, gerente.body).toBe(200);
    expect(diferenciasConElContrato(FollowUpLatest, gerente.json())).toEqual([]);
    expect(gerente.json().latest).toHaveLength(1);
    expect(gerente.json().latest[0]).toMatchObject({ memberId: socios.activo, count: 1, last: { outcome: 'NO_ANSWER', nextStepOn: '2026-12-01' } });

    // Recepción de Centro conoce el id de un socio de otra sede: no le llega nada.
    const ajena = await app.inject({ method: 'GET', url: `/members/follow-ups/latest?ids=${socios.activo}`, headers: { cookie: conLlave } });
    expect(ajena.statusCode, ajena.body).toBe(200);
    expect(ajena.json().latest).toEqual([]);
  });

  it('15-13 · «le llamé» pide la sede del socio; sin sede de casa, alcance de todo el gimnasio', async () => {
    const payload = { channel: 'CALL', outcome: 'ANSWERED' };
    const ajeno = await app.inject({ method: 'POST', url: `/members/${socios.activo}/follow-ups`, headers: { cookie: conLlave }, payload });
    expect(ajeno.statusCode, ajeno.body).toBe(403);

    await getDb().member.update({ where: { id: socios.sinActivar }, data: { homeBranchId: null } });
    const sinSede = await app.inject({ method: 'POST', url: `/members/${socios.sinActivar}/follow-ups`, headers: { cookie: conLlave }, payload });
    expect(sinSede.statusCode, sinSede.body).toBe(403);
    const gerente = await app.inject({ method: 'POST', url: `/members/${socios.sinActivar}/follow-ups`, headers: { cookie: gerencia }, payload });
    expect(gerente.statusCode, gerente.body).toBe(201);
    // Y su contacto no lo lee quien solo tiene una sede.
    const lote = await app.inject({ method: 'GET', url: `/members/follow-ups/latest?ids=${socios.sinActivar}`, headers: { cookie: conLlave } });
    expect(lote.json().latest).toEqual([]);
  });
});
