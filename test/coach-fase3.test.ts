import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ADJUSTABLE_PERMISSIONS, ROLE_BY_KEY, uuidv7 } from '@gymflow/core';
import { COACH_CODE } from '@gymflow/core/contracts';
import { makeApp, loginAs, nombreUnico, telefonoUnico, cuentaDePrueba, CONSENTIMIENTOS } from './helpers.js';
import { gimnasioPropio, sesionesDe, type GimnasioPropio } from './gimnasio-propio.js';
import { ponerReloj, relojReal } from './reloj.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { registeredRoutes } from '../src/platform/http/registry.js';

/**
 * EL COACH EN LA FASE 3 (auditoría 8, bloque 3.8; decisiones D-28 y D-29).
 *
 * D-28 (c): el coach opera SUS clases (lista, inscribir a sus socios, suplente
 * y cupo) y no cancela ninguna, ni la suya, por ninguna ruta.
 * D-29 (b): recepción elige el coach al alta; después solo la gerencia lo
 * cambia; el coach se suma a un socio sin coach con el código que el socio le
 * dicta («Hacerme su coach»).
 *
 * En un gimnasio propio, con coaches y socios de cada caso. Las sesiones se
 * siembran relativas a «ahora»: no depende de la hora ni del día en que corre.
 */
describe('el coach en la fase 3 (D-28, D-29)', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let gerente: string;
  let recepcion: string;
  let sede: string;
  let tipo: string;
  let plan: string;

  const HORA = 3_600_000;
  type Metodo = 'GET' | 'POST' | 'PUT' | 'PATCH';
  const pedir = (cookie: string | null, method: Metodo, url: string, payload?: unknown) =>
    app.inject({ method, url, ...(cookie ? { headers: { cookie } } : {}), ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

  async function coachNuevo(): Promise<{ id: string; cookie: string; correo: string }> {
    const correo = await cuentaDePrueba(g.organizationId, 'COACH', [null]);
    const id = (await getDb().user.findFirstOrThrow({ where: { email: correo }, select: { id: true } })).id;
    return { id, correo, cookie: await loginAs(app, correo) };
  }
  /** Un socio dado de alta en el mostrador; con plan que incluye clases si hace falta inscribirlo. */
  async function socio(opts: { coachId?: string; conPlan?: boolean; por?: string } = {}): Promise<string> {
    const r = await pedir(opts.por ?? recepcion, 'POST', '/members', {
      firstName: nombreUnico('Socio'), lastName: nombreUnico('Coach'), phoneE164: telefonoUnico(), homeBranchId: sede, force: true,
      consents: CONSENTIMIENTOS, ...(opts.coachId ? { coachUserId: opts.coachId } : {}),
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    if (opts.conPlan) {
      await getDb().membership.create({
        data: {
          id: uuidv7(), organizationId: g.organizationId, memberId: id, planId: plan, soldAtBranchId: sede, status: 'ACTIVE',
          startDate: new Date(), currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 90 * 24 * HORA), billingAnchorDay: 1,
        },
      });
    }
    return id;
  }
  async function sesion(opts: { coachId?: string | null; enHoras?: number; capacity?: number } = {}): Promise<string> {
    const startsAt = new Date(Date.now() + (opts.enHoras ?? 48) * HORA);
    const row = await getDb().classSchedule.create({
      data: {
        id: uuidv7(), organizationId: g.organizationId, branchId: sede, classTypeId: tipo, coachUserId: opts.coachId ?? null,
        occurrenceKey: `prueba:${uuidv7()}`, startsAt, endsAt: new Date(startsAt.getTime() + HORA),
        businessDate: new Date(startsAt.toISOString().slice(0, 10)), capacity: opts.capacity ?? 10,
      },
    });
    return row.id;
  }
  const estadoDe = async (id: string) => (await getDb().classSchedule.findUniqueOrThrow({ where: { id }, select: { status: true, coachUserId: true, capacity: true, bookedCount: true } }));
  async function portalDe(memberId: string): Promise<string> {
    const invite = await pedir(gerente, 'POST', `/members/${memberId}/portal-invite`);
    expect(invite.statusCode, invite.body).toBe(201);
    const enroll = await app.inject({ method: 'POST', url: '/portal/enroll', payload: { code: invite.json().code } });
    expect(enroll.statusCode, enroll.body).toBe(201);
    return `gf_portal=${enroll.cookies.find((c) => c.name === 'gf_portal')!.value}`;
  }
  async function codigoDe(portal: string): Promise<string> {
    const r = await pedir(portal, 'POST', '/portal/coach/code');
    expect(r.statusCode, r.body).toBe(201);
    return r.json().code as string;
  }
  const teclear = (cookie: string, code: string) => pedir(cookie, 'POST', '/coach/claim', { code });
  /** Un código de seis dígitos que no es ninguno de los dados. */
  const otroCodigo = (...vivos: string[]) => { let c = '000000'; while (vivos.includes(c)) c = String(Number(c) + 1).padStart(6, '0'); return c; };
  const ajustar = async (userId: string, add: string[]) => { await getDb().user.update({ where: { id: userId }, data: { permissionOverrides: { add, remove: [] } } }); };
  const bitacora = (action: string, resourceId: string) => getDb().auditLog.count({ where: { organizationId: g.organizationId, action, resourceId } });

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioPropio();
    ({ gerente, recepcion } = await sesionesDe(app, g));
    sede = g.sedes[0]!.id;
    const t = await pedir(gerente, 'POST', '/classes/types', { name: 'Funcional', defaultCapacity: 12 });
    expect(t.statusCode, t.body).toBe(201);
    tipo = t.json().id;
    plan = uuidv7();
    await getDb().plan.create({
      data: {
        id: plan, organizationId: g.organizationId, code: 'CONCLASES', name: 'Con clases', billingModel: 'RECURRING',
        durationUnit: 'MONTH', durationValue: 1, priceCents: 90_000n, includesClasses: true,
      },
    });
  });
  afterEach(() => { relojReal(); });
  afterAll(async () => {
    await g.cerrar();
    await app.close();
    await closeDb();
  });

  // ── D-28 ──────────────────────────────────────────────────────────────────

  describe('D-28 · opera sus clases y no cancela ninguna', () => {
    const CANCELAN = ['POST /classes/pauses', 'POST /classes/schedules/:id/cancel', 'POST /classes/templates/:id/retire', 'POST /classes/types/:id/retire'];

    it('el puesto: opera sesiones, no arma el horario y cancelar no se le da ni por persona', () => {
      const coach = ROLE_BY_KEY.get('COACH')!.permissions as readonly string[];
      expect(coach).toContain('classes:session:operate');
      expect(coach).toContain('classes:book_for_member');
      expect(coach).not.toContain('classes:manage');
      expect(coach).not.toContain('classes:session:cancel');
      // Armar el horario se le enciende a una persona; cancelar, a nadie.
      expect(ADJUSTABLE_PERMISSIONS.has('classes:manage')).toBe(true);
      expect(ADJUSTABLE_PERMISSIONS.has('classes:session:cancel')).toBe(false);
      expect(ROLE_BY_KEY.get('RECEPTION')!.permissions as readonly string[]).not.toContain('classes:session:cancel');
      expect(ROLE_BY_KEY.get('MANAGER')!.permissions as readonly string[]).toContain('classes:session:cancel');
    });

    it('ninguna ruta que cancela clases queda al alcance de un coach, tenga lo que tenga encendido', () => {
      const rutas = registeredRoutes().filter((r) => r.security.kind === 'permission');
      const clave = (r: { method: unknown; url: string }) => `${String(r.method)} ${r.url}`;
      // Las cuatro que cancelan piden el permiso que solo trae la gerencia…
      expect(rutas.filter((r) => r.security.kind === 'permission' && r.security.permission === 'classes:session:cancel').map(clave).sort()).toEqual(CANCELAN);
      // …y lo más que un coach puede llegar a tener (su puesto y todo lo que se le enciende) no abre ninguna.
      const alcanza = new Set<string>([...ROLE_BY_KEY.get('COACH')!.permissions, ...ADJUSTABLE_PERMISSIONS]);
      const abiertas = rutas.filter((r) => r.security.kind === 'permission' && [r.security.permission, ...(r.security.anyOf ?? [])].some((p) => alcanza.has(p))).map(clave);
      for (const c of CANCELAN) expect(abiertas, c).not.toContain(c);
      // Lo que sí escribe en Clases con su puesto, sin nada encendido: inscribir, quitar, pasar lista, suplente y cupo.
      const delPuesto = new Set<string>(ROLE_BY_KEY.get('COACH')!.permissions);
      const escribe = rutas.filter((r) => r.url.startsWith('/classes') && String(r.method) !== 'GET' && r.security.kind === 'permission' && delPuesto.has(r.security.permission)).map(clave).sort();
      expect(escribe).toEqual([
        'PATCH /classes/schedules/:id/capacity', 'POST /classes/bookings/:id/cancel', 'POST /classes/bookings/:id/checkin',
        'POST /classes/schedules/:id/bookings', 'PUT /classes/schedules/:id/coach',
      ]);
    });

    it('el coach no cancela su propia sesión, ni quita su horario, ni retira la clase, ni pone una pausa; la gerencia sí', async () => {
      const coach = await coachNuevo();
      const suyo = await socio({ coachId: coach.id, conPlan: true });
      const s = await sesion({ coachId: coach.id });
      expect((await pedir(coach.cookie, 'POST', `/classes/schedules/${s}/bookings`, { memberId: suyo })).statusCode).toBe(201);
      const horario = await pedir(gerente, 'POST', '/classes/templates', {
        branchId: sede, classTypeId: tipo, coachUserId: coach.id, effectiveFrom: new Date().toISOString(),
        slots: [{ weekday: 2, startMinute: 600, durationMin: 60, capacity: 10 }],
      });
      expect(horario.statusCode, horario.body).toBe(201);
      const motivo = { reason: 'Me enfermé y no puedo darla' };
      const hoy = new Date().toISOString().slice(0, 10);

      const intentos = async (cookie: string) => [
        (await pedir(cookie, 'POST', `/classes/schedules/${s}/cancel`, motivo)).statusCode,
        (await pedir(cookie, 'POST', `/classes/templates/${horario.json().id}/retire`, motivo)).statusCode,
        (await pedir(cookie, 'POST', `/classes/types/${tipo}/retire`, motivo)).statusCode,
        (await pedir(cookie, 'POST', '/classes/pauses', { branchId: sede, fromDate: hoy, toDate: hoy, ...motivo })).statusCode,
      ];
      expect(await intentos(coach.cookie)).toEqual([403, 403, 403, 403]);

      // Ni con «Gestionar clases y horarios» encendido por persona (arma el horario, no cancela).
      await ajustar(coach.id, ['classes:manage']);
      const conHorario = await loginAs(app, coach.correo);
      expect(((await pedir(conHorario, 'GET', '/auth/me')).json().permissions as string[])).toContain('classes:manage');
      expect(await intentos(conHorario)).toEqual([403, 403, 403, 403]);

      // Tampoco una persona de recepción a la que se le encendió lo mismo.
      const rec = await cuentaDePrueba(g.organizationId, 'RECEPTION', [sede]);
      await ajustar((await getDb().user.findFirstOrThrow({ where: { email: rec } })).id, ['classes:manage', 'classes:session:operate']);
      expect(await intentos(await loginAs(app, rec))).toEqual([403, 403, 403, 403]);

      // Nada cambió: la sesión sigue programada, con su reserva; el horario y la clase siguen vivos.
      expect(await estadoDe(s)).toMatchObject({ status: 'SCHEDULED', bookedCount: 1 });
      expect((await getDb().classTemplate.findUniqueOrThrow({ where: { id: horario.json().id } })).isActive).toBe(true);
      expect((await getDb().classType.findUniqueOrThrow({ where: { id: tipo } })).isActive).toBe(true);
      expect(await getDb().classPause.count({ where: { organizationId: g.organizationId } })).toBe(0);

      // La gerencia sí cancela, con motivo, y queda en la bitácora.
      const r = await pedir(gerente, 'POST', `/classes/schedules/${s}/cancel`, { reason: 'El coach avisó que no puede' });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().canceledBookings).toBe(1);
      expect((await estadoDe(s)).status).toBe('CANCELED');
      expect(await bitacora('class.schedule.cancel', s)).toBe(1);
      expect((await pedir(gerente, 'POST', `/classes/templates/${horario.json().id}/retire`, { reason: 'Fin de la prueba' })).statusCode).toBe(200);
    });

    it('pone suplente y cambia el cupo de SU sesión; en la de otro coach o en una sin coach, no', async () => {
      const [a, b, c] = [await coachNuevo(), await coachNuevo(), await coachNuevo()];
      const deA = await sesion({ coachId: a.id });
      const deB = await sesion({ coachId: b.id });
      const sinCoach = await sesion();

      // Cupo de la suya.
      const cupo = await pedir(a.cookie, 'PATCH', `/classes/schedules/${deA}/capacity`, { capacity: 14 });
      expect(cupo.statusCode, cupo.body).toBe(200);
      expect((await estadoDe(deA)).capacity).toBe(14);
      // La de otro y la que no tiene coach: 403 con su porqué, y nada cambia.
      for (const ajena of [deB, sinCoach]) {
        const r1 = await pedir(a.cookie, 'PATCH', `/classes/schedules/${ajena}/capacity`, { capacity: 3 });
        expect(r1.statusCode, r1.body).toBe(403);
        expect(r1.json().reason).toBe('NOT_YOUR_CLASS');
        const r2 = await pedir(a.cookie, 'PUT', `/classes/schedules/${ajena}/coach`, { coachUserId: a.id });
        expect(r2.statusCode, r2.body).toBe(403);
        expect(r2.json().reason).toBe('NOT_YOUR_CLASS');
      }
      expect(await estadoDe(deB)).toMatchObject({ coachUserId: b.id, capacity: 10 });
      expect((await estadoDe(sinCoach)).coachUserId).toBeNull();

      // Suplente: tiene que nombrar a un coach activo; dejarla sin coach no es suyo.
      expect((await pedir(a.cookie, 'PUT', `/classes/schedules/${deA}/coach`, { coachUserId: null })).statusCode).toBe(422);
      expect((await pedir(a.cookie, 'PUT', `/classes/schedules/${deA}/coach`, { coachUserId: g.ownerId })).statusCode).toBe(422);
      const sup = await pedir(a.cookie, 'PUT', `/classes/schedules/${deA}/coach`, { coachUserId: c.id });
      expect(sup.statusCode, sup.body).toBe(200);
      expect((await estadoDe(deA)).coachUserId).toBe(c.id);
      expect(await bitacora('class.schedule.coach', deA)).toBe(1);
      // Ya la cubre otro: deja de ser suya, y el suplente sí la opera.
      expect((await pedir(a.cookie, 'PATCH', `/classes/schedules/${deA}/capacity`, { capacity: 20 })).statusCode).toBe(403);
      expect((await pedir(c.cookie, 'PATCH', `/classes/schedules/${deA}/capacity`, { capacity: 15 })).statusCode).toBe(200);

      // La gerencia opera cualquiera, también para dejarla sin coach.
      expect((await pedir(gerente, 'PUT', `/classes/schedules/${deB}/coach`, { coachUserId: null })).statusCode).toBe(200);
      // Recepción, por su puesto, ni suplente ni cupo.
      expect((await pedir(recepcion, 'PATCH', `/classes/schedules/${deA}/capacity`, { capacity: 9 })).statusCode).toBe(403);
    });

    it('inscribe a SUS socios en SUS clases y pasa lista en las suyas; no en las de otro coach', async () => {
      const [a, b] = [await coachNuevo(), await coachNuevo()];
      const suyo = await socio({ coachId: a.id, conPlan: true });
      const ajeno = await socio({ coachId: b.id, conPlan: true });
      // Dentro de la ventana del pase de lista (se abre una hora antes).
      const deA = await sesion({ coachId: a.id, enHoras: 0.5 });
      const deB = await sesion({ coachId: b.id, enHoras: 0.5 });
      const sinCoach = await sesion({ enHoras: 0.5 });

      // Cotizar e inscribir: su socio en su clase.
      expect((await pedir(a.cookie, 'GET', `/classes/schedules/${deA}/quote?memberId=${suyo}`)).statusCode).toBe(200);
      const propia = await pedir(a.cookie, 'POST', `/classes/schedules/${deA}/bookings`, { memberId: suyo });
      expect(propia.statusCode, propia.body).toBe(201);
      // Un socio que no es suyo no existe para él, tampoco aquí.
      expect((await pedir(a.cookie, 'POST', `/classes/schedules/${deA}/bookings`, { memberId: ajeno })).statusCode).toBe(404);
      expect((await pedir(a.cookie, 'GET', `/classes/schedules/${deA}/quote?memberId=${ajeno}`)).statusCode).toBe(404);
      // Su socio en la clase de otro, o en una sin coach: no la opera.
      for (const otra of [deB, sinCoach]) {
        const r = await pedir(a.cookie, 'POST', `/classes/schedules/${otra}/bookings`, { memberId: suyo });
        expect(r.statusCode, r.body).toBe(403);
        expect(r.json().reason).toBe('NOT_YOUR_CLASS');
        expect((await pedir(a.cookie, 'GET', `/classes/schedules/${otra}/quote?memberId=${suyo}`)).statusCode).toBe(403);
      }
      expect((await estadoDe(deB)).bookedCount).toBe(0);

      // Pase de lista: en la suya sí.
      expect((await pedir(a.cookie, 'POST', `/classes/bookings/${propia.json().id}/checkin`)).statusCode).toBe(200);
      // En la de otro coach, ni marcar la llegada ni quitar a nadie (lo inscribió recepción).
      const enLaDeB = await pedir(recepcion, 'POST', `/classes/schedules/${deB}/bookings`, { memberId: suyo });
      expect(enLaDeB.statusCode, enLaDeB.body).toBe(201);
      for (const accion of ['checkin', 'cancel']) {
        const r = await pedir(a.cookie, 'POST', `/classes/bookings/${enLaDeB.json().id}/${accion}`, {});
        expect(r.statusCode, `${accion} ${r.body}`).toBe(403);
        expect(r.json().reason).toBe('NOT_YOUR_CLASS');
      }
      expect((await getDb().classBooking.findUniqueOrThrow({ where: { id: enLaDeB.json().id } })).status).toBe('BOOKED');
      // El coach de esa sesión sí pasa lista, aunque el socio no sea suyo: la lista es de su clase.
      expect((await pedir(b.cookie, 'POST', `/classes/bookings/${enLaDeB.json().id}/checkin`)).statusCode).toBe(200);

      // Quitar a alguien de la suya, antes de que empiece.
      const otra = await sesion({ coachId: a.id });
      const lugar = await pedir(a.cookie, 'POST', `/classes/schedules/${otra}/bookings`, { memberId: suyo });
      expect(lugar.statusCode, lugar.body).toBe(201);
      expect((await pedir(a.cookie, 'POST', `/classes/bookings/${lugar.json().id}/cancel`, {})).statusCode).toBe(200);
    });

    it('armar el horario se da por persona: sin ello el coach no crea clases ni horarios; con ello sí, y sigue sin cancelar', async () => {
      const coach = await coachNuevo();
      const otro = await coachNuevo();
      const deOtro = await sesion({ coachId: otro.id });
      const manana = new Date(Date.now() + 30 * HORA).toISOString().slice(0, 10);
      const unica = { branchId: sede, classTypeId: tipo, date: manana, startMinute: 720, durationMin: 60, capacity: 8, coachUserId: coach.id };
      const horario = { branchId: sede, classTypeId: tipo, effectiveFrom: new Date().toISOString(), slots: [{ weekday: 4, startMinute: 1140, durationMin: 60, capacity: 10 }] };

      expect((await pedir(coach.cookie, 'POST', '/classes/types', { name: nombreUnico('Clase') })).statusCode).toBe(403);
      expect((await pedir(coach.cookie, 'POST', '/classes/templates', horario)).statusCode).toBe(403);
      expect((await pedir(coach.cookie, 'POST', '/classes/schedules', unica)).statusCode).toBe(403);
      expect((await pedir(coach.cookie, 'POST', '/classes/schedules/generate', {})).statusCode).toBe(403);
      // El horario sí lo ve.
      expect((await pedir(coach.cookie, 'GET', `/classes/schedules?branchId=${sede}`)).statusCode).toBe(200);
      expect((await pedir(coach.cookie, 'GET', `/classes/templates?branchId=${sede}`)).statusCode).toBe(200);

      await ajustar(coach.id, ['classes:manage']);
      const arma = await loginAs(app, coach.correo);
      const h = await pedir(arma, 'POST', '/classes/templates', horario);
      expect(h.statusCode, h.body).toBe(201);
      expect((await pedir(arma, 'POST', '/classes/schedules', unica)).statusCode).toBe(201);
      // Quien arma el horario de la sede opera cualquier sesión…
      expect((await pedir(arma, 'PATCH', `/classes/schedules/${deOtro}/capacity`, { capacity: 11 })).statusCode).toBe(200);
      // …pero cancelar sigue siendo de la gerencia.
      expect((await pedir(arma, 'POST', `/classes/schedules/${deOtro}/cancel`, { reason: 'No debería poder' })).statusCode).toBe(403);
      expect((await pedir(arma, 'POST', `/classes/templates/${h.json().id}/retire`, { reason: 'No debería poder' })).statusCode).toBe(403);
      expect((await estadoDe(deOtro)).status).toBe('SCHEDULED');
      expect((await pedir(gerente, 'POST', `/classes/templates/${h.json().id}/retire`, { reason: 'Fin de la prueba' })).statusCode).toBe(200);
    });

    it('la migración conserva suplente y cupo a quien ya armaba el horario por persona, y correrla dos veces no duplica', async () => {
      const sql = readFileSync(resolve(import.meta.dirname, '../../gymflow-db/prisma/migrations/20261124040000_coach_codigo_para_sumarse/migration.sql'), 'utf8');
      const paso = sql.slice(sql.indexOf('UPDATE "users"'));
      expect(paso).toMatch(/^UPDATE "users"/);
      const rec = await cuentaDePrueba(g.organizationId, 'RECEPTION', [sede]);
      const sin = await cuentaDePrueba(g.organizationId, 'RECEPTION', [sede]);
      const id = (await getDb().user.findFirstOrThrow({ where: { email: rec } })).id;
      const idSin = (await getDb().user.findFirstOrThrow({ where: { email: sin } })).id;
      await getDb().user.update({ where: { id }, data: { permissionOverrides: { add: ['classes:manage', 'pos:sale:void'], remove: ['pos:sale:create'] } } });
      await getDb().user.update({ where: { id: idSin }, data: { permissionOverrides: { add: ['pos:sale:void'], remove: [] } } });
      await getDb().$executeRawUnsafe(paso);
      await getDb().$executeRawUnsafe(paso);
      const ajustes = async (u: string) => (await getDb().user.findUniqueOrThrow({ where: { id: u } })).permissionOverrides;
      expect(await ajustes(id)).toEqual({ add: ['classes:manage', 'pos:sale:void', 'classes:session:operate'], remove: ['pos:sale:create'] });
      expect(await ajustes(idSin)).toEqual({ add: ['pos:sale:void'], remove: [] });
      const permisos = (await pedir(await loginAs(app, rec), 'GET', '/auth/me')).json().permissions as string[];
      expect(permisos).toContain('classes:session:operate');
      expect(permisos).not.toContain('classes:session:cancel');
    });
  });

  // ── D-29 ──────────────────────────────────────────────────────────────────

  describe('D-29 · de qué coach es cada socio', () => {
    it('recepción elige el coach al alta; después solo la gerencia lo cambia', async () => {
      const [a, b] = [await coachNuevo(), await coachNuevo()];
      // Quien no es coach activo no se puede elegir.
      const mal = await pedir(recepcion, 'POST', '/members', {
        firstName: nombreUnico('Socio'), lastName: nombreUnico('Coach'), phoneE164: telefonoUnico(), homeBranchId: sede, force: true, consents: CONSENTIMIENTOS, coachUserId: g.ownerId,
      });
      expect(mal.statusCode, mal.body).toBe(422);

      const id = await socio({ coachId: a.id });
      expect((await pedir(recepcion, 'GET', `/members/${id}`)).json().coachUserId).toBe(a.id);
      expect(await bitacora('member.coach.at_signup', id)).toBe(1);
      // El coach ya lo ve; el otro coach, no.
      expect((await pedir(a.cookie, 'GET', `/members/${id}`)).statusCode).toBe(200);
      expect((await pedir(b.cookie, 'GET', `/members/${id}`)).statusCode).toBe(404);

      // Después del alta, recepción ya no lo cambia ni lo quita; el coach tampoco.
      for (const cuerpo of [{ coachUserId: b.id }, { coachUserId: null }]) {
        expect((await pedir(recepcion, 'PUT', `/members/${id}/coach`, cuerpo)).statusCode).toBe(403);
        expect((await pedir(a.cookie, 'PUT', `/members/${id}/coach`, cuerpo)).statusCode).toBe(403);
      }
      expect((await pedir(recepcion, 'GET', `/members/${id}`)).json().coachUserId).toBe(a.id);
      // Ni a un socio que quedó sin coach en el alta.
      const sinCoach = await socio();
      expect((await pedir(recepcion, 'PUT', `/members/${sinCoach}/coach`, { coachUserId: a.id })).statusCode).toBe(403);

      // La gerencia sí, y queda en la bitácora con el antes y el después.
      const cambio = await pedir(gerente, 'PUT', `/members/${id}/coach`, { coachUserId: b.id });
      expect(cambio.statusCode, cambio.body).toBe(200);
      expect(cambio.json()).toEqual({ coachUserId: b.id });
      expect((await pedir(a.cookie, 'GET', `/members/${id}`)).statusCode).toBe(404);
      expect((await pedir(b.cookie, 'GET', `/members/${id}`)).statusCode).toBe(200);
      const asiento = await getDb().auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'member.coach', resourceId: id } });
      expect(asiento.beforeState).toEqual({ coachUserId: a.id });
      expect(asiento.afterState).toEqual({ coachUserId: b.id });
      expect((await pedir(gerente, 'PUT', `/members/${id}/coach`, { coachUserId: g.ownerId })).statusCode).toBe(422);
    });

    it('al aprobar un alta por QR, recepción también elige el coach', async () => {
      const coach = await coachNuevo();
      const version = CONSENTIMIENTOS[0]!.documentVersion;
      const borrador = () => ({
        firstName: nombreUnico('Alta'), lastName: nombreUnico('Qr'), phone: telefonoUnico().slice(3), email: null,
        birthDate: '1994-03-08', emergencyContactName: null, emergencyContactPhone: null, memberSince: null, healthNotes: null, adult: true,
        consents: [{ consentType: 'PRIVACY_NOTICE', version, granted: true }, { consentType: 'HOUSE_RULES', version, granted: true }],
      });
      const enviar = async () => { const r = await app.inject({ method: 'POST', url: `/intake/${sede}`, payload: borrador() }); expect(r.statusCode, r.body).toBe(201); return r.json().id as string; };

      const conCoach = await pedir(recepcion, 'POST', `/intakes/${await enviar()}/approve`, { force: true, coachUserId: coach.id });
      expect(conCoach.statusCode, conCoach.body).toBe(201);
      expect((await pedir(recepcion, 'GET', `/members/${conCoach.json().memberId}`)).json().coachUserId).toBe(coach.id);
      expect(await bitacora('member.coach.at_signup', conCoach.json().memberId)).toBe(1);
      // Sin elegirlo, el socio queda sin coach (como antes).
      const sin = await pedir(recepcion, 'POST', `/intakes/${await enviar()}/approve`, { force: true });
      expect(sin.statusCode, sin.body).toBe(201);
      expect((await pedir(recepcion, 'GET', `/members/${sin.json().memberId}`)).json().coachUserId).toBeNull();
      // Con alguien que no es coach, el alta no se aprueba y sigue por revisar.
      const pendiente = await enviar();
      expect((await pedir(recepcion, 'POST', `/intakes/${pendiente}/approve`, { force: true, coachUserId: g.ownerId })).statusCode).toBe(422);
      expect((await getDb().memberIntake.findUniqueOrThrow({ where: { id: pendiente } })).status).toBe('SUBMITTED');
      await getDb().memberIntake.update({ where: { id: pendiente }, data: { status: 'REJECTED', rejectionReason: 'Fin de la prueba', reviewedAt: new Date() } });
    });

    it('«Hacerme su coach»: el socio sin coach genera un código, se lo dicta y el coach se suma; el código sirve una sola vez', async () => {
      const [a, b] = [await coachNuevo(), await coachNuevo()];
      const id = await socio();
      const portal = await portalDe(id);
      // El coach no lo encuentra de ninguna forma antes del código.
      expect((await pedir(a.cookie, 'GET', `/members/${id}`)).statusCode).toBe(404);
      expect((await pedir(portal, 'GET', '/portal/coach')).json()).toEqual({ coach: null, canAskCode: true, code: null, expiresAt: null });

      const antes = Date.now();
      const r = await pedir(portal, 'POST', '/portal/coach/code');
      expect(r.statusCode, r.body).toBe(201);
      const { code, expiresAt } = r.json() as { code: string; expiresAt: string };
      expect(code).toMatch(/^\d{6}$/);
      const vida = new Date(expiresAt).getTime() - antes;
      expect(vida).toBeGreaterThan((COACH_CODE.minutes - 1) * 60_000);
      expect(vida).toBeLessThanOrEqual(COACH_CODE.minutes * 60_000 + 5_000);
      // En la base no está el código, solo su huella.
      const fila = await getDb().coachLinkCode.findFirstOrThrow({ where: { memberId: id } });
      expect(fila.liveKey).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(fila)).not.toContain(code);

      const ok = await teclear(a.cookie, code);
      expect(ok.statusCode, ok.body).toBe(200);
      // Lo que recibe: quién es y su código de socio. Ni teléfono ni correo (D-30).
      expect(Object.keys(ok.json()).sort()).toEqual(['fullName', 'memberCode', 'memberId']);
      expect(ok.json().memberId).toBe(id);
      expect((await pedir(a.cookie, 'GET', `/members/${id}`)).json().coachUserId).toBe(a.id);
      expect((await pedir(a.cookie, 'GET', '/members')).json().members.map((m: { id: string }) => m.id)).toContain(id);
      expect(await bitacora('member.coach.claim', id)).toBe(1);
      const usada = await getDb().coachLinkCode.findUniqueOrThrow({ where: { id: fila.id } });
      expect(usada).toMatchObject({ liveKey: null, usedByUserId: a.id });
      expect(usada.usedAt).not.toBeNull();

      // Un solo uso: el mismo código ya no sirve, ni a él ni a otro coach.
      const otraVez = await teclear(b.cookie, code);
      expect(otraVez.statusCode, otraVez.body).toBe(409);
      expect(otraVez.json().reason).toBe('COACH_CODE_INVALID');
      expect((await pedir(a.cookie, 'GET', `/members/${id}`)).json().coachUserId).toBe(a.id);
      // Y el socio ya tiene coach: no puede generar otro (para cambiar, la gerencia).
      expect((await pedir(portal, 'GET', '/portal/coach')).json()).toMatchObject({ canAskCode: false });
      expect((await pedir(portal, 'GET', '/portal/coach')).json().coach).toBeTruthy();
      const otro = await pedir(portal, 'POST', '/portal/coach/code');
      expect(otro.statusCode, otro.body).toBe(409);
      expect(otro.json().message).toMatch(/Ya tienes coach/);
    });

    it('caduca a los diez minutos, y pedir otro anula el anterior', async () => {
      const coach = await coachNuevo();
      const id = await socio();
      const portal = await portalDe(id);
      const primero = await codigoDe(portal);
      const segundo = await codigoDe(portal);
      expect(await getDb().coachLinkCode.count({ where: { memberId: id, liveKey: { not: null } } })).toBe(1);
      if (primero !== segundo) expect((await teclear(coach.cookie, primero)).statusCode).toBe(409);

      // Once minutos después el segundo ya caducó.
      ponerReloj(new Date(Date.now() + (COACH_CODE.minutes + 1) * 60_000).toISOString());
      const tarde = await teclear(coach.cookie, segundo);
      expect(tarde.statusCode, tarde.body).toBe(409);
      expect(tarde.json().reason).toBe('COACH_CODE_INVALID');
      expect((await getDb().member.findUniqueOrThrow({ where: { id } })).coachUserId).toBeNull();
      // Uno nuevo, generado «entonces», sí sirve.
      const tercero = await codigoDe(portal);
      expect((await teclear(coach.cookie, tercero)).statusCode).toBe(200);
    });

    it('no sirve para descubrir socios: un código que no existe, uno usado y el de un socio que ya tiene coach contestan igual', async () => {
      const [a, b, espia] = [await coachNuevo(), await coachNuevo(), await coachNuevo()];
      // Usado.
      const s1 = await socio();
      const usado = await codigoDe(await portalDe(s1));
      expect((await teclear(a.cookie, usado)).statusCode).toBe(200);
      // De un socio al que la gerencia le puso coach después de generar el código.
      const s2 = await socio();
      const conCoach = await codigoDe(await portalDe(s2));
      expect((await pedir(gerente, 'PUT', `/members/${s2}/coach`, { coachUserId: b.id })).statusCode).toBe(200);

      const sinIntentos = (m: string) => m.replace(/ (Te queda|Te quedan|Ya no te quedan).*$/, '');
      const respuestas = [];
      for (const code of [otroCodigo(usado, conCoach), usado, conCoach]) {
        const r = await teclear(espia.cookie, code);
        expect(r.statusCode, r.body).toBe(409);
        const cuerpo = r.json() as Record<string, unknown>;
        // Nada del socio en la respuesta.
        expect(JSON.stringify(cuerpo)).not.toContain(s1);
        expect(JSON.stringify(cuerpo)).not.toContain(s2);
        respuestas.push({ error: cuerpo.error, reason: cuerpo.reason, message: sinIntentos(String(cuerpo.message)), llaves: Object.keys(cuerpo).filter((k) => k !== 'requestId').sort() });
      }
      expect(respuestas[1]).toEqual(respuestas[0]);
      expect(respuestas[2]).toEqual(respuestas[0]);
      expect(respuestas[0]!.reason).toBe('COACH_CODE_INVALID');
      // No le quitó el socio al otro coach, y el código quedó quemado.
      expect((await getDb().member.findUniqueOrThrow({ where: { id: s2 } })).coachUserId).toBe(b.id);
      expect(await getDb().coachLinkCode.count({ where: { memberId: s2, liveKey: { not: null } } })).toBe(0);
      // Un código mal escrito ni siquiera cuenta: no es un intento.
      expect((await teclear(espia.cookie, '12345')).statusCode).toBe(422);
      expect((await teclear(espia.cookie, 'abcdef')).statusCode).toBe(422);
      expect(await getDb().coachLinkAttempt.count({ where: { userId: espia.id } })).toBe(3);
    });

    it('cinco fallos en una hora dejan al coach en espera, también con un código bueno; a la hora vuelve', async () => {
      const [coach, otro] = [await coachNuevo(), await coachNuevo()];
      const id = await socio();
      const portal = await portalDe(id);
      const bueno = await codigoDe(portal);
      const malo = otroCodigo(bueno);

      const mensajes: string[] = [];
      for (let i = 0; i < COACH_CODE.maxFailures; i++) {
        const r = await teclear(coach.cookie, malo);
        expect(r.statusCode, r.body).toBe(409);
        mensajes.push(r.json().message as string);
      }
      expect(mensajes[0]).toMatch(/Te quedan 4 intentos/);
      expect(mensajes[3]).toMatch(/Te queda 1 intento/);
      expect(mensajes[4]).toMatch(/Ya no te quedan intentos/);
      expect(await bitacora('member.coach.claim.failed', coach.id)).toBe(4);
      expect(await bitacora('member.coach.claim.locked', coach.id)).toBe(1);
      // La bitácora no guarda con qué se intentó.
      const asientos = await getDb().auditLog.findMany({ where: { organizationId: g.organizationId, resourceId: coach.id, action: { startsWith: 'member.coach.claim' } } });
      expect(JSON.stringify(asientos)).not.toContain(malo);

      // En espera: 429 con cuánto falta, aunque ahora teclee el bueno; y el bueno sigue vivo.
      const espera = await teclear(coach.cookie, bueno);
      expect(espera.statusCode, espera.body).toBe(429);
      expect(espera.json().error).toBe('RATE_LIMITED');
      expect(espera.json().retryAfterSeconds).toBeGreaterThan(COACH_CODE.windowMinutes * 60 - 120);
      expect(espera.json().retryAfterSeconds).toBeLessThanOrEqual(COACH_CODE.windowMinutes * 60);
      expect((await getDb().member.findUniqueOrThrow({ where: { id } })).coachUserId).toBeNull();
      expect(await getDb().coachLinkAttempt.count({ where: { userId: coach.id } })).toBe(COACH_CODE.maxFailures);
      // La espera es de ESE coach: otro se suma con el mismo código.
      expect((await teclear(otro.cookie, bueno)).statusCode).toBe(200);

      // Pasada la hora, puede volver a intentar.
      ponerReloj(new Date(Date.now() + (COACH_CODE.windowMinutes + 1) * 60_000).toISOString());
      const nuevo = await socio();
      const codigo = await codigoDe(await portalDe(nuevo));
      expect((await teclear(coach.cookie, codigo)).statusCode).toBe(200);
    });

    it('solo un coach se suma, y solo en su gimnasio', async () => {
      const id = await socio();
      const codigo = await codigoDe(await portalDe(id));
      // Recepción no tiene el permiso; la gerencia lo trae por su puesto pero no es coach (asigna directo).
      expect((await teclear(recepcion, codigo)).statusCode).toBe(403);
      expect((await teclear(gerente, codigo)).statusCode).toBe(403);
      // El coach de OTRO gimnasio con ese mismo código: no sirve y no dice nada.
      const ajeno = await teclear(await loginAs(app, 'coach@demo.mx'), codigo);
      expect(ajeno.statusCode, ajeno.body).toBe(409);
      expect(ajeno.json().reason).toBe('COACH_CODE_INVALID');
      expect((await getDb().member.findUniqueOrThrow({ where: { id } })).coachUserId).toBeNull();
      // Sigue vivo para un coach de su gimnasio.
      const coach = await coachNuevo();
      expect((await teclear(coach.cookie, codigo)).statusCode).toBe(200);
      // Sin sesión de socio no se genera nada.
      expect((await app.inject({ method: 'POST', url: '/portal/coach/code' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/portal/coach' })).statusCode).toBe(401);
    });
  });
});
