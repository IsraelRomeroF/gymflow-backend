import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@gymflow/core';
import { FollowUpLatest, OutboundMarked, OutboundMessages, OutboundSummary, diferenciasConElContrato } from '@gymflow/core/contracts';
import { makeApp, loginAs, cuentaDePrueba, telefonoUnico } from './helpers.js';
import { gimnasioPropio, sesionesDe, socioPropio, type GimnasioPropio, type SedePropia } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { BusinessCalendar } from '../src/platform/time/business-calendar.js';
import { OutboundService } from '../src/modules/outbound/index.js';
import { textoDelMensaje, detalleDelMensaje } from '../src/modules/outbound/plantillas.js';

const MS_DIA = 86_400_000;
type Lista = OutboundMessages;

/**
 * BANDEJA DE SALIDA (auditoría 8, fase 2, bloque 2.9; 25-10, 15-08, 28-14).
 *
 * Gimnasio propio con dos sedes: aquí se cuentan mensajes exactos y se corre
 * el job de verdad. Los hechos (cargos, membresías) se siembran directo en la
 * base; cobrar y vencer tienen sus propias pruebas.
 */
describe('bandeja de salida: qué mensajes nacen, quién los ve y qué pasa al mandarlos', () => {
  let app: FastifyInstance;
  let g: GimnasioPropio;
  let centro: SedePropia;
  let norte: SedePropia;
  let s: { owner: string; gerente: string; recepcion: string; recepcionSinLlave: string; coach: string };
  let hoy: Date;
  let prepago: string;
  const dias = (n: number) => new Date(hoy.getTime() + n * MS_DIA);

  /** Un socio con celular (o sin él) en una sede, dado de alta hace `altaHaceDias`. */
  async function socio(sede: SedePropia, opts: { celular?: boolean; altaHaceDias?: number } = {}): Promise<string> {
    const id = await socioPropio(g, sede);
    await getDb().member.update({
      where: { id },
      data: { phoneE164: opts.celular === false ? null : telefonoUnico(), joinedAt: new Date(Date.now() - (opts.altaHaceDias ?? 3) * MS_DIA) },
    });
    return id;
  }
  async function cargo(memberId: string, sede: SedePropia, status: 'OPEN' | 'OVERDUE', vence: Date, centavos = 60_000n): Promise<string> {
    const c = await getDb().charge.create({
      data: {
        id: uuidv7(), organizationId: g.organizationId, memberId, branchId: sede.id, chargeType: 'MANUAL_ADJUSTMENT', status,
        concept: 'Mensualidad', subtotalCents: centavos, taxCents: 0n, discountCents: 0n, amountCents: centavos, dueDate: vence, issuedAt: new Date(),
      },
    });
    return c.id;
  }
  async function membresia(memberId: string, sede: SedePropia, opts: { status?: 'ACTIVE' | 'SUSPENDED'; termina: Date; autoRenew: boolean; planId?: string }): Promise<string> {
    const inicio = new Date(opts.termina.getTime() - 30 * MS_DIA);
    const m = await getDb().membership.create({
      data: {
        id: uuidv7(), organizationId: g.organizationId, memberId, planId: opts.planId ?? g.planMensual, soldAtBranchId: sede.id, status: opts.status ?? 'ACTIVE',
        startDate: inicio, currentPeriodStart: inicio, currentPeriodEnd: opts.termina, billingAnchorDay: inicio.getUTCDate(), autoRenew: opts.autoRenew,
      },
    });
    return m.id;
  }
  const lista = async (cookie: string, query = ''): Promise<Lista> => {
    const r = await app.inject({ method: 'GET', url: `/outbound/messages${query}`, headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(OutboundMessages, r.json())).toEqual([]);
    return r.json() as Lista;
  };
  const marcar = (cookie: string, memberId: string, messageId: string, como: 'SENT' | 'DISMISSED') =>
    app.inject({ method: 'POST', url: `/members/${memberId}/outbound-messages/mark`, headers: { cookie }, payload: { messageId, as: como } });
  const de = (l: Lista, memberId: string) => l.pending.filter((m) => m.memberId === memberId);
  const correr = () => new OutboundService().generar(g.organizationId);

  const quien: Record<'vencido' | 'porVencer' | 'suspendida' | 'termina' | 'renueva' | 'sinCelular' | 'noArranco' | 'vencidoNorte' | 'planCorto', string> = {
    vencido: '', porVencer: '', suspendida: '', termina: '', renueva: '', sinCelular: '', noArranco: '', vencidoNorte: '', planCorto: '',
  };
  let cargoVencido = '';

  beforeAll(async () => {
    app = await makeApp();
    g = await gimnasioPropio({ sedes: [{ name: 'Centro', cajas: 1 }, { name: 'Norte', cajas: 1 }] });
    [centro, norte] = g.sedes as [SedePropia, SedePropia];
    hoy = await new BusinessCalendar(g.organizationId).today(null);
    const db = getDb();
    prepago = uuidv7();
    await db.plan.create({
      data: { id: prepago, organizationId: g.organizationId, code: 'TRIM', name: 'Trimestre', billingModel: 'PREPAID_PERIOD', durationUnit: 'MONTH', durationValue: 3, priceCents: 150_000n },
    });

    quien.vencido = await socio(centro);
    cargoVencido = await cargo(quien.vencido, centro, 'OVERDUE', dias(-2));
    quien.porVencer = await socio(centro);
    await cargo(quien.porVencer, centro, 'OPEN', dias(2));
    // Suspendida Y con un cargo vencido: solo debe quedar el mensaje de la suspensión.
    quien.suspendida = await socio(centro);
    await membresia(quien.suspendida, centro, { status: 'SUSPENDED', termina: dias(-5), autoRenew: true });
    await cargo(quien.suspendida, centro, 'OVERDUE', dias(-6));
    quien.termina = await socio(centro);
    await membresia(quien.termina, centro, { termina: dias(2), autoRenew: false, planId: prepago });
    quien.renueva = await socio(centro);
    await membresia(quien.renueva, centro, { termina: dias(3), autoRenew: true });
    quien.sinCelular = await socio(centro, { celular: false });
    await cargo(quien.sinCelular, centro, 'OVERDUE', dias(-1));
    // Alta hace 25 días, membresía viva y ninguna visita: Retención lo tiene como «No arrancó».
    quien.noArranco = await socio(centro, { altaHaceDias: 25 });
    await membresia(quien.noArranco, centro, { termina: dias(20), autoRenew: true });
    quien.vencidoNorte = await socio(norte);
    await cargo(quien.vencidoNorte, norte, 'OVERDUE', dias(-3));
    // Un periodo de tres días que termina mañana (pase corto): no merece recordatorio.
    quien.planCorto = await socio(centro);
    const corta = await membresia(quien.planCorto, centro, { termina: dias(1), autoRenew: false, planId: prepago });
    await db.membership.update({ where: { id: corta }, data: { currentPeriodStart: dias(-2), startDate: dias(-2) } });

    const sesiones = await sesionesDe(app, g);
    s = {
      owner: sesiones.owner, gerente: sesiones.gerente, recepcion: sesiones.recepcion,
      // `cuentaDePrueba` nace sin secciones liberadas: recepción sin la llave de Retención.
      recepcionSinLlave: await loginAs(app, await cuentaDePrueba(g.organizationId, 'RECEPTION', [centro.id])),
      coach: await loginAs(app, await cuentaDePrueba(g.organizationId, 'COACH', [centro.id])),
    };
  });

  afterAll(async () => {
    await g.cerrar();
    await app.close();
    await closeDb();
  });

  it('el job arma un mensaje por hecho, uno por socio, y correrlo otra vez no duplica', async () => {
    const primera = await correr();
    expect(primera.errors).toEqual([]);
    const db = getDb();
    const todos = await db.outboundMessage.findMany({ where: { organizationId: g.organizationId } });
    const pendientesDe = (memberId: string) => todos.filter((m) => m.memberId === memberId && m.status === 'PENDING').map((m) => m.kind);
    expect(pendientesDe(quien.vencido)).toEqual(['PAYMENT_OVERDUE']);
    expect(pendientesDe(quien.porVencer)).toEqual(['PAYMENT_DUE_SOON']);
    expect(pendientesDe(quien.termina)).toEqual(['MEMBERSHIP_ENDING']);
    expect(pendientesDe(quien.renueva)).toEqual(['PAYMENT_DUE_SOON']);
    expect(pendientesDe(quien.noArranco)).toEqual(['WE_MISS_YOU']);
    expect(pendientesDe(quien.vencidoNorte)).toEqual(['PAYMENT_OVERDUE']);
    // Sin celular no hay a dónde mandar; un periodo de tres días no se recuerda.
    expect(todos.filter((m) => m.memberId === quien.sinCelular)).toEqual([]);
    expect(todos.filter((m) => m.memberId === quien.planCorto)).toEqual([]);
    // La suspendida tenía además un cargo vencido: queda el más grave y el otro se cierra como reemplazado.
    expect(pendientesDe(quien.suspendida)).toEqual(['MEMBERSHIP_SUSPENDED']);
    const reemplazado = todos.find((m) => m.memberId === quien.suspendida && m.kind === 'PAYMENT_OVERDUE');
    expect(reemplazado?.status).toBe('EXPIRED');
    expect(reemplazado?.closeReason).toBe('SUPERSEDED');
    // Todo nace por el único canal de hoy y sin texto guardado: el texto se congela al mandar.
    expect(todos.every((m) => m.channel === 'WHATSAPP_LINK' && m.body === null)).toBe(true);

    const segunda = await correr();
    expect(segunda.errors).toEqual([]);
    expect(segunda.processed).toBe(0);
    expect(await db.outboundMessage.count({ where: { organizationId: g.organizationId } })).toBe(todos.length);
  });

  it('gerencia ve todo el gimnasio, lo más grave primero, con el texto ya escrito', async () => {
    const l = await lista(s.gerente);
    expect(l.total).toBe(7);
    expect(l.counts).toEqual({ MEMBERSHIP_SUSPENDED: 1, PAYMENT_OVERDUE: 2, PAYMENT_DUE_SOON: 2, MEMBERSHIP_ENDING: 1, WE_MISS_YOU: 1, PRICE_CHANGE: 0 });
    expect(l.pending[0]!.kind).toBe('MEMBERSHIP_SUSPENDED');
    expect(l.pending.at(-1)!.kind).toBe('WE_MISS_YOU');
    const org = await getDb().organization.findUniqueOrThrow({ where: { id: g.organizationId } });
    const [vencido] = de(l, quien.vencido);
    // Dos sedes: el saludo dice de cuál.
    expect(vencido!.text).toContain(`te escribimos de ${org.tradeName} (Centro)`);
    expect(vencido!.text).toContain('$600.00');
    expect(vencido!.detail).toContain('venció el');
    expect(vencido!.phoneE164).toMatch(/^\+\d+$/);
    expect(vencido!.status).toBe('PENDING');
    const [renueva] = de(l, quien.renueva);
    expect(renueva!.text).toContain('tu siguiente pago de Mensual es el');
    expect(renueva!.text).not.toContain('$');
    const [termina] = de(l, quien.termina);
    expect(termina!.text).toContain('Tu plan Trimestre termina el');
    expect(l.sentToday).toEqual([]);

    const r = await app.inject({ method: 'GET', url: '/outbound/summary', headers: { cookie: s.gerente } });
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(OutboundSummary, r.json())).toEqual([]);
    expect(r.json()).toEqual({ total: 7, counts: l.counts, sentToday: 0 });
  });

  it('recepción ve solo su sede; sin la llave de Retención no ve los «te extrañamos»', async () => {
    const suya = await lista(s.recepcion);
    expect(suya.total).toBe(6);
    expect(de(suya, quien.vencidoNorte)).toEqual([]);
    expect(de(suya, quien.noArranco)).toHaveLength(1);

    const sinLlave = await lista(s.recepcionSinLlave);
    expect(sinLlave.total).toBe(5);
    expect(sinLlave.counts.WE_MISS_YOU).toBe(0);
    expect(de(sinLlave, quien.noArranco)).toEqual([]);

    // Pedir otra sede no la abre.
    const ajena = await app.inject({ method: 'GET', url: `/outbound/messages?branchId=${norte.id}`, headers: { cookie: s.recepcion } });
    expect(ajena.statusCode).toBe(403);
    // Gerencia, filtrando una sede.
    const norteSolo = await lista(s.gerente, `?branchId=${norte.id}`);
    expect(norteSolo.pending.map((m) => m.memberId)).toEqual([quien.vencidoNorte]);
    // `limit` recorta cada motivo, no la lista: ningún grupo tapa a otro, y las cifras van completas.
    const deAUno = await lista(s.gerente, '?limit=1');
    expect(deAUno.pending.map((m) => m.kind)).toEqual(['MEMBERSHIP_SUSPENDED', 'PAYMENT_OVERDUE', 'PAYMENT_DUE_SOON', 'MEMBERSHIP_ENDING', 'WE_MISS_YOU']);
    expect(deAUno.total).toBe(7);
    expect(deAUno.counts.PAYMENT_OVERDUE).toBe(2);
    // `kind` trae un solo motivo (lo que pide Retención).
    const soloRiesgo = await lista(s.gerente, '?kind=WE_MISS_YOU');
    expect(soloRiesgo.pending.map((m) => m.memberId)).toEqual([quien.noArranco]);
  });

  it('ni la dueña ni el coach tienen lista, campana ni botón (D-30, ADR-039)', async () => {
    for (const cookie of [s.owner, s.coach]) {
      expect((await app.inject({ method: 'GET', url: '/outbound/messages', headers: { cookie } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/outbound/summary', headers: { cookie } })).statusCode).toBe(403);
      const [m] = de(await lista(s.gerente), quien.vencido);
      // Al coach la ficha de un socio que no es suyo ni siquiera le existe (404 antes que el permiso).
      expect((await marcar(cookie, quien.vencido, m!.id, 'SENT')).statusCode).toBe(cookie === s.coach ? 404 : 403);
    }
  });

  it('mandar deja quién, cuándo y el texto que se mandó; dos toques no lo mandan dos veces', async () => {
    const [m] = de(await lista(s.recepcion), quien.porVencer);
    const r = await marcar(s.recepcion, quien.porVencer, m!.id, 'SENT');
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(OutboundMarked, r.json())).toEqual([]);
    const mandado = (r.json() as OutboundMarked).message;
    expect(mandado.status).toBe('SENT');
    expect(mandado.text).toBe(m!.text);
    expect(mandado.resolvedAt).not.toBeNull();
    expect(mandado.resolvedByName).toBeTruthy();

    const guardado = await getDb().outboundMessage.findUniqueOrThrow({ where: { id: m!.id } });
    expect(guardado.body).toBe(m!.text);
    expect(await getDb().auditLog.count({ where: { organizationId: g.organizationId, action: 'member.message.send', resourceId: quien.porVencer } })).toBe(1);
    // Un pago por vencer no es un contacto de Retención.
    expect(await getDb().followUp.count({ where: { organizationId: g.organizationId, memberId: quien.porVencer } })).toBe(0);

    const otra = await marcar(s.recepcion, quien.porVencer, m!.id, 'SENT');
    expect(otra.statusCode).toBe(409);

    const despues = await lista(s.recepcion);
    expect(de(despues, quien.porVencer)).toEqual([]);
    expect(despues.sentToday.map((x) => x.id)).toEqual([m!.id]);
    expect(despues.sentToday[0]!.text).toBe(m!.text);
  });

  it('mandar un «te extrañamos» anota el contacto de Retención en el mismo toque (15-08)', async () => {
    const [m] = de(await lista(s.recepcion), quien.noArranco);
    expect(m!.detail).toBe('No arrancó');
    // Sin la llave de Retención ese mensaje no existe para quien lo intenta.
    expect((await marcar(s.recepcionSinLlave, quien.noArranco, m!.id, 'SENT')).statusCode).toBe(404);

    const r = await marcar(s.recepcion, quien.noArranco, m!.id, 'SENT');
    expect(r.statusCode, r.body).toBe(200);
    const contactos = await getDb().followUp.findMany({ where: { organizationId: g.organizationId, memberId: quien.noArranco } });
    expect(contactos.map((c) => [c.channel, c.outcome])).toEqual([['WHATSAPP', 'MESSAGE_SENT']]);
    // La lista de Retención lo lee como su último contacto, con el contrato de siempre.
    const ultimo = await app.inject({ method: 'GET', url: `/members/follow-ups/latest?ids=${quien.noArranco}`, headers: { cookie: s.recepcion } });
    expect(ultimo.statusCode, ultimo.body).toBe(200);
    expect(diferenciasConElContrato(FollowUpLatest, ultimo.json())).toEqual([]);
    expect((ultimo.json() as FollowUpLatest).latest[0]!.last.outcome).toBe('MESSAGE_SENT');
    // Y el job no le arma otro mientras Retención lo dé por contactado.
    await correr();
    expect(await getDb().outboundMessage.count({ where: { organizationId: g.organizationId, memberId: quien.noArranco, status: 'PENDING' } })).toBe(0);
  });

  it('si el socio ya pagó, el mensaje deja de verse al momento, no se puede mandar y el job lo cierra', async () => {
    const [m] = de(await lista(s.gerente), quien.vencido);
    await getDb().charge.update({ where: { id: cargoVencido }, data: { status: 'PAID', allocatedCents: 60_000n } });
    expect(de(await lista(s.gerente), quien.vencido)).toEqual([]);
    const r = await marcar(s.gerente, quien.vencido, m!.id, 'SENT');
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toContain('ya no hace falta');
    await correr();
    const cerrado = await getDb().outboundMessage.findUniqueOrThrow({ where: { id: m!.id } });
    expect([cerrado.status, cerrado.closeReason, cerrado.body]).toEqual(['EXPIRED', 'FACT_GONE', null]);
  });

  it('«No mandar» lo quita de la lista y el job no lo vuelve a armar', async () => {
    const [m] = de(await lista(s.recepcion), quien.termina);
    const r = await marcar(s.recepcion, quien.termina, m!.id, 'DISMISSED');
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as OutboundMarked).message.status).toBe('DISMISSED');
    await correr();
    expect(de(await lista(s.recepcion), quien.termina)).toEqual([]);
    expect(await getDb().auditLog.count({ where: { organizationId: g.organizationId, action: 'member.message.dismiss', resourceId: quien.termina } })).toBe(1);
  });

  it('recepción de Centro no manda el mensaje de un socio de Norte; un mensaje de otro socio no existe', async () => {
    const todo = await lista(s.gerente);
    const [deNorte] = de(todo, quien.vencidoNorte);
    expect((await marcar(s.recepcion, quien.vencidoNorte, deNorte!.id, 'SENT')).statusCode).toBe(403);
    // El id del mensaje tiene que ser de ESE socio.
    expect((await marcar(s.gerente, quien.renueva, deNorte!.id, 'SENT')).statusCode).toBe(404);
    expect((await marcar(s.gerente, quien.renueva, uuidv7(), 'SENT')).statusCode).toBe(404);
  });

  it('a los diez días sin mandarse, caduca', async () => {
    const [m] = de(await lista(s.gerente), quien.renueva);
    await getDb().outboundMessage.update({ where: { id: m!.id }, data: { createdAt: new Date(Date.now() - 11 * MS_DIA) } });
    expect(de(await lista(s.gerente), quien.renueva)).toEqual([]);
    await correr();
    const cerrado = await getDb().outboundMessage.findUniqueOrThrow({ where: { id: m!.id } });
    expect([cerrado.status, cerrado.closeReason]).toEqual(['EXPIRED', 'STALE']);
  });
});

describe('bandeja de salida: lo que dice cada mensaje', () => {
  const base = {
    firstName: 'Natalia', gimnasio: 'Gimnasio Fuerza', sede: null, concept: 'Mensualidad', dueCents: 65_000n,
    dueDate: new Date('2026-11-24T00:00:00Z'), planName: 'Mensual', periodEnd: new Date('2026-11-24T00:00:00Z'), engagementState: null, enLinea: false,
    priceFromCents: null, priceToCents: null,
  };

  it('saluda con el nombre y el gimnasio, y cada motivo dice lo suyo con la fecha del calendario', () => {
    expect(textoDelMensaje({ ...base, kind: 'PAYMENT_DUE_SOON' }))
      .toBe('Hola Natalia, te escribimos de Gimnasio Fuerza. Te recordamos que tu pago de Mensualidad por $650.00 vence el martes, 24 de noviembre. Puedes pagarlo en recepción. ¡Gracias!');
    expect(textoDelMensaje({ ...base, kind: 'PAYMENT_OVERDUE' })).toContain('venció el martes, 24 de noviembre');
    expect(textoDelMensaje({ ...base, kind: 'MEMBERSHIP_SUSPENDED' })).toContain('En cuanto pagues en recepción, vuelves a entrar.');
    // El periodo es semiabierto: si termina el 24, el último día es el 23.
    expect(textoDelMensaje({ ...base, kind: 'MEMBERSHIP_ENDING' })).toContain('Tu plan Mensual termina el lunes, 23 de noviembre');
    expect(detalleDelMensaje({ ...base, kind: 'MEMBERSHIP_ENDING' })).toBe('Mensual · termina el 23 de noviembre · no se renueva solo');
    expect(textoDelMensaje({ ...base, kind: 'PAYMENT_DUE_SOON', sede: 'Norte', enLinea: true })).toContain('de Gimnasio Fuerza (Norte). ');
    expect(textoDelMensaje({ ...base, kind: 'PAYMENT_DUE_SOON', enLinea: true })).toContain('desde tu portal o en recepción');
  });

  it('«te extrañamos» tiene un texto por estado y ninguno ofrece nada', () => {
    const textos = ['ONBOARDING_AT_RISK', 'SLIPPING', 'DORMANT'].map((engagementState) => textoDelMensaje({ ...base, kind: 'WE_MISS_YOU', engagementState }));
    expect(new Set(textos).size).toBe(3);
    for (const t of textos) expect(t).not.toMatch(/\$|descuento|promoci/i);
  });
});
