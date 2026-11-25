import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ADJUSTABLE_BY_ROLE, OWNER_WITHOUT_MANAGER, adjustableFor, uuidv7 } from '@gymflow/core';
import { makeApp, loginAs, cuentaDePrueba, PASSWORD } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { registeredRoutes } from '../src/platform/http/registry.js';
import { gimnasioPropio, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { excepcionesPorRetirar, retirarExcepciones } from '../src/modules/identity/index.js';

/**
 * FASE 4 · BLOQUE 4.19 · PERMISOS (respuestas de Israel del 2026-11-25).
 *
 *  · P-02: sin un gerente que administre (activo y con Personal liberado), la
 *    dueña cancela una clase, cambia el coach de un socio, cierra la revisión
 *    de un descuadre y ajusta los plazos de retención y de la deuda (estos con
 *    su contraseña). Con gerente, nada cambia. El apoderado, nunca.
 *  · P-09: anular ventas de la tienda (y descartar «por corregir») ya no se
 *    enciende a recepción; «se renueva sola» se queda como está.
 *  · P-10: recepción nunca lee ni teclea la nota de salud.
 *  · Lo ya encendido: el guion lo lista y lo retira con su asiento, dos veces sin daño.
 *
 * Gimnasio propio: deja sin gerente al gimnasio y lo vuelve a tener. Las
 * fechas salen del «hoy» de la API (la clase es de dentro de 5 días).
 */
const DIA = 86_400_000;

describe('permisos · bloque 4.19', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let org: string; let sede: string;
  let duena: string; let gerente: string; let recepcion: string;
  let idRecepcion: string; let idsGerentes: string[];
  let coachId: string; let socio: string;
  let tipo: string;

  const db = () => getDb();
  const pedir = (cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload } : {}) });
  const permisos = async (cookie: string) => (await pedir(cookie, 'GET', '/auth/me')).json().permissions as string[];
  const sinGerente = () => db().user.updateMany({ where: { id: { in: idsGerentes } }, data: { isActive: false } });
  const conGerente = () => db().user.updateMany({ where: { id: { in: idsGerentes } }, data: { isActive: true } });
  /** Una sesión de clase de dentro de 5 días, armada por la gerencia. */
  async function sesion(): Promise<string> {
    const fecha = new Date(Date.now() + 5 * DIA).toISOString().slice(0, 10);
    const r = await pedir(gerente, 'POST', '/classes/schedules', { branchId: sede, classTypeId: tipo, date: fecha, startMinute: 600, durationMin: 60, capacity: 8 });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  /** Un corte de recepción con $50 de faltante: queda «por revisar». */
  async function corteConFaltante(): Promise<string> {
    const t = await pedir(recepcion, 'POST', '/cash-sessions', { cashRegisterId: g.sedes[0]!.cajas[0]!, openingFloatCents: '100000' });
    expect(t.statusCode, t.body).toBe(201);
    const c = await pedir(recepcion, 'POST', `/cash-sessions/${t.json().id}/close`, { countedCashCents: '95000', varianceReason: 'Faltante de la prueba de permisos' });
    expect(c.statusCode, c.body).toBe(200);
    return t.json().id as string;
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio();
    org = g.organizationId; sede = g.sedes[0]!.id;
    duena = await loginAs(app, g.correos.owner);
    gerente = await loginAs(app, g.correos.gerente);
    recepcion = await loginAs(app, g.correos.recepcion);
    const cuentas = await db().user.findMany({ where: { email: { in: [g.correos.recepcion, g.correos.gerente, g.correos.gerente2] } }, select: { id: true, email: true } });
    idRecepcion = cuentas.find((c) => c.email === g.correos.recepcion)!.id;
    idsGerentes = cuentas.filter((c) => c.email !== g.correos.recepcion).map((c) => c.id);
    const correoCoach = await cuentaDePrueba(org, 'COACH', [sede]);
    coachId = (await db().user.findFirstOrThrow({ where: { email: correoCoach } })).id;
    socio = await socioPropio(g);
    const t = await pedir(gerente, 'POST', '/classes/types', { name: 'Funcional 4.19', defaultCapacity: 10, dropInPriceCents: '10000' });
    expect(t.statusCode, t.body).toBe(201);
    tipo = t.json().id as string;
  });

  afterAll(async () => {
    await conGerente();
    await g.cerrar();
    await app.close();
    await closeDb();
  });

  // ── P-02 ──────────────────────────────────────────────────────────────────

  describe('P-02 · la dueña sin gerente', () => {
    it('con gerente, nada cambia: la dueña no trae ninguno y las cuatro cosas le dan 403', async () => {
      const mios = await permisos(duena);
      for (const k of ['classes:session:cancel', 'members:coach:assign', 'cash:variance:approve', 'retention:terms:set', 'billing:debt-terms:set', 'classes:read', 'members:read']) {
        expect(mios, k).not.toContain(k);
      }
      const clase = await sesion();
      const corte = await corteConFaltante();
      expect((await pedir(duena, 'POST', `/classes/schedules/${clase}/cancel`, { reason: 'El coach se enfermó' })).statusCode).toBe(403);
      expect((await pedir(duena, 'PUT', `/members/${socio}/coach`, { coachUserId: coachId })).statusCode).toBe(403);
      expect((await pedir(duena, 'GET', '/members/coaches')).statusCode).toBe(403);
      expect((await pedir(duena, 'POST', `/cash-sessions/${corte}/variance/review`, { note: 'Se habló con quien abrió' })).statusCode).toBe(403);
      expect((await pedir(duena, 'PUT', '/member-terms/retention', { dormantDays: 28, reason: 'Así viene la gente' })).statusCode).toBe(403);
      expect((await pedir(duena, 'PUT', '/member-terms/debt', { lostDebtDays: 120, reason: 'Esperar más', password: PASSWORD })).statusCode).toBe(403);
      // Las cuatro siguen siendo de la gerencia.
      expect((await pedir(gerente, 'POST', `/cash-sessions/${corte}/variance/review`, { note: 'Se habló con quien abrió' })).statusCode).toBe(200);
      expect((await pedir(gerente, 'POST', `/classes/schedules/${clase}/cancel`, { reason: 'Fin de la prueba' })).statusCode).toBe(200);
    });

    it('sin gerente activo, la dueña recibe la lista del núcleo en todo el gimnasio, y nada más de operación', async () => {
      await sinGerente();
      try {
        const mios = await permisos(duena);
        for (const k of OWNER_WITHOUT_MANAGER) expect(mios, k).toContain(k);
        for (const k of ['members:health:read', 'payments:record', 'pos:sale:void', 'cash:session:open', 'classes:manage', 'members:update', 'members:create']) expect(mios, k).not.toContain(k);
      } finally { await conGerente(); }
    });

    it('sin gerente, cancela una clase, cambia el coach, cierra la revisión de un descuadre y ajusta los plazos de retención', async () => {
      const clase = await sesion();
      const corte = await corteConFaltante();
      await sinGerente();
      try {
        const cancelada = await pedir(duena, 'POST', `/classes/schedules/${clase}/cancel`, { reason: 'El coach se enfermó y no hay gerente' });
        expect(cancelada.statusCode, cancelada.body).toBe(200);
        expect((await db().classSchedule.findUniqueOrThrow({ where: { id: clase } })).status).toBe('CANCELED');

        expect((await pedir(duena, 'GET', '/members/coaches')).json().coaches.map((c: { id: string }) => c.id)).toContain(coachId);
        const coach = await pedir(duena, 'PUT', `/members/${socio}/coach`, { coachUserId: coachId });
        expect(coach.statusCode, coach.body).toBe(200);
        expect((await db().member.findUniqueOrThrow({ where: { id: socio }, select: { coachUserId: true } })).coachUserId).toBe(coachId);

        const revisada = await pedir(duena, 'POST', `/cash-sessions/${corte}/variance/review`, { note: 'Lo hablé con quien abrió el turno' });
        expect(revisada.statusCode, revisada.body).toBe(200);

        const plazos = await pedir(duena, 'PUT', '/member-terms/retention', { dormantDays: 28, reason: 'Así viene la gente de este gimnasio' });
        expect(plazos.statusCode, plazos.body).toBe(200);
        expect(plazos.json().terms.dormantDays).toBe(28);

        // Cada acto queda a su nombre en la bitácora.
        const yo = g.ownerId;
        for (const action of ['class.schedule.cancel', 'member.coach', 'settings.retention_terms.update']) {
          expect(await db().auditLog.count({ where: { organizationId: org, action, actorUserId: yo } }), action).toBe(1);
        }
        // Y la nota de salud sigue sin ser suya.
        expect((await pedir(duena, 'GET', `/members/${socio}/health`)).statusCode).toBe(403);
      } finally {
        await conGerente();
        await pedir(gerente, 'PUT', '/member-terms/retention', { dormantDays: 21, reason: 'Volvemos a los de GymFlow' });
      }
    });

    it('sin gerente, los plazos de la deuda: con su contraseña (no con su propia firma); sin ella o mal escrita, no', async () => {
      await sinGerente();
      try {
        const cambio = { lostDebtDays: 120, reason: 'Quiero esperar cuatro meses' };
        const sinClave = await pedir(duena, 'PUT', '/member-terms/debt', cambio);
        expect(sinClave.statusCode, sinClave.body).toBe(422);
        expect(sinClave.json().message).toMatch(/contraseña/);
        const mala = await pedir(duena, 'PUT', '/member-terms/debt', { ...cambio, password: 'no-es-la-suya' });
        expect([401, 403, 422], mala.body).toContain(mala.statusCode);
        expect((await pedir(duena, 'GET', '/member-terms')).json().terms.lostDebtDays).toBe(90);

        const hecho = await pedir(duena, 'PUT', '/member-terms/debt', { ...cambio, password: PASSWORD });
        expect(hecho.statusCode, hecho.body).toBe(200);
        expect(hecho.json().terms.lostDebtDays).toBe(120);
        const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'billing.debt_terms.update' }, orderBy: { at: 'desc' } });
        expect(asiento.actorUserId).toBe(g.ownerId);
        expect(asiento.approvedByUserId).toBeNull();
        expect(asiento.afterState).toMatchObject({ lostDebtDays: 120, ownerAlone: true });
        // Un plazo de retención no entra por esta puerta, ni con contraseña.
        expect((await pedir(duena, 'PUT', '/member-terms/debt', { dormantDays: 30, reason: 'Colado', password: PASSWORD })).statusCode).toBe(422);
        // Y la contraseña no abre los de retención (ese cuerpo no la conoce).
        expect((await pedir(duena, 'PUT', '/member-terms/retention', { dormantDays: 25, reason: 'Con clave', password: PASSWORD })).statusCode).toBe(422);
      } finally {
        await conGerente();
      }
      // Con gerente otra vez, la dueña ya no los toca.
      expect((await pedir(duena, 'PUT', '/member-terms/debt', { lostDebtDays: 90, reason: 'De vuelta', password: PASSWORD })).statusCode).toBe(403);
    });

    it('un gerente activo SIN Personal liberado no cuenta como gerente (la misma regla de siempre)', async () => {
      const antes = await db().user.findMany({ where: { id: { in: idsGerentes } }, select: { id: true, unlockedSections: true } });
      await db().user.updateMany({ where: { id: { in: idsGerentes } }, data: { unlockedSections: ['caja'] } });
      try {
        expect(await permisos(duena)).toContain('classes:session:cancel');
      } finally {
        for (const a of antes) await db().user.update({ where: { id: a.id }, data: { unlockedSections: a.unlockedSections as string[] } });
      }
      expect(await permisos(duena)).not.toContain('classes:session:cancel');
    });

    it('el apoderado no: aunque el gimnasio no tenga gerente, su nombramiento no le da ninguna de las cuatro', async () => {
      const clase = await sesion();
      await db().approvalProxy.create({ data: { id: uuidv7(), organizationId: org, grantedByUserId: g.ownerId, proxyUserId: idRecepcion, endsAt: new Date(Date.now() + 2 * DIA) } });
      await sinGerente();
      try {
        const suyos = await permisos(recepcion);
        expect(suyos).toContain('approvals:proxy');
        for (const k of ['classes:session:cancel', 'members:coach:assign', 'cash:variance:approve', 'retention:terms:set', 'billing:debt-terms:set']) expect(suyos, k).not.toContain(k);
        expect((await pedir(recepcion, 'POST', `/classes/schedules/${clase}/cancel`, { reason: 'Soy apoderada' })).statusCode).toBe(403);
        expect((await pedir(recepcion, 'PUT', `/members/${socio}/coach`, { coachUserId: null })).statusCode).toBe(403);
        expect((await pedir(recepcion, 'PUT', '/member-terms/debt', { lostDebtDays: 100, reason: 'Soy apoderada', password: PASSWORD })).statusCode).toBe(403);
      } finally {
        await db().approvalProxy.updateMany({ where: { organizationId: org, proxyUserId: idRecepcion, endedAt: null }, data: { endedAt: new Date(), endReason: 'REVOKED' } });
        await conGerente();
      }
    });

    it('las rutas de las cuatro piden justo esos permisos (lo que la sesión le da es lo que la ruta mira)', () => {
      const de = (metodo: string, url: string) => registeredRoutes().find((r) => r.method === metodo && r.url === url)!.security;
      expect(de('POST', '/classes/schedules/:id/cancel')).toMatchObject({ kind: 'permission', permission: 'classes:session:cancel' });
      expect(de('PUT', '/members/:id/coach')).toMatchObject({ kind: 'permission', permission: 'members:coach:assign' });
      expect(de('POST', '/cash-sessions/:id/variance/review')).toMatchObject({ kind: 'permission', permission: 'cash:variance:approve' });
      expect(de('PUT', '/member-terms/retention')).toMatchObject({ kind: 'permission', permission: 'retention:terms:set' });
      expect(de('PUT', '/member-terms/debt')).toMatchObject({ kind: 'permission', permission: 'billing:debt-terms:set' });
      // Ninguno se enciende por persona.
      for (const k of ['classes:session:cancel', 'members:coach:assign', 'cash:variance:approve', 'retention:terms:set', 'billing:debt-terms:set']) {
        for (const puesto of ['RECEPTION', 'COACH']) expect(adjustableFor(puesto).has(k), `${puesto} ${k}`).toBe(false);
      }
    });
  });

  // ── P-09 y P-10 ───────────────────────────────────────────────────────────

  describe('P-09 y P-10 · lo que ya no se enciende a recepción', () => {
    const ajustar = (cookie: string, id: string, add: string[]) => pedir(cookie, 'PUT', `/users/${id}/permissions`, { add, remove: [], reason: 'Prueba del bloque 4.19' });

    it('la gerencia ya no puede encender a recepción anular ventas ni la nota de salud: 422 con el porqué', async () => {
      const anular = await ajustar(gerente, idRecepcion, ['pos:sale:void']);
      expect(anular.statusCode, anular.body).toBe(422);
      expect(anular.json().message).toMatch(/es de la gerencia/);
      const salud = await ajustar(gerente, idRecepcion, ['members:health:read']);
      expect(salud.statusCode, salud.body).toBe(422);
      expect(salud.json().message).toMatch(/dato sensible/);
      // «Cambiar de plan» (que trae «se renueva sola») sí, como está (P-09).
      const plan = await ajustar(gerente, idRecepcion, ['memberships:change_plan']);
      expect(plan.statusCode, plan.body).toBe(200);
      // Y al coach la nota de salud de sus socios se le sigue ajustando.
      expect((await pedir(gerente, 'PUT', `/users/${coachId}/permissions`, { add: [], remove: ['members:health:read'], reason: 'Prueba del bloque 4.19' })).statusCode).toBe(200);
      expect((await pedir(gerente, 'PUT', `/users/${coachId}/permissions`, { add: [], remove: [], reason: 'Como su puesto' })).statusCode).toBe(200);
      expect((await ajustar(gerente, idRecepcion, [])).statusCode).toBe(200);
    });

    it('el catálogo de Personal ya no se los ofrece a recepción y dice por qué; al coach sí le ofrece la salud', async () => {
      const cat = (await pedir(gerente, 'GET', '/users/adjustable-permissions')).json() as {
        groups: Array<{ name: string; permissions: Array<{ key: string }> }>;
        roles: Array<{ key: string; adjustable: string[]; never: Array<{ key: string; why: string }> }>;
      };
      const rec = cat.roles.find((r) => r.key === 'RECEPTION')!;
      expect(rec.adjustable).not.toContain('pos:sale:void');
      expect(rec.adjustable).not.toContain('members:health:read');
      expect(rec.never.map((n) => n.key).sort()).toEqual(['members:health:read', 'pos:sale:void']);
      for (const n of rec.never) expect(n.why.length).toBeGreaterThan(20);
      const coach = cat.roles.find((r) => r.key === 'COACH')!;
      expect(coach.adjustable).toContain('members:health:read');
      expect(coach.never).toEqual([]);
      // La lista de grupos trae la salud (por el coach) y ya no trae anular ventas.
      const todas = cat.groups.flatMap((x) => x.permissions.map((p) => p.key));
      expect(todas).toContain('members:health:read');
      expect(todas).not.toContain('pos:sale:void');
    });

    it('lo que ya estaba encendido deja de valer: ni anula, ni descarta «por corregir», ni lee la nota (contra la ruta)', async () => {
      await db().user.update({ where: { id: idRecepcion }, data: { permissionOverrides: { add: ['pos:sale:void', 'members:health:read'], remove: [] } } });
      try {
        // Entrar otra vez cierra la sesión anterior: desde aquí, la nueva.
        recepcion = await loginAs(app, g.correos.recepcion);
        const suyos = await permisos(recepcion);
        expect(suyos).not.toContain('pos:sale:void');
        expect(suyos).not.toContain('members:health:read');
        const otra = uuidv7();
        // La ruta lo niega por su permiso antes de buscar la venta; la gerencia pasa y no la encuentra.
        for (const url of [`/pos/sales/${otra}/void`, `/pos/sales/${otra}/flag/dismiss`]) {
          expect((await pedir(recepcion, 'POST', url, { reason: 'Me equivoqué de producto' })).statusCode, url).toBe(403);
          expect((await pedir(gerente, 'POST', url, { reason: 'Me equivoqué de producto' })).statusCode, url).toBe(404);
        }
        expect((await pedir(recepcion, 'GET', `/members/${socio}/health`)).statusCode).toBe(403);
        // Personal ya no se lo muestra como excepción.
        expect((await pedir(gerente, 'GET', `/users/${idRecepcion}`)).json().permissionOverrides).toEqual({ add: [], remove: [] });
      } finally {
        await db().user.update({ where: { id: idRecepcion }, data: { permissionOverrides: { add: [], remove: [] } } });
      }
    });

    it('las rutas que anulan y descartan piden `pos:sale:void`, y la de la nota `members:health:read`: ninguno se enciende a recepción', () => {
      const piden = (k: string) => registeredRoutes().filter((r) => r.security.kind === 'permission' && [r.security.permission, ...(r.security.anyOf ?? [])].includes(k as never)).map((r) => `${r.method} ${r.url}`).sort();
      expect(piden('pos:sale:void')).toEqual(['POST /pos/sales/:id/flag/dismiss', 'POST /pos/sales/:id/void'].sort());
      expect(piden('members:health:read')).toEqual(['GET /members/:id/health']);
      const deRecepcion = ADJUSTABLE_BY_ROLE.RECEPTION.flatMap((x) => x.permissions);
      expect(deRecepcion).not.toContain('pos:sale:void');
      expect(deRecepcion).not.toContain('members:health:read');
    });
  });

  // ── Lo que ya existe ──────────────────────────────────────────────────────

  describe('el guion de lo ya encendido', () => {
    it('lista, retira con su asiento y la segunda corrida no encuentra nada; lo demás de la persona y el coach quedan igual', async () => {
      const otra = await cuentaDePrueba(org, 'RECEPTION', [sede]);
      const idOtra = (await db().user.findFirstOrThrow({ where: { email: otra } })).id;
      await db().user.update({ where: { id: idRecepcion }, data: { permissionOverrides: { add: ['billing:discount:apply', 'pos:sale:void', 'members:health:read'], remove: ['training:read'] } } });
      await db().user.update({ where: { id: idOtra }, data: { permissionOverrides: { add: ['pos:sale:void'], remove: [] } } });
      await db().user.update({ where: { id: coachId }, data: { permissionOverrides: { add: ['members:health:read'], remove: [] } } });
      try {
        const lista = await excepcionesPorRetirar(org);
        expect(lista.map((e) => [e.userId, [...e.retirar].sort()]).sort()).toEqual([
          [idRecepcion, ['members:health:read', 'pos:sale:void']], [idOtra, ['pos:sale:void']],
        ].sort());
        // Solo leer no cambia nada.
        expect((await db().user.findUniqueOrThrow({ where: { id: idOtra } })).permissionOverrides).toEqual({ add: ['pos:sale:void'], remove: [] });

        const hechas = await retirarExcepciones(org, 'P-09 y P-10: ya no se encienden a recepción');
        expect(hechas.length).toBe(2);
        expect((await db().user.findUniqueOrThrow({ where: { id: idRecepcion } })).permissionOverrides).toEqual({ add: ['billing:discount:apply'], remove: ['training:read'] });
        expect((await db().user.findUniqueOrThrow({ where: { id: idOtra } })).permissionOverrides).toBeNull();
        expect((await db().user.findUniqueOrThrow({ where: { id: coachId } })).permissionOverrides).toEqual({ add: ['members:health:read'], remove: [] });
        const asientos = await db().auditLog.findMany({ where: { organizationId: org, action: 'staff.permissions', actorType: 'SYSTEM' } });
        expect(asientos.map((a) => a.resourceId).sort()).toEqual([idRecepcion, idOtra].sort());
        const deElla = asientos.find((a) => a.resourceId === idRecepcion)!;
        expect(deElla.beforeState).toEqual({ add: ['billing:discount:apply', 'pos:sale:void', 'members:health:read'], remove: ['training:read'] });
        expect(deElla.afterState).toMatchObject({ add: ['billing:discount:apply'], remove: ['training:read'], migration: '4.19' });
        expect(deElla.reason).toMatch(/P-09/);

        // Dos veces sin daño.
        expect(await excepcionesPorRetirar(org)).toEqual([]);
        expect(await retirarExcepciones(org, 'Otra vez')).toEqual([]);
        expect(await db().auditLog.count({ where: { organizationId: org, action: 'staff.permissions', actorType: 'SYSTEM' } })).toBe(2);
      } finally {
        await db().user.updateMany({ where: { id: { in: [idRecepcion, idOtra, coachId] } }, data: { permissionOverrides: { add: [], remove: [] } } });
      }
    });
  });
});
