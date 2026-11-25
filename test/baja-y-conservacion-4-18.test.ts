import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { MOTIVO_ROSTRO_TRAS_LA_BAJA, uuidv7 } from '@gymflow/core';
import { MemberConservation, PrivacyConservation, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp, loginAs, nombreUnico, telefonoUnico, CONSENTIMIENTOS } from './helpers.js';
import { gimnasioPropio, cargoPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { systemContext } from '../src/platform/jobs/types.js';
import { FaceTemplateRepository } from '../src/modules/access/index.js';
import { ConsentDocumentRepository } from '../src/modules/members/index.js';
import { ConservacionService } from '../src/modules/privacy/index.js';
import { PrivacyService } from '../src/modules/privacy/privacy.service.js';
import { DeudaPerdidaRepository, markLostDebt, marcarDeudaDeAnonimizados } from '../src/modules/billing/deuda-perdida.js';
import { BusinessCalendar } from '../src/platform/time/business-calendar.js';

/**
 * FASE 4 · BLOQUE 4.18 · Baja y conservación (P-01 y P-11, Israel 2026-11-25).
 *
 *  P-01 · La conservación (rostro a los 30 días de la baja y lista mensual)
 *         cuenta también la baja calculada de D-18: canceló, o su membresía
 *         terminó hace el plazo del gimnasio sin renovar.
 *         · EXCEPCIÓN: quien tuvo una entrada dentro del plazo de baja, o
 *           tiene un paquete de visitas vivo, no cuenta.
 *         · ARRANQUE SUAVE: a quien ya era baja calculada el día en que se
 *           activa la regla, los 30 días del rostro le cuentan desde ese día.
 *         · La lista sigue necesitando la firma de la dueña; al firmarse, al
 *           de la baja calculada se le da de baja en su ficha y se anonimiza.
 *  P-11 · Al anonimizar una ficha, su deuda se da por perdida: sale de «Por
 *         cobrar», se suma a «Dada por perdida», no se borra ni se condona.
 *         Lo que ya estaba anonimizado se marca con una corrida repetible.
 *
 * Gimnasio propio por bloque y un «ahora» fijo (T0, mediodía en la Ciudad de
 * México de un día ya pasado) que se le pasa al servicio: nada depende de la
 * hora real. El motor facial se simula.
 */
const vector = (semilla: number) => { const v = Array.from({ length: 512 }, (_, i) => Math.sin((i + 1) * semilla)); const n = Math.hypot(...v); return v.map((x) => x / n); };
const cuadros = (semilla: number) => Array.from({ length: 3 }, () => `S${semilla}|${'x'.repeat(200)}`);
let siguiente = 41 + Math.random();
const semillaNueva = () => { siguiente += 0.613; return Number(siguiente.toFixed(4)); };

const DIA = 86_400_000;
const T0 = new Date('2026-06-15T18:00:00.000Z');
/** El día de T0 en la sede (medianoche UTC, como los guarda la base). */
const HOY = new Date('2026-06-15T00:00:00.000Z');
const masDias = (n: number) => new Date(T0.getTime() + n * DIA);
const hace = (n: number) => new Date(HOY.getTime() - n * DIA);
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('4.18 · baja y conservación (P-01, P-11)', () => {
  let app: FastifyInstance; let motor: Server;
  const servicio = new ConservacionService();
  const db = () => getDb();

  beforeAll(async () => {
    motor = createServer((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', model_loaded: true }));
        const { frames } = JSON.parse(body) as { frames: string[] };
        const m = /^S([0-9.]+)\|/.exec(frames[0] ?? '');
        if (!m) return res.end(JSON.stringify({ ok: false, error: 'No se detectó ningún rostro', liveness_checked: false }));
        res.end(JSON.stringify({ ok: true, embedding: vector(Number(m[1])), liveness_checked: true, liveness_ok: true }));
      });
    }).listen(0);
    const port = (motor.address() as { port: number }).port;
    app = await makeApp({ FACE_SIDECAR_URL: `http://127.0.0.1:${port}` }); await app.ready();
  });
  afterAll(async () => { await app.close(); motor.close(); await closeDb(); });

  async function gimnasio(): Promise<{ g: GimnasioPropio; org: string; sede: string; duena: string; gerente: string; recepcion: string }> {
    const g = await gimnasioPropio();
    const textos = new ConsentDocumentRepository(g.organizationId);
    const b = await textos.create({ consentType: 'BIOMETRIC', version: 'v1.0', title: 'Rostro (prueba)', bodyText: 'Texto de prueba BIOMETRIC' });
    await textos.publish(b.id, null);
    return {
      g, org: g.organizationId, sede: g.sedes[0]!.id,
      duena: await loginAs(app, g.correos.owner), gerente: await loginAs(app, g.correos.gerente), recepcion: await loginAs(app, g.correos.recepcion),
    };
  }
  async function socio(cookie: string, sede: string): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: { firstName: nombreUnico('Baja'), lastName: nombreUnico('Calc'), phoneE164: telefonoUnico(), homeBranchId: sede, consents: CONSENTIMIENTOS },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  async function conRostro(cookie: string, sede: string): Promise<{ memberId: string; enrollmentId: string }> {
    const memberId = await socio(cookie, sede);
    const r = await app.inject({ method: 'POST', url: `/members/${memberId}/biometric-enrollments/face`, headers: { cookie }, payload: { branchId: sede, frames: cuadros(semillaNueva()) } });
    expect(r.statusCode, r.body).toBe(201);
    return { memberId, enrollmentId: r.json().id as string };
  }
  /** Una membresía directo en la base, con su evento si ya terminó (`terminoHaceDias` contado desde el día de T0). */
  async function membresia(x: { org: string; sede: string; plan: string; base?: Date }, memberId: string, status: 'ACTIVE' | 'CANCELED' | 'EXPIRED', terminoHaceDias = 0): Promise<string> {
    const id = uuidv7();
    const termino = new Date((x.base ?? HOY).getTime() - terminoHaceDias * DIA);
    const inicio = new Date(termino.getTime() - 30 * DIA);
    await db().membership.create({
      data: {
        id, organizationId: x.org, memberId, planId: x.plan, soldAtBranchId: x.sede, status,
        startDate: inicio, currentPeriodStart: inicio, currentPeriodEnd: termino, billingAnchorDay: 1,
        ...(status === 'CANCELED' ? { canceledAt: termino, endedAt: termino, cancellationReason: 'Se mudó de ciudad' } : {}),
        ...(status === 'EXPIRED' ? { endedAt: termino } : {}),
      },
    });
    if (status !== 'ACTIVE') {
      await db().membershipEvent.create({
        data: { id: uuidv7(), organizationId: x.org, membershipId: id, eventType: status, fromStatus: 'ACTIVE', toStatus: status, at: termino, businessDate: termino },
      });
    }
    return id;
  }
  /** Una entrada ya registrada ese día (la decisión y su asistencia), sin pasar por la puerta. */
  async function entrada(org: string, sede: string, memberId: string, haceDias: number, base: Date = HOY): Promise<void> {
    const decision = uuidv7();
    const businessDate = new Date(base.getTime() - haceDias * DIA);
    const at = new Date(businessDate.getTime() + 18 * 3_600_000);
    await db().accessDecision.create({ data: { id: decision, organizationId: org, branchId: sede, memberId, outcome: 'GRANTED', credentialKind: 'MANUAL', policyVersion: 'prueba-4.18', businessDate, at } });
    await db().attendanceEvent.create({ data: { id: uuidv7(), organizationId: org, branchId: sede, memberId, accessDecisionId: decision, businessDate, at } });
  }
  const plantillas = (memberId: string) => db().faceTemplate.count({ where: { memberId } });
  const enElPadron = async (org: string, sede: string, memberId: string) => (await new FaceTemplateRepository(org).padron(sede, 'branch')).some((p) => p.memberId === memberId);

  // ── P-01 · el rostro ─────────────────────────────────────────────────────
  it('P-01 · el rostro de la baja calculada se borra a los 30 días, con arranque suave y sin tocar a quien sigue viniendo', async () => {
    const { g, org, sede, gerente } = await gimnasio();
    const x = { org, sede, plan: g.planMensual };
    const a = await conRostro(gerente, sede); await membresia(x, a.memberId, 'EXPIRED', 100);   // baja desde hace 70 días
    const b = await conRostro(gerente, sede); await membresia(x, b.memberId, 'CANCELED', 10);   // baja desde hace 10 días
    const c = await conRostro(gerente, sede); await membresia(x, c.memberId, 'EXPIRED', 100); await entrada(org, sede, c.memberId, 10); // vino hace 10
    const d = await conRostro(gerente, sede); await membresia(x, d.memberId, 'EXPIRED', 100);   // paquete vivo hasta T0+45
    await db().visitPack.create({ data: { id: uuidv7(), organizationId: org, memberId: d.memberId, visitsPurchased: 10, purchasedOn: hace(200), expiresOn: new Date(HOY.getTime() + 45 * DIA), status: 'ACTIVE' } });
    const e = await conRostro(gerente, sede); await membresia(x, e.memberId, 'ACTIVE');          // vigente
    const f = await conRostro(gerente, sede); await membresia(x, f.memberId, 'EXPIRED', 20);    // aún no es baja: lo será en 10 días

    // La vista previa no escribe nada y ya dice quién y cuándo.
    const previa = await servicio.vistaPrevia(org, T0);
    expect(previa.arranqueCalculada).toBeNull();
    expect(await db().privacyCalculatedBajaStart.count({ where: { organizationId: org } })).toBe(0);
    expect(previa.rostros.map((r) => [r.causa, r.bajaEl, r.seBorraEl, r.hoy]).sort()).toEqual([
      ['CANCELED', iso(hace(10)), iso(masDias(30)), false],
      ['EXPIRED', iso(hace(70)), iso(masDias(30)), false],
    ]);
    expect(previa.exceptuados.map((r) => [r.porque, r.contaraDesde]).sort()).toEqual([['ENTRADA_RECIENTE', iso(masDias(20))], ['PAQUETE_VIVO', null]]);

    // Primera pasada: fija el arranque de la baja calculada y no borra nada.
    const p0 = await servicio.pasada(org, T0);
    expect(p0.rostrosBorrados).toBe(0);
    expect(iso((await db().privacyCalculatedBajaStart.findUniqueOrThrow({ where: { organizationId: org } })).startedOn)).toBe(iso(HOY));
    const inicio = await db().auditLog.findMany({ where: { organizationId: org, action: 'privacy.conservation.calculated.start' } });
    expect(inicio).toHaveLength(1);
    expect(inicio[0]!.afterState).toMatchObject({ startedOn: iso(HOY), calculatedBajas: 2, facesWaiting: 2, churnDays: 30 });
    // Repetida: ni otro arranque ni otro asiento.
    await servicio.pasada(org, T0);
    expect(await db().auditLog.count({ where: { organizationId: org, action: 'privacy.conservation.calculated.start' } })).toBe(1);
    // El padrón de la cámara no cambió: la baja calculada se sigue reconociendo hasta borrarse (decisión menor).
    expect(await enElPadron(org, sede, a.memberId)).toBe(true);

    // Día 29 del arranque: nada.
    expect((await servicio.pasada(org, masDias(29))).rostrosBorrados).toBe(0);
    // Día 30: los dos de la baja calculada anterior al arranque, el mismo día.
    expect((await servicio.pasada(org, masDias(30))).rostrosBorrados).toBe(2);
    expect([await plantillas(a.memberId), await plantillas(b.memberId)]).toEqual([0, 0]);
    expect([await plantillas(c.memberId), await plantillas(d.memberId), await plantillas(e.memberId), await plantillas(f.memberId)]).toEqual([1, 1, 1, 1]);
    const revocado = await db().biometricEnrollment.findUniqueOrThrow({ where: { id: a.enrollmentId } });
    expect(revocado.revokedAt).not.toBeNull();
    expect(revocado.templateDeletedAt).not.toBeNull();
    // Solo el rostro: la ficha sigue con nombre y sin dar de baja.
    const fichaA = await db().member.findUniqueOrThrow({ where: { id: a.memberId } });
    expect([fichaA.deletedAt, fichaA.anonymizedAt, fichaA.firstName.startsWith('Baja')]).toEqual([null, null, true]);
    const rev = await db().auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'access.biometric.revoke', resourceId: a.enrollmentId } });
    expect([rev.reason, rev.actorType]).toEqual([MOTIVO_ROSTRO_TRAS_LA_BAJA, 'SYSTEM']);

    // F es baja desde el día 10 y su rostro se va el 40 (después del arranque: cuenta desde su baja).
    expect((await servicio.pasada(org, masDias(39))).rostrosBorrados).toBe(0);
    expect((await servicio.pasada(org, masDias(40))).rostrosBorrados).toBe(1);
    expect(await plantillas(f.memberId)).toBe(0);
    // C vino hace 10 días: cuenta desde el día 20 y su rostro se va el 50. D, con paquete vivo, no.
    expect((await servicio.pasada(org, masDias(49))).rostrosBorrados).toBe(0);
    expect((await servicio.pasada(org, masDias(50))).rostrosBorrados).toBe(1);
    expect(await plantillas(c.memberId)).toBe(0);
    // El paquete de D caduca el día 45: ese día cuenta como su última visita → baja el 75, rostro el 105.
    await db().visitPack.updateMany({ where: { memberId: d.memberId }, data: { status: 'EXPIRED', expiredAt: masDias(45) } });
    expect((await servicio.pasada(org, masDias(104))).rostrosBorrados).toBe(0);
    expect((await servicio.pasada(org, masDias(105))).rostrosBorrados).toBe(1);
    expect(await plantillas(d.memberId)).toBe(0);
    // El vigente, nunca.
    expect((await servicio.pasada(org, masDias(400))).rostrosBorrados).toBe(0);
    expect(await plantillas(e.memberId)).toBe(1);
    await g.cerrar();
  });

  it('P-01 · lo que ve la gerencia: «a quién se le borra el rostro y cuándo», y la ficha de cada socio', async () => {
    const { g, org, sede, gerente, duena, recepcion } = await gimnasio();
    // Esta prueba pasa por la API, que usa el reloj de verdad: las fechas se cuentan desde el hoy de la sede.
    const hoyReal = await new BusinessCalendar(org).today(sede);
    const x = { org, sede, plan: g.planMensual, base: hoyReal };
    const a = await conRostro(gerente, sede); await membresia(x, a.memberId, 'CANCELED', 5);
    const c = await conRostro(gerente, sede); await membresia(x, c.memberId, 'EXPIRED', 100); await entrada(org, sede, c.memberId, 3, hoyReal);
    const z = await conRostro(gerente, sede);
    await app.inject({ method: 'POST', url: `/members/${z.memberId}/archive`, headers: { cookie: gerente }, payload: { reason: 'Pidió su baja' } });
    await servicio.pasada(org, new Date());

    const r = await app.inject({ method: 'GET', url: '/privacy/conservation', headers: { cookie: gerente } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(PrivacyConservation, r.json())).toEqual([]);
    const estado = r.json() as PrivacyConservation;
    expect(estado.calculatedStartedOn).not.toBeNull();
    expect(estado.churnDays).toBe(30);
    expect(estado.faces.waiting).toBe(2);
    const items = [...estado.faces.items].sort((p, q) => p.cause.localeCompare(q.cause));
    expect(items.map((i) => [i.memberId, i.cause, i.fullName !== null])).toEqual([[z.memberId, 'ARCHIVED', true], [a.memberId, 'CANCELED', true]]);
    expect(items.every((i) => i.deletesOn !== null)).toBe(true);
    // La dueña ve la cifra y los códigos, sin nombres.
    const deLaDuena = (await app.inject({ method: 'GET', url: '/privacy/conservation', headers: { cookie: duena } })).json() as PrivacyConservation;
    expect(deLaDuena.faces.waiting).toBe(2);
    expect(deLaDuena.faces.items.every((i) => i.fullName === null)).toBe(true);

    // La ficha: la baja que cuenta, la que todavía no (y por qué), y cuándo se va el rostro.
    const ficha = async (cookie: string, id: string) => {
      const res = await app.inject({ method: 'GET', url: `/members/${id}/conservation`, headers: { cookie } });
      expect(res.statusCode, res.body).toBe(200);
      expect(diferenciasConElContrato(MemberConservation, res.json())).toEqual([]);
      return res.json() as MemberConservation;
    };
    const fa = await ficha(gerente, a.memberId);
    expect(fa.baja).toMatchObject({ cause: 'CANCELED', counts: true, exception: null });
    expect(fa.face.stored).toBe(true);
    expect(fa.face.deletesOn).not.toBeNull();
    expect(fa.listFrom).not.toBeNull();
    const fc = await ficha(recepcion, c.memberId);
    expect(fc.baja).toMatchObject({ cause: 'EXPIRED', counts: false, exception: 'ENTRADA_RECIENTE', since: null });
    expect(fc.baja!.countsFrom).not.toBeNull();
    expect(fc.face).toEqual({ stored: true, deletesOn: null });
    expect(fc.listFrom).toBeNull();
    // Un socio cualquiera: no es baja.
    const nuevo = await socio(gerente, sede);
    expect((await ficha(gerente, nuevo)).baja).toBeNull();
    // Recepción de otra sede no la ve; un id de otro gimnasio, 404.
    const otro = await gimnasioPropio();
    expect((await app.inject({ method: 'GET', url: `/members/${a.memberId}/conservation`, headers: { cookie: await loginAs(app, otro.correos.recepcion) } })).statusCode).toBe(404);
    await otro.cerrar();
    await g.cerrar();
  });

  // ── P-01 · la lista ──────────────────────────────────────────────────────
  it('P-01 · la lista mensual trae la baja calculada (con la excepción), espera la firma y al firmar da de baja y anonimiza', async () => {
    const { g, org, sede, gerente, duena } = await gimnasio();
    const x = { org, sede, plan: g.planMensual };
    expect((await app.inject({ method: 'PUT', url: '/privacy/settings', headers: { cookie: gerente }, payload: { monthsAfterArchive: 1 } })).statusCode).toBe(200);
    const cancelado = await socio(gerente, sede); const mCancelado = await membresia(x, cancelado, 'CANCELED', 60);
    const deuda = await cargoPropio(g, cancelado, 45_000n, g.sedes[0]!, hace(60));
    const sigueViniendo = await socio(gerente, sede); await membresia(x, sigueViniendo, 'EXPIRED', 120); await entrada(org, sede, sigueViniendo, 10);
    const archivado = await socio(gerente, sede);
    await app.inject({ method: 'POST', url: `/members/${archivado}/archive`, headers: { cookie: gerente }, payload: { reason: 'Pidió su baja' } });
    await db().$executeRaw`UPDATE "members" SET "deletedAt" = ${hace(60)} WHERE "id" = ${archivado}::uuid`;
    const renueva = await socio(gerente, sede); await membresia(x, renueva, 'CANCELED', 60);
    const vuelve = await socio(gerente, sede); await membresia(x, vuelve, 'CANCELED', 60);

    await servicio.pasada(org, T0);
    const lista = await db().privacyBatch.findFirstOrThrow({ where: { organizationId: org, status: 'PENDING' } });
    const renglones = await db().privacyBatchItem.findMany({ where: { batchId: lista.id } });
    const porSocio = new Map(renglones.map((r) => [r.memberId, r]));
    expect(porSocio.get(cancelado)).toMatchObject({ bajaCause: 'CANCELED', status: 'LISTED' });
    expect(iso(porSocio.get(cancelado)!.archivedOn)).toBe(iso(hace(60)));
    expect(porSocio.get(archivado)).toMatchObject({ bajaCause: 'ARCHIVED' });
    expect(porSocio.has(sigueViniendo)).toBe(false);
    expect(renglones).toHaveLength(4);
    // Armar la lista no anonimiza ni da de baja a nadie.
    expect((await db().member.findUniqueOrThrow({ where: { id: cancelado } })).deletedAt).toBeNull();
    // La pantalla dice de qué baja entró cada uno.
    const estado = (await app.inject({ method: 'GET', url: '/privacy/conservation', headers: { cookie: gerente } })).json() as PrivacyConservation;
    expect(estado.batch!.items.find((i) => i.memberId === cancelado)!.cause).toBe('CANCELED');

    // Antes de la firma: uno renueva y otro vuelve a venir.
    await membresia(x, renueva, 'ACTIVE');
    await entrada(org, sede, vuelve, 1);
    const antes = (await app.inject({ method: 'GET', url: '/portfolio', headers: { cookie: gerente } })).json() as { totalOutstandingCents: string; lostCents: string };

    const firma = await app.inject({ method: 'POST', url: '/privacy/conservation/sign', headers: { cookie: duena }, payload: { batchId: lista.id, password: 'GymFlow.dev.2026' } });
    expect(firma.statusCode, firma.body).toBe(200);
    const despues = await db().privacyBatchItem.findMany({ where: { batchId: lista.id } });
    const estadoDe = new Map(despues.map((r) => [r.memberId, [r.status, r.note]]));
    expect(estadoDe.get(cancelado)).toEqual(['ANONYMIZED', null]);
    expect(estadoDe.get(archivado)).toEqual(['ANONYMIZED', null]);
    expect(estadoDe.get(renueva)).toEqual(['SKIPPED', 'RETURNED']);
    expect(estadoDe.get(vuelve)).toEqual(['SKIPPED', 'RETURNED']);
    // Al de la baja calculada se le dio de baja en su ficha (sistema, con la firma de la dueña) y se anonimizó.
    const ficha = await db().member.findUniqueOrThrow({ where: { id: cancelado } });
    expect(ficha.deletedAt).not.toBeNull();
    expect(ficha.anonymizedAt).not.toBeNull();
    expect(ficha.firstName).toBe('Socio');
    const baja = await db().auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'member.archive', resourceId: cancelado } });
    expect(baja.actorType).toBe('SYSTEM');
    expect(baja.approvedByUserId).toBe(g.ownerId);
    expect(baja.afterState).toMatchObject({ bajaCause: 'CANCELED' });
    expect((await db().membership.findUniqueOrThrow({ where: { id: mCancelado } })).status).toBe('CANCELED');

    // P-11 dentro de la firma: su deuda se dio por perdida, sin borrarse ni condonarse.
    const cargo = await db().charge.findUniqueOrThrow({ where: { id: deuda } });
    expect(cargo.lostOn).not.toBeNull();
    expect([cargo.status, cargo.amountCents - cargo.allocatedCents - cargo.adjustedCents]).toEqual(['OPEN', 45_000n]);
    const ahora = (await app.inject({ method: 'GET', url: '/portfolio', headers: { cookie: gerente } })).json() as { totalOutstandingCents: string; lostCents: string };
    expect(BigInt(antes.totalOutstandingCents) - BigInt(ahora.totalOutstandingCents)).toBe(45_000n);
    expect(BigInt(ahora.lostCents) - BigInt(antes.lostCents)).toBe(45_000n);
    const asiento = await db().auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'billing.debt.lost', resourceId: cancelado } });
    expect(asiento.afterState).toMatchObject({ amountCents: '45000', cause: 'ANONYMIZED' });
    // El que renovó y el que volvió siguen intactos.
    expect((await db().member.findUniqueOrThrow({ where: { id: renueva } })).anonymizedAt).toBeNull();
    expect((await db().member.findUniqueOrThrow({ where: { id: vuelve } })).deletedAt).toBeNull();
    await g.cerrar();
  });

  // ── P-11 ─────────────────────────────────────────────────────────────────
  it('P-11 · al anonimizar (ARCO), su deuda se da por perdida en ese momento; lo ya perdido conserva su día', async () => {
    const { g, org, sede, gerente } = await gimnasio();
    const id = await socio(gerente, sede);
    const c1 = await cargoPropio(g, id, 30_000n, g.sedes[0]!, hace(40));
    const c2 = await cargoPropio(g, id, 20_000n, g.sedes[0]!, hace(10));
    const c3 = await cargoPropio(g, id, 5_000n, g.sedes[0]!, hace(200));
    await db().charge.update({ where: { id: c3 }, data: { lostOn: hace(100) } });
    await app.inject({ method: 'POST', url: `/members/${id}/archive`, headers: { cookie: gerente }, payload: { reason: 'Pidió su baja' } });
    const antes = (await app.inject({ method: 'GET', url: '/portfolio', headers: { cookie: gerente } })).json() as { totalOutstandingCents: string; lostCents: string };

    await new PrivacyService().anonymize(systemContext(org), id, 'Cancelación ARCO (prueba)', g.ownerId, T0);
    const [a1, a2, a3] = await Promise.all([c1, c2, c3].map((c) => db().charge.findUniqueOrThrow({ where: { id: c } })));
    expect([iso(a1!.lostOn!), iso(a2!.lostOn!), iso(a3!.lostOn!)]).toEqual([iso(HOY), iso(HOY), iso(hace(100))]);
    expect([a1!.status, a2!.status]).toEqual(['OPEN', 'OPEN']);
    const despues = (await app.inject({ method: 'GET', url: '/portfolio', headers: { cookie: gerente } })).json() as { totalOutstandingCents: string; lostCents: string };
    expect(BigInt(antes.totalOutstandingCents) - BigInt(despues.totalOutstandingCents)).toBe(50_000n);
    expect(BigInt(despues.lostCents) - BigInt(antes.lostCents)).toBe(50_000n);
    const asientos = await db().auditLog.findMany({ where: { organizationId: org, action: 'billing.debt.lost', resourceId: id } });
    expect(asientos).toHaveLength(1);
    expect(asientos[0]!.afterState).toMatchObject({ amountCents: '50000', cause: 'ANONYMIZED', lostOn: iso(HOY) });
    expect((await db().auditLog.findFirstOrThrow({ where: { organizationId: org, action: 'member.anonymize', resourceId: id } })).afterState).toMatchObject({ debtLostCents: '50000' });
    // Sin deuda, no deja asiento de deuda.
    const limpio = await socio(gerente, sede);
    await app.inject({ method: 'POST', url: `/members/${limpio}/archive`, headers: { cookie: gerente }, payload: { reason: 'Pidió su baja' } });
    await new PrivacyService().anonymize(systemContext(org), limpio, 'Cancelación ARCO (prueba)', g.ownerId, T0);
    expect(await db().auditLog.count({ where: { organizationId: org, action: 'billing.debt.lost', resourceId: limpio } })).toBe(0);
    await g.cerrar();
  });

  it('P-11 · las fichas YA anonimizadas: se cuentan sin escribir y se marcan con una corrida que se puede repetir (también la del cierre)', async () => {
    const { g, org, sede, gerente } = await gimnasio();
    // Como quedaron antes de 4.18: anonimizadas con su deuda en «Por cobrar».
    const viejo = await socio(gerente, sede);
    const c = await cargoPropio(g, viejo, 70_000n, g.sedes[0]!, hace(300));
    await db().$executeRaw`UPDATE "members" SET "status" = 'ARCHIVED', "deletedAt" = ${hace(400)}, "anonymizedAt" = ${hace(30)}, "firstName" = 'Socio', "lastName" = 'anonimizado', "phoneE164" = NULL WHERE "id" = ${viejo}::uuid`;
    const vivo = await socio(gerente, sede);
    await cargoPropio(g, vivo, 10_000n);

    const repo = new DeudaPerdidaRepository(org);
    const cuenta = await repo.deAnonimizados();
    expect(cuenta.map((x) => [x.memberId, x.balanceCents])).toEqual([[viejo, 70_000n]]);
    // Contar no escribe.
    expect((await db().charge.findUniqueOrThrow({ where: { id: c } })).lostOn).toBeNull();

    const dia = (await new BusinessCalendar(org).dias(T0)).gimnasio;
    const r1 = await marcarDeudaDeAnonimizados(org, dia);
    expect([r1.members, r1.charges, r1.amountCents, r1.errores]).toEqual([1, 1, 70_000n, []]);
    expect(iso((await db().charge.findUniqueOrThrow({ where: { id: c } })).lostOn!)).toBe(iso(dia));
    const resumen = await db().auditLog.findMany({ where: { organizationId: org, action: 'billing.debt.lost.anonymized' } });
    expect(resumen).toHaveLength(1);
    expect(resumen[0]!.afterState).toMatchObject({ amountCents: '70000', charges: 1, members: 1 });
    // Dos veces: nada nuevo.
    expect((await marcarDeudaDeAnonimizados(org, dia)).charges).toBe(0);
    expect(await db().auditLog.count({ where: { organizationId: org, action: 'billing.debt.lost.anonymized' } })).toBe(1);
    // El cierre diario corre lo mismo y tampoco encuentra nada; la deuda del socio vivo no se toca.
    const job = await markLostDebt(org);
    expect(job.errors).toEqual([]);
    expect(await db().auditLog.count({ where: { organizationId: org, action: 'billing.debt.lost.anonymized' } })).toBe(1);
    expect(await db().charge.count({ where: { organizationId: org, memberId: vivo, lostOn: { not: null } } })).toBe(0);

    // Un anonimizado nuevo con deuda que quedó sin marcar (un fallo al anonimizar): lo recoge el cierre.
    const otro = await socio(gerente, sede);
    await cargoPropio(g, otro, 15_000n);
    await db().$executeRaw`UPDATE "members" SET "status" = 'ARCHIVED', "deletedAt" = ${hace(10)}, "anonymizedAt" = ${hace(1)} WHERE "id" = ${otro}::uuid`;
    await markLostDebt(org);
    expect(await db().charge.count({ where: { organizationId: org, memberId: otro, lostOn: { not: null } } })).toBe(1);
    expect(await db().auditLog.count({ where: { organizationId: org, action: 'billing.debt.lost.anonymized' } })).toBe(2);
    await g.cerrar();
  });
});
