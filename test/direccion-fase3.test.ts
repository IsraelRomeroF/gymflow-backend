import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LISTA_DEL_AVISO_DE_PRIVACIDAD, modeloDeTexto, uuidv7 } from '@gymflow/core';
import {
  diferenciasConElContrato, Dashboard, Expense, ExpenseList, MonthlyClose, MonthlyClosePreview, NoticeSignatureRequests, Pulse, SignatureBrief, StoreSummary,
  ConsentDocumentPublishResult,
} from '@gymflow/core/contracts';
import { makeApp, loginAs, PASSWORD, aprobacion } from './helpers.js';
import { gimnasioPropio, socioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * Auditoría 8, fase 3, bloque 3.7 · Dirección (D-22 a D-25), en un gimnasio
 * propio: cierra meses, anota gastos y deja sin gerente al gimnasio, cosas que
 * moverían las cuentas de los demás archivos. Los meses que cierra son de
 * 2024: ya terminaron sea cual sea la hora a la que corra la prueba.
 */
describe('3.7 · dirección', () => {
  let app: FastifyInstance; let g: GimnasioPropio;
  let owner: string; let gerente: string; let recepcion: string;
  const db = getDb();
  const mesDe = (m: string) => new Date(`${m}-01T00:00:00.000Z`);
  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (cookie: string, url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers: { cookie }, payload });
  const gasto = (cookie: string, cuerpo: Record<string, unknown>) => post(cookie, '/expenses', { category: 'RENT', description: 'Renta del local', amountCents: '1000000', branchId: null, ...cuerpo });
  const tableroDe = async (cookie: string, mes: string) => {
    const d = mesDe(mes); const fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    const r = await get(cookie, `/dashboard?from=${mes}-01&to=${fin}&fresh=1`);
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(Dashboard, r.json())).toEqual([]);
    return r.json() as Dashboard;
  };
  const cerrarConFirma = async (mes: string) => {
    const token = await aprobacion(app, gerente, 'reports:month:close', g.correos.owner);
    return post(gerente, '/reports/monthly-close', { month: mes, reason: 'Cierre contable del mes', approvalToken: token });
  };

  beforeAll(async () => {
    app = await makeApp(); await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Centro', cajas: 1 }, { name: 'Norte', cajas: 1 }] });
    owner = await loginAs(app, g.correos.owner); gerente = await loginAs(app, g.correos.gerente); recepcion = await loginAs(app, g.correos.recepcion);
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  describe('D-22 · al cerrar el mes las cifras quedan fijas', () => {
    const MES = '2024-03';
    let renta: string;

    it('no se cierra con una caja abierta de ese mes: antes avisaba, ahora lo impide', async () => {
      const sede = g.sedes[0]!;
      const turno = uuidv7();
      await db.cashSession.create({ data: { id: turno, organizationId: g.organizationId, branchId: sede.id, cashRegisterId: sede.cajas[0]!, openedByUserId: g.ownerId, businessDate: new Date('2024-03-28T00:00:00.000Z'), openingFloatCents: 50_000n } });

      const previa = await get(gerente, `/reports/monthly-close/preview?month=${MES}`);
      expect(previa.statusCode, previa.body).toBe(200);
      expect(diferenciasConElContrato(MonthlyClosePreview, previa.json())).toEqual([]);
      const p = previa.json() as MonthlyClosePreview;
      expect(p.closable).toBe(false);
      expect(p.blockers.map((b) => b.code)).toEqual(['OPEN_CASH_SESSIONS']);
      expect(p.warnings.map((w) => w.code)).not.toContain('OPEN_CASH_SESSIONS');
      expect(p.signature).toBe('approver');

      // Y el envío tampoco pasa, sin gastar la firma.
      const res = await cerrarConFirma(MES);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ reason: 'MONTH_HAS_OPEN_CASH' });
      expect(await db.monthlyClose.count({ where: { organizationId: g.organizationId } })).toBe(0);

      // Hecho el corte, ya se puede.
      await db.cashSession.update({ where: { id: turno }, data: { status: 'CLOSED', closedAt: new Date(), closedByUserId: g.ownerId, countedCashCents: 50_000n, expectedCashCents: 50_000n, varianceCents: 0n } });
      expect((await get(gerente, `/reports/monthly-close/preview?month=${MES}`)).json()).toMatchObject({ closable: true, blockers: [] });
    });

    it('la foto es completa (Tablero y Movimientos, total y por sucursal) y el mes cerrado se sirve de ella', async () => {
      const r = await gasto(gerente, { month: MES });
      expect(r.statusCode, r.body).toBe(201);
      expect(diferenciasConElContrato(Expense, r.json())).toEqual([]);
      renta = r.json().id;
      const deSede = await gasto(gerente, { month: MES, branchId: g.sedes[1]!.id, description: 'Luz de Norte', category: 'UTILITIES', amountCents: '310000' });
      expect(deSede.statusCode, deSede.body).toBe(201);

      const antes = await tableroDe(gerente, MES);
      expect(antes.closed).toBeNull();
      expect(antes.money.fixedExpensesCents).toBe('-1310000');

      const res = await cerrarConFirma(MES);
      expect(res.statusCode, res.body).toBe(201);
      expect(diferenciasConElContrato(MonthlyClose, res.json())).toEqual([]);
      const cierre = res.json() as MonthlyClose;
      expect(cierre.totals).toMatchObject({ version: 2, fixedExpensesCents: '-1310000', profitCents: antes.money.profitCents, ownerDrawsCents: '0', costOfGoodsCents: '0' });
      expect(cierre.totals.cash).toMatchObject({ fixedExpensesCents: '-1310000', profitCents: '-1310000', incomeCents: '0' });

      // Llega algo tarde por fuera de la API (lo que la API ya no deja): el mes cerrado NO se mueve.
      await db.operatingExpense.create({ data: { id: uuidv7(), organizationId: g.organizationId, branchId: null, category: 'OTHER', description: 'Colado después del cierre', amountCents: 999_900n, periodMonth: mesDe(MES), createdByUserId: g.ownerId } });
      const despues = await tableroDe(gerente, MES);
      expect(despues.closed).toMatchObject({ fromSnapshot: true });
      expect(despues.money).toMatchObject({ fixedExpensesCents: '-1310000', profitCents: antes.money.profitCents, collectedCents: antes.money.collectedCents });
      expect(despues.portfolio).toEqual(antes.portfolio);

      // Movimientos del mes entero: los totales, de la foto; y dice qué meses del periodo están cerrados.
      const mov = await get(gerente, `/reports/daily?from=${MES}-01&to=${MES}-31`);
      expect(mov.statusCode, mov.body).toBe(200);
      expect(mov.json()).toMatchObject({ totalsFromSnapshot: true, closedMonths: [MES], totals: { fixedExpensesCents: '-1310000', profitCents: '-1310000' } });
      // Un tramo del mes (no el mes entero) se sigue calculando, y lo dice.
      expect((await get(gerente, `/reports/daily?from=${MES}-01&to=${MES}-15`)).json()).toMatchObject({ totalsFromSnapshot: false, closedMonths: [MES] });
    });

    it('lo tardío se anota en el mes en curso como «ajuste de ‹mes›», etiquetado', async () => {
      // Directo al mes cerrado: 409 con la causa, para que la pantalla ofrezca el ajuste.
      // Bloque 4.5 (D-26): la nómina se anota por pago, con fecha y a quién; el mes sale de la fecha.
      const directo = await gasto(owner, { paidOn: `${MES}-27`, payeeName: 'Persona de prueba', description: 'Nómina que faltó', category: 'PAYROLL', amountCents: '250000' });
      expect(directo.statusCode, directo.body).toBe(409);
      expect(directo.json()).toMatchObject({ reason: 'MONTH_CLOSED' });
      expect(directo.json().message).toContain('ajuste de marzo de 2024');

      const ajuste = await gasto(owner, { paidOn: `${MES}-27`, payeeName: 'Persona de prueba', description: 'Nómina que faltó', category: 'PAYROLL', amountCents: '250000', asAdjustment: true });
      expect(ajuste.statusCode, ajuste.body).toBe(201);
      const lista = (await get(owner, `/expenses?month=${MES}`)).json() as ExpenseList;
      expect(diferenciasConElContrato(ExpenseList, lista)).toEqual([]);
      expect(lista.closed).toBe(true);
      const enCurso = lista.currentMonth;
      expect(ajuste.json()).toMatchObject({ month: enCurso, adjustsMonth: MES, amountCents: '250000' });
      expect(enCurso > MES).toBe(true);
      // Un mes abierto no admite «ajuste»: el gasto va en él.
      expect((await gasto(owner, { month: enCurso, asAdjustment: true })).statusCode).toBe(422);

      // Anular un gasto del mes cerrado: tampoco; se corrige con un ajuste en negativo, una sola vez.
      const anular = await post(gerente, `/expenses/${renta}/void`, { reason: 'Se capturó dos veces' });
      expect(anular.statusCode, anular.body).toBe(409);
      expect(anular.json()).toMatchObject({ reason: 'MONTH_CLOSED' });
      const corregir = await post(gerente, `/expenses/${renta}/void`, { reason: 'Se capturó dos veces', asAdjustment: true });
      expect(corregir.statusCode, corregir.body).toBe(200);
      expect(corregir.json().adjustment).toMatchObject({ month: enCurso, adjustsMonth: MES, adjustsExpenseId: renta, amountCents: '-1000000' });
      expect((await post(gerente, `/expenses/${renta}/void`, { reason: 'Otra vez', asAdjustment: true })).json()).toMatchObject({ reason: 'ALREADY_VOIDED' });
      // El gasto original sigue en su mes, sin anular, y dice dónde se corrigió.
      const original = ((await get(gerente, `/expenses?month=${MES}`)).json() as ExpenseList).expenses.find((e) => e.id === renta)!;
      expect(original).toMatchObject({ voidedAt: null, correctedInMonth: enCurso });
      const asientos = await db.auditLog.findMany({ where: { organizationId: g.organizationId, action: 'expense.adjust' } });
      expect(asientos).toHaveLength(2);

      // El mes cerrado sigue igual; el mes en curso dice cuánto trae de ajustes de marzo.
      expect((await tableroDe(gerente, MES)).money.fixedExpensesCents).toBe('-1310000');
      const actual = await tableroDe(gerente, enCurso);
      expect(actual.adjustments).toEqual([{ month: MES, cents: '-750000', count: 2 }]);
      const fin = new Date(Date.UTC(Number(enCurso.slice(0, 4)), Number(enCurso.slice(5, 7)), 0)).toISOString().slice(0, 10);
      const movs = (await get(gerente, `/reports/daily?from=${enCurso}-01&to=${fin}`)).json();
      expect(movs.adjustments).toEqual([{ month: MES, cents: '-750000', count: 2 }]);
      expect(movs.totals.fixedExpensesCents).toBe('750000');
    });
  });

  describe('D-23 · la dueña con el dinero', () => {
    it('anota gastos, nómina y «Retiro del dueño» aunque haya gerente; el retiro no resta de la ganancia', async () => {
      const MES = '2024-06';
      // Bloque 4.5 (D-26): por pago.
      const nomina = await gasto(owner, { paidOn: `${MES}-28`, payeeName: 'Persona de prueba', category: 'PAYROLL', description: 'Nómina de junio', amountCents: '4000000' });
      expect(nomina.statusCode, nomina.body).toBe(201);
      const antes = (await get(owner, `/reports/daily?from=${MES}-01&to=${MES}-30`)).json();
      expect(antes.totals.profitCents).toBe('-4000000');
      expect(antes.ownerDrawsCents).toBe('0');

      const retiro = await gasto(owner, { month: MES, category: 'OWNER_DRAW', description: 'Retiro de junio', amountCents: '1500000' });
      expect(retiro.statusCode, retiro.body).toBe(201);
      const despues = (await get(owner, `/reports/daily?from=${MES}-01&to=${MES}-30`)).json();
      expect(despues.totals.profitCents).toBe('-4000000');
      expect(despues.totals.fixedExpensesCents).toBe('-4000000');
      expect(despues.ownerDrawsCents).toBe('1500000');
      const tablero = await tableroDe(owner, MES);
      expect(tablero.money).toMatchObject({ fixedExpensesCents: '-4000000', ownerDrawsCents: '1500000' });
      // Se ve en la lista de Movimientos, con su tipo, y se anula con motivo como cualquier gasto.
      const lista = (await get(owner, `/expenses?month=${MES}`)).json() as ExpenseList;
      expect(lista.expenses.map((e) => e.category).sort()).toEqual(['OWNER_DRAW', 'PAYROLL']);
      expect((await post(owner, `/expenses/${retiro.json().id}/void`, { reason: 'Se anotó en el mes equivocado' })).statusCode).toBe(200);
      // La gerencia con Movimientos liberado, también; recepción, no.
      expect((await gasto(gerente, { month: MES, category: 'OWNER_DRAW', description: 'Retiro que anota la gerencia', amountCents: '100000' })).statusCode).toBe(201);
      expect((await gasto(recepcion, { month: MES })).statusCode).toBe(403);
    });

    it('con gerente, la dueña no cierra el mes (firma); sin gerente, lo cierra con su contraseña', async () => {
      const MES = '2024-07';
      const conGerente = await post(owner, '/reports/monthly-close', { month: MES, reason: 'Cierre contable', password: PASSWORD });
      expect(conGerente.statusCode, conGerente.body).toBe(403);
      expect((await get(owner, `/reports/monthly-close/preview?month=${MES}`)).json()).toMatchObject({ signature: 'approver' });

      // El gimnasio se queda sin gerente que administre.
      const gerentes = await db.user.findMany({ where: { organizationId: g.organizationId, email: { in: [g.correos.gerente, g.correos.gerente2] } }, select: { id: true } });
      await db.user.updateMany({ where: { id: { in: gerentes.map((x) => x.id) } }, data: { isActive: false } });
      try {
        const previa = await get(owner, `/reports/monthly-close/preview?month=${MES}`);
        expect(previa.json()).toMatchObject({ signature: 'own-password', closable: true });

        const sinClave = await post(owner, '/reports/monthly-close', { month: MES, reason: 'Cierre contable' });
        expect(sinClave.statusCode, sinClave.body).toBe(422);
        const mala = await post(owner, '/reports/monthly-close', { month: MES, reason: 'Cierre contable', password: 'no-es-mi-contraseña' });
        expect(mala.statusCode, mala.body).toBe(401);
        expect(await db.monthlyClose.count({ where: { organizationId: g.organizationId, month: mesDe(MES) } })).toBe(0);

        const res = await post(owner, '/reports/monthly-close', { month: MES, reason: 'Cierre contable', note: 'Sin gerente', password: PASSWORD });
        expect(res.statusCode, res.body).toBe(201);
        expect(diferenciasConElContrato(MonthlyClose, res.json())).toEqual([]);
        expect(res.json()).toMatchObject({ month: MES, closedByUserId: g.ownerId, approvedByUserId: null, approvedByName: null, note: 'Sin gerente' });
        const asiento = await db.auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'report.month.close', resourceId: res.json().id } });
        expect(asiento.actorUserId).toBe(g.ownerId);
        expect(asiento.afterState).toMatchObject({ month: MES, ownerClosedAlone: true });
        // Recepción sigue sin poder.
        expect((await post(recepcion, '/reports/monthly-close', { month: '2024-08', reason: 'Cierre contable', password: PASSWORD })).statusCode).toBe(403);
      } finally {
        await db.user.updateMany({ where: { id: { in: gerentes.map((x) => x.id) } }, data: { isActive: true } });
      }
    });
  });

  describe('D-24 · una sola cuenta de la utilidad, con el costo de lo vendido', () => {
    it('utilidad = ganado − gastos de caja y faltantes − fijos − costo de lo vendido', async () => {
      const t = await tableroDe(owner, '2024-06');
      const m = t.money;
      expect(BigInt(m.profitCents)).toBe(BigInt(m.accruedCents) + BigInt(m.cashExpensesCents) + BigInt(m.fixedExpensesCents) + BigInt(m.costOfGoodsCents));
      expect(BigInt(m.costOfGoodsCents) <= 0n).toBe(true);
      expect(t.notes.soldWithoutCost).toBe(0);
    });
  });

  describe('D-25 · lo que la dueña consulta sin operar', () => {
    it('la deuda por sucursal, sin nombres', async () => {
      const socio = await socioPropio(g, g.sedes[1]!);
      await db.charge.create({ data: {
        id: uuidv7(), organizationId: g.organizationId, memberId: socio, branchId: g.sedes[1]!.id, chargeType: 'MANUAL_ADJUSTMENT', concept: 'Adeudo de prueba',
        subtotalCents: 45_000n, amountCents: 45_000n, dueDate: new Date('2024-01-10T00:00:00.000Z'), status: 'OVERDUE', createdByUserId: g.ownerId,
      } as never });
      const r = await get(owner, '/reports/pulse?fresh=1');
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(Pulse, r.json())).toEqual([]);
      const p = r.json() as Pulse;
      expect(p.owed.byBranch).toEqual([{ branchId: g.sedes[1]!.id, outstandingCents: '45000', membersBehind: 0 }]);
      expect(JSON.stringify(p.owed)).not.toMatch(/Socio|Propio/);

      // Y al firmar: desde cuándo es socio, cuánto debe y cuántas correcciones lleva. Solo quien firma.
      const brief = await get(owner, `/reports/signature-brief?resourceType=Member&resourceId=${socio}`);
      expect(brief.statusCode, brief.body).toBe(200);
      expect(diferenciasConElContrato(SignatureBrief, brief.json())).toEqual([]);
      expect(brief.json().member).toMatchObject({ outstandingCents: '45000', overdueCents: '45000', corrections: { last90Days: 0, total: 0 } });
      expect(brief.json().member.memberSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Por el cargo que se va a condonar llega al mismo socio; un retiro de caja o un registro ajeno no tocan a nadie.
      const cargo = await db.charge.findFirstOrThrow({ where: { organizationId: g.organizationId, memberId: socio } });
      expect((await get(owner, `/reports/signature-brief?resourceType=Charge&resourceId=${cargo.id}`)).json().member).toMatchObject({ outstandingCents: '45000' });
      expect((await get(owner, `/reports/signature-brief?resourceType=CashSession&resourceId=${uuidv7()}`)).json()).toEqual({ member: null });
      expect((await get(owner, `/reports/signature-brief?resourceType=Member&resourceId=${uuidv7()}`)).json()).toEqual({ member: null });
      expect((await get(gerente, `/reports/signature-brief?resourceType=Member&resourceId=${socio}`)).statusCode).toBe(403);
    });

    it('las ventas y existencias de la tienda, en cifras', async () => {
      const producto = uuidv7();
      await db.product.create({ data: { id: producto, organizationId: g.organizationId, sku: 'AGUA-600', name: 'Agua 600 ml', priceCents: 1_500n } });
      await db.inventoryStock.create({ data: { organizationId: g.organizationId, branchId: g.sedes[0]!.id, productId: producto, quantityOnHand: 0 } });
      const r = await get(owner, '/reports/store');
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(StoreSummary, r.json())).toEqual([]);
      const s = r.json() as StoreSummary;
      expect(s.products).toEqual({ active: 1, outOfStock: 1 });
      expect(s.stock).toEqual([{ productId: producto, branchId: g.sedes[0]!.id, name: 'Agua 600 ml', stock: 0 }]);
      expect(s.today).toEqual({ sales: 0, totalCents: '0' });
      // De la otra sucursal: nada. Recepción no ve las cifras del negocio.
      expect(((await get(owner, `/reports/store?branchId=${g.sedes[1]!.id}`)).json() as StoreSummary).stock).toEqual([]);
      expect((await get(recepcion, '/reports/store')).statusCode).toBe(403);
    });

    it('lee los textos legales completos sin abrir expedientes', async () => {
      const lista = await get(owner, '/consent-documents');
      expect(lista.statusCode, lista.body).toBe(200);
      const uno = lista.json().documents[0] as { id: string };
      const texto = await get(owner, `/consent-documents/${uno.id}`);
      expect(texto.statusCode, texto.body).toBe(200);
      expect(texto.json().bodyText.length).toBeGreaterThan(0);
      // No escribe ni publica, y lo firmado por cada socio sigue cerrado para ella.
      expect((await post(owner, '/consent-documents', { consentType: 'MARKETING', version: 'x1', title: 'Promociones', bodyText: 'Texto de promociones de prueba.' })).statusCode).toBe(403);
      const socio = await socioPropio(g);
      expect((await get(owner, `/members/${socio}/consents`)).statusCode).toBe(403);
      // Las solicitudes de privacidad, en cifras.
      expect((await get(owner, '/privacy/requests/summary')).statusCode).toBe(200);
    });

    it('el aviso de privacidad no se publica sin la firma de la dueña', async () => {
      const TODOS = LISTA_DEL_AVISO_DE_PRIVACIDAD.map((p) => p.clave);
      const modelo = modeloDeTexto('PRIVACY_NOTICE', { razonSocial: 'Gimnasio Propio, S.A. de C.V.', nombreComercial: 'Gimnasio Propio', sucursales: ['Centro', 'Norte'], mesesDeConservacion: 24 })!;
      const completo = modelo.texto.replace(/\[DOMICILIO COMPLETO\]/g, 'Av. Juárez 100, Centro, 06000, Ciudad de México').replace(/\[CORREO DE PRIVACIDAD\]/g, 'privacidad@propio.mx')
        .replace(/\[AGREGA AQUÍ[^\]]*\]/g, '').replace(/\[FECHA\]/g, '23 de noviembre de 2026');
      // Sin una tira larga de dígitos: una marca de tiempo puede pasar por número de tarjeta y la API la rechaza.
      const version = `f3-${uuidv7().slice(-8)}`;
      const creado = await post(gerente, '/consent-documents', { consentType: 'PRIVACY_NOTICE', version, title: modelo.titulo, bodyText: completo });
      expect(creado.statusCode, creado.body).toBe(201);
      const id = creado.json().id as string;
      const estado = async () => (await db.consentDocument.findUniqueOrThrow({ where: { id } })).status;
      const solicitudes = async (cookie: string) => {
        const r = await get(cookie, '/consent-documents/signature-requests');
        expect(r.statusCode, r.body).toBe(200);
        expect(diferenciasConElContrato(NoticeSignatureRequests, r.json())).toEqual([]);
        return r.json() as NoticeSignatureRequests;
      };
      const publicar = () => post(gerente, `/consent-documents/${id}/publish`, { reason: 'Aviso nuevo con el plazo de conservación', checklist: TODOS });

      // Sin revisar punto por punto no se pide la firma.
      expect((await post(gerente, `/consent-documents/${id}/publish`, { reason: 'Aviso nuevo' })).statusCode).toBe(422);

      // La gerencia «publica»: NO queda publicado, espera la firma.
      const pedido = await publicar();
      expect(pedido.statusCode, pedido.body).toBe(200);
      expect(diferenciasConElContrato(ConsentDocumentPublishResult, pedido.json())).toEqual([]);
      expect(pedido.json()).toMatchObject({ status: 'DRAFT', publishedAt: null, awaitingSignature: true });
      expect(await estado()).toBe('DRAFT');
      expect((await solicitudes(gerente))).toMatchObject({ canSign: false, requests: [{ documentId: id, status: 'PENDING', reason: 'Aviso nuevo con el plazo de conservación' }] });
      expect((await solicitudes(owner)).canSign).toBe(true);

      // La gerencia no firma; la dueña, con su contraseña y no con otra.
      expect((await post(gerente, `/consent-documents/${id}/sign`, { password: PASSWORD })).statusCode).toBe(403);
      expect((await post(owner, `/consent-documents/${id}/sign`, { password: 'no-es-mi-contraseña' })).statusCode).toBe(401);
      expect(await estado()).toBe('DRAFT');

      // Si el borrador cambia después de pedirla, esa firma ya no vale.
      expect((await app.inject({ method: 'PATCH', url: `/consent-documents/${id}`, headers: { cookie: gerente }, payload: { bodyText: `${completo}\n\nCambio de última hora.` } })).statusCode).toBe(200);
      expect((await solicitudes(owner)).requests[0]).toMatchObject({ status: 'STALE' });
      const vieja = await post(owner, `/consent-documents/${id}/sign`, { password: PASSWORD });
      expect(vieja.statusCode, vieja.body).toBe(409);
      expect(vieja.json()).toMatchObject({ reason: 'NOTICE_SIGNATURE_STALE' });
      expect(await estado()).toBe('DRAFT');

      // Se vuelve a pedir; la dueña dice que no, con su motivo, y la gerencia lo ve.
      expect((await publicar()).statusCode).toBe(200);
      expect((await post(owner, `/consent-documents/${id}/sign/reject`, { reason: 'Falta el correo de contacto' })).statusCode).toBe(200);
      expect((await solicitudes(gerente)).requests[0]).toMatchObject({ status: 'REJECTED', note: 'Falta el correo de contacto' });
      expect((await post(owner, `/consent-documents/${id}/sign`, { password: PASSWORD })).statusCode).toBe(409);

      // Tercera: la firma, y entonces sí queda publicado, con quién lo pidió y quién lo firmó.
      expect((await publicar()).statusCode).toBe(200);
      const firmado = await post(owner, `/consent-documents/${id}/sign`, { password: PASSWORD });
      expect(firmado.statusCode, firmado.body).toBe(200);
      expect(firmado.json()).toMatchObject({ status: 'PUBLISHED', awaitingSignature: false });
      expect(await estado()).toBe('PUBLISHED');
      const asiento = await db.auditLog.findFirstOrThrow({ where: { organizationId: g.organizationId, action: 'consent.document.publish', resourceId: id } });
      expect(asiento.actorUserId).toBe(g.ownerId);
      expect(asiento.afterState).toMatchObject({ signedByOwner: true, checklist: TODOS });
      expect((await solicitudes(owner)).requests[0]).toMatchObject({ status: 'SIGNED' });

      // Los demás textos los sigue publicando la gerencia, sin firma.
      const reglamento = await post(gerente, '/consent-documents', { consentType: 'HOUSE_RULES', version, title: 'Reglamento', bodyText: 'Reglamento de prueba: usa toalla y guarda las pesas.' });
      const directo = await post(gerente, `/consent-documents/${reglamento.json().id}/publish`, { reason: 'Reglamento nuevo' });
      expect(directo.statusCode, directo.body).toBe(200);
      expect(directo.json()).toMatchObject({ status: 'PUBLISHED', awaitingSignature: false });
    });
  });
});
