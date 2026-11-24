import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico, aprobacion } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

const db = () => getDb();
const sello = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4);

const CONSENTS = [
  { consentType: 'PRIVACY_NOTICE', documentVersion: 'v1.0', granted: true },
  { consentType: 'HOUSE_RULES', documentVersion: 'v1.0', granted: true },
];

describe('caja, corte de turno y cartera consolidada', () => {
  let app: FastifyInstance;
  let owner: string;
  let reception: string;
  let orgId: string;
  let branchCEN: string;
  let branchNOR: string;
  let approverId: string;
  let planId: string;
  /** Turnos abiertos por esta corrida: se cierran al final para no dejar
   *  estado colgando que rompa la siguiente. */
  const turnosAbiertos: string[] = [];

  /** Caja propia de la corrida: evita chocar con turnos de otras pruebas. */
  async function nuevaCaja(branchId: string): Promise<{ id: string; code: string }> {
    const res = await app.inject({
      method: 'POST', url: '/cash-registers', headers: { cookie: owner },
      payload: { branchId, code: `T${sello()}`.slice(0, 8), name: `Caja de prueba ${sello()}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    return { id: res.json().id, code: res.json().code };
  }

  async function abrirTurno(cashRegisterId: string, floatCents = '100000', quien = owner): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/cash-sessions', headers: { cookie: quien },
      payload: { cashRegisterId, openingFloatCents: floatCents },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    turnosAbiertos.push(id);
    return id;
  }

  /**
   * Sucursal desechable: las pruebas que dependen de CUÁNTAS cajas hay
   * abiertas no pueden compartir sede con el resto.
   *
   * El código lleva un prefijo de tres letras DISTINTO cada vez porque esas
   * tres letras son el prefijo del código de socio y la base exige que sea
   * único por organización.
   */
  let prefijoSeq = 0;
  async function sucursalAislada(): Promise<string> {
    const { uuidv7 } = await import('@gymflow/core');
    const letras = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const n = prefijoSeq++;
    const pref = `Z${letras[Math.floor(n / 26) % 26]}${letras[n % 26]}`;
    const branch = await db().branch.create({
      data: {
        id: uuidv7(), organizationId: orgId,
        code: `${pref}${sello()}`.slice(0, 8).toUpperCase(),
        name: `Sede aislada ${sello()}`,
      },
    });
    return branch.id;
  }

  async function nuevoSocio(homeBranchId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: owner },
      payload: {
        firstName: nombreUnico('Caja'), lastName: nombreUnico('Turno'),
        phoneE164: telefonoUnico(),
        homeBranchId, consents: CONSENTS,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  async function cargo(memberId: string, subtotalCents: string, branchId?: string) {
    const res = await app.inject({
      method: 'POST', url: `/members/${memberId}/charges`, headers: { cookie: owner },
      payload: {
        chargeType: 'MANUAL_ADJUSTMENT', concept: 'Cargo de prueba de caja',
        subtotalCents, reason: 'Prueba de integración de caja',
        ...(branchId ? { branchId } : {}),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  async function cobrar(memberId: string, amountCents: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST', url: `/members/${memberId}/payments`, headers: { cookie: owner },
      payload: { idempotencyKey: crypto.randomUUID(), method: 'CASH', amountCents, ...extra },
    });
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    reception = await loginAs(app, 'recepcion@demo.mx');

    const { demo, demoBranches } = await orgFixtures();
    orgId = demo.id;
    branchCEN = demoBranches.find((b) => b.code === 'CEN')!.id;
    branchNOR = demoBranches.find((b) => b.code === 'NOR')!.id;

    approverId = (await db().user.findFirstOrThrow({
      where: { organizationId: orgId, email: 'gerente@demo.mx' },
    })).id;
    planId = (await db().plan.findFirstOrThrow({
      where: { organizationId: orgId, billingModel: 'RECURRING', isActive: true },
    })).id;

    // Auto-sanación: una corrida interrumpida deja turnos abiertos, y con
    // varios abiertos en la misma sede el cobro ya no puede resolver la caja.
    // Se cierran los de cajas de prueba (código `T…`) antes de empezar.
    const huerfanos = await db().cashSession.findMany({
      where: {
        organizationId: orgId, status: 'OPEN',
        cashRegister: { code: { startsWith: 'T' } },
      },
      select: { id: true },
    });
    // Se cierran POR LA API, contando lo que el sistema espera. Escribir el
    // cierre a mano dejaba `expectedCashCents` a ciegas y rompía la fórmula
    // del corte en la base: la limpieza no puede fabricar datos que el
    // producto nunca produciría.
    for (const h of huerfanos) {
      const rep = await app.inject({
        method: 'GET', url: `/cash-sessions/${h.id}`, headers: { cookie: owner },
      });
      if (rep.statusCode !== 200) continue;
      await app.inject({
        method: 'POST', url: `/cash-sessions/${h.id}/close`, headers: { cookie: owner },
        payload: { countedCashCents: rep.json().expectedCashCents },
      });
    }
  });

  afterAll(async () => {
    // Las sedes desechables se archivan: dejarlas vivas agotaría el espacio
    // de prefijos de tres letras, que ahora es único por organización.
    await db().branch.updateMany({
      where: { organizationId: orgId, name: { startsWith: 'Sede aislada' }, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    // Cerrar cuadrando: el objetivo es no dejar turnos abiertos, no probar nada.
    for (const id of turnosAbiertos) {
      const rep = await app.inject({
        method: 'GET', url: `/cash-sessions/${id}`, headers: { cookie: owner },
      });
      if (rep.statusCode !== 200 || rep.json().session.status !== 'OPEN') continue;
      await app.inject({
        method: 'POST', url: `/cash-sessions/${id}/close`, headers: { cookie: owner },
        payload: { countedCashCents: rep.json().expectedCashCents },
      });
    }
    await app.close();
    await closeDb();
  });

  // ── Turno ─────────────────────────────────────────────────────────────────
  it('una caja NO admite dos turnos abiertos a la vez', async () => {
    const caja = await nuevaCaja(branchCEN);
    await abrirTurno(caja.id);

    const segundo = await app.inject({
      method: 'POST', url: '/cash-sessions', headers: { cookie: owner },
      payload: { cashRegisterId: caja.id, openingFloatCents: '50000' },
    });
    expect(segundo.statusCode).toBe(409);
    expect(segundo.json().message).toMatch(/turno abierto/);
  });

  it('NO se puede cerrar sin contar el efectivo', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id);

    const res = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/close`, headers: { cookie: owner },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it('una diferencia distinta de cero EXIGE motivo', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id, '100000');

    const sinMotivo = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/close`, headers: { cookie: owner },
      payload: { countedCashCents: '95000' },
    });
    expect(sinMotivo.statusCode).toBe(422);
    expect(sinMotivo.json().message).toMatch(/faltante/);

    const conMotivo = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/close`, headers: { cookie: owner },
      payload: { countedCashCents: '95000', varianceReason: 'Cambio dado de más durante el turno' },
    });
    expect(conMotivo.statusCode, conMotivo.body).toBe(200);
    expect(conMotivo.json().varianceCents).toBe('-5000');
    expect(conMotivo.json().varianceKind).toBe('SHORT');
  });

  it('un SOBRANTE también exige motivo: es la firma de un cobro no registrado', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id, '100000');

    const res = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/close`, headers: { cookie: owner },
      payload: { countedCashCents: '105000' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/sobrante/);
  });

  it('un turno cuadrado cierra sin motivo, y no se cierra dos veces', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id, '100000');

    const uno = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/close`, headers: { cookie: owner },
      payload: { countedCashCents: '100000' },
    });
    expect(uno.statusCode).toBe(200);
    expect(uno.json().varianceCents).toBe('0');
    expect(uno.json().varianceKind).toBe('EXACT');

    const dos = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/close`, headers: { cookie: owner },
      payload: { countedCashCents: '100000' },
    });
    expect(dos.statusCode).toBe(422);
  });

  it('el corte ciego no se maquilla: recontar exige motivo y el primer conteo queda (UXA-02)', async () => {
    const caja = await nuevaCaja(branchCEN);
    // Recepción corta el turno que ELLA abrió (UX5-M-06).
    const sesion = await abrirTurno(caja.id, '100000', reception);
    const cerrar = (counted: string, varianceReason?: string) => app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/close`, headers: { cookie: reception },
      payload: { countedCashCents: counted, ...(varianceReason ? { varianceReason } : {}) },
    });
    expect((await cerrar('75000')).statusCode).toBe(422); // faltan $250: pide motivo
    const tapar = await cerrar('100000'); // ya sabe cuánto debía haber
    expect(tapar.statusCode).toBe(422);
    expect(tapar.json().message).toMatch(/segundo conteo/i);
    const ok = await cerrar('100000', 'Había un sobre de $250 en el cajón de abajo');
    expect(ok.statusCode, ok.body).toBe(200);
    const rep = (await app.inject({ method: 'GET', url: `/cash-sessions/${sesion}`, headers: { cookie: owner } })).json();
    expect(rep.session.firstCountedCashCents).toBe('75000');
    expect(rep.session.countAttempts).toBe(3);
  });

  it('el corte dice quién abrió y quién cerró el turno', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id, '50000');

    const rep = await app.inject({ method: 'GET', url: `/cash-sessions/${sesion}`, headers: { cookie: owner } });
    expect(rep.json().session.openedByName).toBeTruthy();

    // Recepción no corta un turno ajeno (UX5-M-06); el encargado de la sede sí.
    const ajeno = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/close`, headers: { cookie: reception },
      payload: { countedCashCents: '50000' },
    });
    expect(ajeno.statusCode, ajeno.body).toBe(403);
    expect(ajeno.json().detail).toMatch(/lo abrió otra persona/);
    const cierre = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/close`, headers: { cookie: await loginAs(app, 'gerente@demo.mx') },
      payload: { countedCashCents: '50000' },
    });
    expect(cierre.statusCode, cierre.body).toBe(200);
    expect(cierre.json().closedByName).toBeTruthy();
    expect(cierre.json().closedByName).not.toBe(rep.json().session.openedByName);
  });

  it('recepción NO lee el corte ni la lista de turnos de otra sucursal', async () => {
    const caja = await nuevaCaja(branchNOR);
    const sesion = await abrirTurno(caja.id, '10000');

    const corte = await app.inject({ method: 'GET', url: `/cash-sessions/${sesion}`, headers: { cookie: reception } });
    expect(corte.statusCode).not.toBe(200);
    const lista = await app.inject({ method: 'GET', url: `/cash-sessions?branchId=${branchNOR}`, headers: { cookie: reception } });
    expect(lista.statusCode).not.toBe(200);
    const propia = await app.inject({ method: 'GET', url: `/cash-sessions?branchId=${branchCEN}`, headers: { cookie: reception } });
    expect(propia.statusCode).toBe(200);
  });

  // ── El efectivo esperado ──────────────────────────────────────────────────
  it('el esperado suma fondo y cobros en efectivo, y la terminal NO cuenta', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id, '100000');
    const socio = await nuevoSocio(branchCEN);

    await cargo(socio, '65000');
    await cargo(socio, '180000');

    const efectivo = await cobrar(socio, '65000', { branchId: branchCEN, cashSessionId: sesion });
    expect(efectivo.statusCode, efectivo.body).toBe(201);

    const terminal = await cobrar(socio, '180000', {
      method: 'CARD_TERMINAL', branchId: branchCEN, cashSessionId: sesion,
    });
    expect(terminal.statusCode, terminal.body).toBe(201);

    const rep = await app.inject({
      method: 'GET', url: `/cash-sessions/${sesion}`, headers: { cookie: owner },
    });
    const r = rep.json();
    expect(r.cashCollectedCents).toBe('65000');
    expect(r.totalCollectedCents).toBe('245000');
    // 100,000 de fondo + 65,000 en efectivo. La terminal queda fuera.
    expect(r.expectedCashCents).toBe('165000');

    const cerrar = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/close`, headers: { cookie: owner },
      payload: { countedCashCents: '165000' },
    });
    expect(cerrar.statusCode, cerrar.body).toBe(200);
    expect(cerrar.json().varianceCents).toBe('0');
  });

  it('un retiro baja el efectivo esperado y el turno sigue cuadrando', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id, '100000');
    const socio = await nuevoSocio(branchCEN);
    await cargo(socio, '200000');
    await cobrar(socio, '200000', { branchId: branchCEN, cashSessionId: sesion });

    const retiro = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/movements`, headers: { cookie: owner },
      payload: {
        movementType: 'WITHDRAWAL', amountCents: '150000',
        reason: 'Retiro a caja fuerte a media tarde', approvalToken: await aprobacion(app, owner, 'cash:withdraw', undefined, undefined, { resourceId: sesion, amountCents: '150000' }),
      },
    });
    expect(retiro.statusCode, retiro.body).toBe(201);
    // El cajero teclea 150000 en positivo; el sistema guarda el signo.
    expect(retiro.json().amountCents).toBe('-150000');

    const rep = await app.inject({
      method: 'GET', url: `/cash-sessions/${sesion}`, headers: { cookie: owner },
    });
    expect(rep.json().expectedCashCents).toBe('150000'); // 100k + 200k − 150k
    expect(rep.json().movementsCents).toBe('-150000');
  });

  it('no se puede sacar del cajón más de lo que hay', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id, '50000');

    const res = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/movements`, headers: { cookie: owner },
      payload: {
        movementType: 'WITHDRAWAL', amountCents: '200000',
        reason: 'Retiro mayor que el efectivo disponible', approvalToken: await aprobacion(app, owner, 'cash:withdraw', undefined, undefined, { resourceId: sesion, amountCents: '200000' }),
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/No hay tanto efectivo/);
  });

  it('la firma de un retiro que la caja rechaza no queda gastada: sirve para repetirlo corregido (2.14, D1)', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id, '50000');
    const firma = await aprobacion(app, owner, 'cash:withdraw', undefined, undefined, { resourceId: sesion, amountCents: '200000' });
    const retirar = (amountCents: string) => app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/movements`, headers: { cookie: owner },
      payload: { movementType: 'WITHDRAWAL', amountCents, reason: 'Retiro a caja fuerte con la misma firma', approvalToken: firma },
    });
    const rechazado = await retirar('200000');
    expect(rechazado.statusCode, rechazado.body).toBe(422);
    // El mensaje habla en pesos, no en centavos.
    expect(rechazado.json().message).toMatch(/hay \$500\.00 y se intenta sacar \$2,000\.00/);
    // La operación no existió: la firma vuelve a estar lista y vale para un importe que sí cabe.
    const corregido = await retirar('30000');
    expect(corregido.statusCode, corregido.body).toBe(201);
    // Ya usada de verdad, no vale otra vez.
    expect((await retirar('10000')).statusCode).toBe(422);
  });

  it('un movimiento que saca dinero exige autorización de un segundo usuario', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id, '100000');

    const res = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/movements`, headers: { cookie: owner },
      payload: { movementType: 'WITHDRAWAL', amountCents: '10000', reason: 'Retiro sin firma' },
    });
    // D-15 (bloque 3.5): ya no es un 422 genérico; es la misma señal de «pide firma» que el resto (428).
    expect(res.statusCode).toBe(428);
    expect(res.json().message).toMatch(/segundo usuario/);
  });

  it('el límite de retiro por turno es ACUMULADO: no se esquiva partiéndolo', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id, '1500000');
    // El tope por turno se prueba con la gerencia de sede, poniéndole uno a
    // propósito y devolviéndolo al final (el de recepción, con D-15, está en
    // `cajon-d15.test.ts`).
    const gerente = await loginAs(app, 'gerente@demo.mx');
    const limites = await db().roleLimitSet.findFirstOrThrow({ where: { organizationId: orgId, role: { key: 'MANAGER' } } });
    await db().roleLimitSet.update({ where: { id: limites.id }, data: { maxCashWithdrawalCents: 500_000n } });
    try {
      const primero = await app.inject({
        method: 'POST', url: `/cash-sessions/${sesion}/movements`, headers: { cookie: gerente },
        payload: {
          movementType: 'WITHDRAWAL', amountCents: '400000',
          reason: 'Primer retiro del turno, dentro del límite', approvalToken: await aprobacion(app, gerente, 'cash:withdraw', 'owner@demo.mx', undefined, { resourceId: sesion, amountCents: '400000' }),
        },
      });
      expect(primero.statusCode, primero.body).toBe(201);

      // El segundo, por sí solo, también cabría. Sumado al primero, no.
      const segundo = await app.inject({
        method: 'POST', url: `/cash-sessions/${sesion}/movements`, headers: { cookie: gerente },
        payload: { movementType: 'WITHDRAWAL', amountCents: '400000', reason: 'Segundo retiro que rebasa el acumulado' },
      });
      // D-15: quien tiene tope por turno no lo pasa ni con firma: se niega antes de pedirla.
      expect(segundo.statusCode).toBe(403);
      expect(segundo.json().reason).toBe('CASH_LIMIT_FORBIDDEN');
    } finally {
      await db().roleLimitSet.update({ where: { id: limites.id }, data: { maxCashWithdrawalCents: limites.maxCashWithdrawalCents } });
    }
    // Y recepción (D-15): retira con la firma de la dueña; sin ella, se le pide.
    const rec = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/movements`, headers: { cookie: reception },
      payload: { movementType: 'WITHDRAWAL', amountCents: '1000', reason: 'Intento de recepción' },
    });
    expect(rec.statusCode, rec.body).toBe(428);
  });

  // ── Folio ─────────────────────────────────────────────────────────────────
  it('cada cobro recibe folio de su caja, correlativo y único', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id);
    const socio = await nuevoSocio(branchCEN);
    await cargo(socio, '30000');
    await cargo(socio, '30000');

    const a = await cobrar(socio, '30000', { branchId: branchCEN, cashSessionId: sesion });
    const b = await cobrar(socio, '30000', { branchId: branchCEN, cashSessionId: sesion });

    const folioA = a.json().payment.folio as string;
    const folioB = b.json().payment.folio as string;
    expect(folioA).toMatch(new RegExp(`^CEN-${caja.code}-\\d{6}$`));
    expect(folioB).not.toBe(folioA);
    expect(Number(folioB.slice(-6))).toBe(Number(folioA.slice(-6)) + 1);
  });

  it('una clave de cobro reutilizada con OTROS datos se rechaza; con los mismos, devuelve el mismo pago (BE2-09)', async () => {
    const a = await nuevoSocio(branchCEN);
    const b = await nuevoSocio(branchCEN);
    await cargo(a, '10000'); await cargo(b, '120000');
    const clave = crypto.randomUUID();
    const uno = await cobrar(a, '100', { method: 'SPEI_TRANSFER', branchId: branchCEN, externalRef: 'SPEI-IDEM', idempotencyKey: clave });
    expect(uno.statusCode, uno.body).toBe(201);
    const otro = await cobrar(b, '120000', { branchId: branchCEN, idempotencyKey: clave });
    expect(otro.statusCode).toBe(422);
    const mismo = await cobrar(a, '100', { method: 'SPEI_TRANSFER', branchId: branchCEN, externalRef: 'SPEI-IDEM', idempotencyKey: clave });
    expect(mismo.statusCode).toBe(200);
    expect(mismo.json().payment.id).toBe(uno.json().payment.id);
  });

  it('del mostrador no entra una nota de crédito, ni una transferencia sin referencia (BE2-02)', async () => {
    const socio = await nuevoSocio(branchCEN);
    await cargo(socio, '95000');
    expect((await cobrar(socio, '95000', { method: 'CREDIT_NOTE', branchId: branchCEN })).statusCode).toBe(422);
    expect((await cobrar(socio, '95000', { method: 'CARD_ON_FILE', branchId: branchCEN, externalRef: 'tecleada' })).statusCode).toBe(422);
    const sinRef = await cobrar(socio, '95000', { method: 'SPEI_TRANSFER', branchId: branchCEN });
    expect(sinRef.statusCode).toBe(422);
    expect(sinRef.json().message).toMatch(/referencia/i);
  });

  it('un cobro por transferencia NO consume folio ni toca el cajón', async () => {
    const socio = await nuevoSocio(branchCEN);
    await cargo(socio, '65000');
    const res = await cobrar(socio, '65000', { method: 'SPEI_TRANSFER', branchId: branchCEN, externalRef: 'SPEI-CAJA-01' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().payment.folio).toBeNull();
    expect(res.json().payment.cashSessionId).toBeNull();
  });

  it('cobrar en efectivo SIN caja abierta se rechaza con un mensaje accionable', async () => {
    const sede = await sucursalAislada();
    const socio = await nuevoSocio(sede);
    await cargo(socio, '65000');
    const res = await cobrar(socio, '65000', { branchId: sede });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/abre turno antes de cobrar/);
  });

  it('con VARIAS cajas abiertas en la sucursal, se exige elegir', async () => {
    const sede = await sucursalAislada();
    const a = await nuevaCaja(sede);
    const b = await nuevaCaja(sede);
    await abrirTurno(a.id);
    await abrirTurno(b.id);

    const socio = await nuevoSocio(sede);
    await cargo(socio, '65000');
    const res = await cobrar(socio, '65000', { branchId: sede });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/indica en cuál/);
  });

  // ── Cobro cruzado entre sucursales ────────────────────────────────────────
  it('un socio de la sede NORTE paga en CENTRO: entra al corte de CENTRO y a la cartera global', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id, '0');

    const socio = await nuevoSocio(branchNOR);
    const c = await cargo(socio, '65000', branchNOR);

    const pago = await cobrar(socio, '65000', {
      branchId: branchCEN, cashSessionId: sesion, targetChargeIds: [c.id],
    });
    expect(pago.statusCode, pago.body).toBe(201);
    expect(pago.json().payment.branchId).toBe(branchCEN);
    expect(pago.json().payment.folio).toMatch(/^CEN-/);

    // Entra al corte de la caja que lo RECIBIÓ.
    const rep = await app.inject({
      method: 'GET', url: `/cash-sessions/${sesion}`, headers: { cookie: owner },
    });
    expect(rep.json().cashCollectedCents).toBe('65000');

    // Y el cargo quedó saldado aunque se originó en otra sede.
    const st = await app.inject({
      method: 'GET', url: `/members/${socio}/statement`, headers: { cookie: owner },
    });
    const cargoFinal = st.json().charges.find((x: { id: string }) => x.id === c.id);
    expect(cargoFinal.status).toBe('PAID');
    expect(st.json().netBalanceCents).toBe('0');
  });

  it('la segunda firma la da el dueño: un gerente, ni de su sede ni general, autoriza un retiro (2026-10-05)', async () => {
    const sede = await sucursalAislada();
    const caja = await nuevaCaja(sede);
    const sesion = await abrirTurno(caja.id, '100000');
    for (const quien of ['gerente@demo.mx', 'gerencia@demo.mx']) {
      await expect(aprobacion(app, owner, 'cash:withdraw', quien, undefined, { resourceId: sesion, amountCents: '10000' })).rejects.toThrow(/403/);
    }
    const res = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/movements`, headers: { cookie: owner },
      payload: {
        movementType: 'WITHDRAWAL', amountCents: '10000', reason: 'Retiro con firma del dueño',
        approvalToken: await aprobacion(app, owner, 'cash:withdraw', 'owner@demo.mx', undefined, { resourceId: sesion, amountCents: '10000' }),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('el contra-asiento de un cobro en efectivo sale del turno de HOY, no del original', async () => {
    // Sede aislada: el reverso RESUELVE el turno solo, así que no puede haber
    // más de uno abierto o la resolución sería ambigua.
    const sede = await sucursalAislada();
    const cajaA = await nuevaCaja(sede);
    const sesionA = await abrirTurno(cajaA.id, '0');
    const socio = await nuevoSocio(sede);
    await cargo(socio, '65000');
    const pago = (await cobrar(socio, '65000', { branchId: sede, cashSessionId: sesionA })).json().payment;

    // Se cierra el turno donde entró el dinero.
    const cierre = await app.inject({
      method: 'POST', url: `/cash-sessions/${sesionA}/close`, headers: { cookie: owner },
      payload: { countedCashCents: '65000' },
    });
    expect(cierre.statusCode, cierre.body).toBe(200);

    // Y se revierte con OTRO turno abierto en la misma sede.
    const cajaB = await nuevaCaja(sede);
    const sesionB = await abrirTurno(cajaB.id, '100000');

    // La gerente autoriza solo en las sedes que tiene asignadas: se le asigna
    // esta, como haría el dueño al abrir una sucursal.
    const { uuidv7 } = await import('@gymflow/core');
    const gerente = await db().user.findFirstOrThrow({ where: { organizationId: orgId, email: 'gerente@demo.mx' } });
    const rolGerente = await db().roleAssignment.findFirstOrThrow({ where: { userId: gerente.id, revokedAt: null } });
    const asignacion = await db().roleAssignment.create({
      data: { id: uuidv7(), organizationId: orgId, userId: gerente.id, roleId: rolGerente.roleId, branchId: sede },
    });

    const rev = await app.inject({
      method: 'POST', url: `/payments/${pago.id}/reverse`, headers: { cookie: owner },
      payload: { reason: 'Cobro capturado en el socio equivocado', approvalToken: await aprobacion(app, owner, 'payments:reverse', undefined, undefined, { resourceId: pago.id, amountCents: pago.amountCents }) },
    });
    // Se revoca al terminar: otras pruebas cuentan las sedes de la gerente.
    await db().roleAssignment.update({ where: { id: asignacion.id }, data: { revokedAt: new Date() } });
    expect(rev.statusCode, rev.body).toBe(201);
    expect(rev.json().cashSessionId).toBe(sesionB);

    // El corte YA CERRADO no se movió.
    const cerrado = await db().cashSession.findUniqueOrThrow({ where: { id: sesionA } });
    expect(cerrado.varianceCents).toBe(0n);
    expect(cerrado.countedCashCents).toBe(65000n);

    // El turno de hoy es el que absorbe la salida: 100,000 − 65,000.
    const repB = await app.inject({
      method: 'GET', url: `/cash-sessions/${sesionB}`, headers: { cookie: owner },
    });
    expect(repB.json().expectedCashCents).toBe('35000');
  });

  // ── Descuentos con límite por rol ─────────────────────────────────────────
  it('recepción no descuenta: atiende y consulta, no modifica', async () => {
    const socio = await nuevoSocio(branchCEN);
    const c = await cargo(socio, '65000', branchCEN);
    const res = await app.inject({
      method: 'POST', url: `/charges/${c.id}/adjustments`, headers: { cookie: reception },
      payload: { adjustmentType: 'DISCOUNT', amountCents: '6500', reasonCode: 'REFERIDO', reason: 'Descuento del 10% por referido' },
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('un descuento del 35% del gerente DISPARA aprobación; otro gerente no la firma, el dueño sí (2026-10-05)', async () => {
    const socio = await nuevoSocio(branchCEN);
    const c = await cargo(socio, '65000', branchCEN);
    const gerente = await loginAs(app, 'gerente@demo.mx');

    // La gerencia tiene maxDiscountPercent = 30.
    const res = await app.inject({
      method: 'POST', url: `/charges/${c.id}/adjustments`, headers: { cookie: gerente },
      payload: { adjustmentType: 'DISCOUNT', amountCents: '22750', reasonCode: 'PROMOCION_VIGENTE', reason: 'Descuento del 35% por promoción' },
    });
    expect(res.statusCode).toBe(428);
    expect(res.json().error).toBe('REQUIRE_APPROVAL');
    expect(res.json().detail).toMatch(/30%/);
    // Otro gerente ya no firma: la segunda firma es del dueño.
    await expect(aprobacion(app, gerente, 'billing:discount:apply', 'gerencia@demo.mx', undefined, { resourceId: c.id, amountCents: '22750' })).rejects.toThrow(/403/);
    const firma = await aprobacion(app, gerente, 'billing:discount:apply', 'owner@demo.mx', undefined, { resourceId: c.id, amountCents: '22750' });
    const conFirma = await app.inject({
      method: 'POST', url: `/charges/${c.id}/adjustments`, headers: { cookie: gerente },
      payload: { adjustmentType: 'DISCOUNT', amountCents: '22750', reasonCode: 'PROMOCION_VIGENTE', reason: 'Descuento del 35% por promoción', approvalToken: firma },
    });
    expect(conFirma.statusCode, conFirma.body).toBe(201);
  });

  it('un descuento dentro del límite del rol NO pide firma', async () => {
    const socio = await nuevoSocio(branchCEN);
    const c = await cargo(socio, '65000', branchCEN);
    const gerente = await loginAs(app, 'gerente@demo.mx');
    const res = await app.inject({
      method: 'POST', url: `/charges/${c.id}/adjustments`, headers: { cookie: gerente },
      payload: { adjustmentType: 'DISCOUNT', amountCents: '16250', reasonCode: 'PROMOCION_VIGENTE', reason: 'Descuento del 25% por promoción' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().adjustedCents).toBe('16250');
    expect(res.json().balanceCents).toBe('48750');
  });

  it('un descuento SIN motivo de catálogo se rechaza', async () => {
    const socio = await nuevoSocio(branchCEN);
    const c = await cargo(socio, '65000', branchCEN);

    const res = await app.inject({
      method: 'POST', url: `/charges/${c.id}/adjustments`, headers: { cookie: owner },
      payload: { adjustmentType: 'DISCOUNT', amountCents: '1000', reason: 'porque si' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('el catálogo de motivos se expone como lista cerrada', async () => {
    const res = await app.inject({
      method: 'GET', url: '/discount-reasons', headers: { cookie: owner },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reasons).toContain('ESTUDIANTE');
    expect(res.json().reasons).not.toContain('porque si');
  });

  // ── Cartera consolidada ───────────────────────────────────────────────────
  it('la cartera es UNA sola para toda la organización, con tramos de antigüedad', async () => {
    const res = await app.inject({
      method: 'GET', url: '/portfolio?topDebtors=5', headers: { cookie: owner },
    });
    expect(res.statusCode, res.body).toBe(200);
    const p = res.json();

    expect(p.scope).toBe('ORGANIZACION');
    expect(BigInt(p.totalOutstandingCents)).toBeGreaterThan(0n);
    expect(p.membersWithDebt).toBeGreaterThan(0);
    expect(p.byAging.length).toBeGreaterThan(0);
    expect(p.topDebtors.length).toBeGreaterThan(0);

    // La suma de los tramos es el total: si no cuadra, el reporte miente.
    const suma = p.byAging.reduce((acc: bigint, r: { amountCents: string }) => acc + BigInt(r.amountCents), 0n);
    expect(suma).toBe(BigInt(p.totalOutstandingCents));

    // Y lo vencido nunca puede superar al total.
    expect(BigInt(p.overdueCents)).toBeLessThanOrEqual(BigInt(p.totalOutstandingCents));
  });

  it('la cartera filtrada por sucursal es un SUBCONJUNTO de la consolidada', async () => {
    const global = await app.inject({ method: 'GET', url: '/portfolio', headers: { cookie: owner } });
    const cen = await app.inject({
      method: 'GET', url: `/portfolio?branchId=${branchCEN}`, headers: { cookie: owner },
    });
    expect(cen.statusCode).toBe(200);
    expect(cen.json().scope).toBe(branchCEN);
    expect(BigInt(cen.json().totalOutstandingCents))
      .toBeLessThanOrEqual(BigInt(global.json().totalOutstandingCents));
  });

  it('recepción NO ve la cartera consolidada del negocio', async () => {
    const res = await app.inject({ method: 'GET', url: '/portfolio', headers: { cookie: reception } });
    expect(res.statusCode).toBe(403);
  });

  // ── Append-only ───────────────────────────────────────────────────────────
  it('la base impide BORRAR un movimiento de caja', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id, '100000');
    await app.inject({
      method: 'POST', url: `/cash-sessions/${sesion}/movements`, headers: { cookie: owner },
      payload: {
        movementType: 'WITHDRAWAL', amountCents: '10000',
        reason: 'Retiro que se intentará borrar', approvalToken: await aprobacion(app, owner, 'cash:withdraw', undefined, undefined, { resourceId: sesion, amountCents: '10000' }),
      },
    });
    const mov = await db().cashMovement.findFirstOrThrow({ where: { cashSessionId: sesion } });
    await expect(db().cashMovement.delete({ where: { id: mov.id } }))
      .rejects.toThrow(/permission denied|append-only/);
  });

  it('el rol de aplicación NO puede borrar turnos ni movimientos', async () => {
    const filas = await db().$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.role_table_grants
      WHERE grantee = 'gymflow_app'
        AND table_name IN ('cash_sessions','cash_movements')
        AND privilege_type = 'DELETE'`;
    expect(filas).toEqual([]);
  });

  it('la base RECHAZA un retiro con signo positivo, aunque se intente por dentro', async () => {
    const caja = await nuevaCaja(branchCEN);
    const sesion = await abrirTurno(caja.id, '100000');
    await expect(db().$executeRawUnsafe(`
      INSERT INTO "cash_movements" ("id","organizationId","cashSessionId","movementType","amountCents","reason","createdByUserId","businessDate")
      VALUES (gen_random_uuid(), '${orgId}', '${sesion}', 'WITHDRAWAL', 10000, 'Retiro con signo invertido', '${approverId}', CURRENT_DATE)
    `)).rejects.toThrow(/movements_sign_coherence_check/);
  });

  // ── Aislamiento ───────────────────────────────────────────────────────────
  it('un turno de OTRA organización devuelve 404, no 403', async () => {
    const { other } = await orgFixtures();
    const branch = await db().branch.findFirstOrThrow({ where: { organizationId: other.id } });
    const register = await db().cashRegister.findFirstOrThrow({
      where: { organizationId: other.id, branchId: branch.id },
    });
    const ajena = await db().cashSession.create({
      data: {
        id: crypto.randomUUID(), organizationId: other.id, branchId: branch.id,
        cashRegisterId: register.id,
        openedByUserId: (await db().user.findFirstOrThrow({ where: { organizationId: other.id } })).id,
        openingFloatCents: 0n, businessDate: new Date(),
      },
    });

    const res = await app.inject({
      method: 'GET', url: `/cash-sessions/${ajena.id}`, headers: { cookie: owner },
    });
    expect(res.statusCode).toBe(404);

    const { createPrismaClient } = await import('@gymflow/db');
    const dueño = createPrismaClient(process.env.DATABASE_URL_MIGRATOR);
    try {
      await dueño.$executeRawUnsafe(`DELETE FROM "cash_sessions" WHERE "id" = '${ajena.id}'`);
    } finally {
      await dueño.$disconnect();
    }
  });

  it('el plan sembrado sigue disponible para las pruebas', () => {
    expect(planId).toBeTruthy();
  });
});
