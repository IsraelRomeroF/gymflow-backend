import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ADJUSTABLE_PERMISSIONS, ROLE_PERMISSIONS, lockedPermissions, uuidv7 } from '@gymflow/core';
import {
  diferenciasConElContrato, Expense, ExpenseList, ExpensePayees, MonthlyClosePreview, RecurringExpense, RecurringExpenseList,
} from '@gymflow/core/contracts';
import { makeApp, loginAs, aprobacion, cuentaDePrueba } from './helpers.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * Auditoría 8, fase 4, bloque 4.5 · Nómina por pago y gastos que se repiten
 * (D-26), en un gimnasio propio.
 *
 * Sin reloj: lo que depende de «hoy» usa el `today` que responde la API (la
 * fecha de negocio del gimnasio), y lo de meses cerrados usa 2024.
 */
describe('4.5 · nómina por pago y gastos que se repiten', () => {
  let app: FastifyInstance; let g: GimnasioPropio;
  let owner: string; let gerente: string; let soloTablero: string; let recepcion: string; let coach: string;
  let idRecepcion: string; let nombreRecepcion: string;
  const db = getDb();
  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (cookie: string, url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers: { cookie }, payload });
  const gastosDe = async (cookie: string, mes: string) => {
    const r = await get(cookie, `/expenses?month=${mes}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(ExpenseList, r.json())).toEqual([]);
    return r.json() as ExpenseList;
  };
  const repetidosDe = async (cookie: string, mes: string) => {
    const r = await get(cookie, `/expenses/recurring?month=${mes}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(diferenciasConElContrato(RecurringExpenseList, r.json())).toEqual([]);
    return r.json() as RecurringExpenseList;
  };
  /** Los gastos fijos del mes entero según Movimientos (negativo). */
  const fijosDe = async (cookie: string, mes: string) => {
    const d = new Date(`${mes}-01T00:00:00.000Z`);
    const fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const r = await get(cookie, `/reports/daily?from=${mes}-01&to=${fin}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().totals.fixedExpensesCents as string;
  };
  const fijosDelTablero = async (cookie: string, mes: string) => {
    const d = new Date(`${mes}-01T00:00:00.000Z`);
    const fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    const r = await get(cookie, `/dashboard?from=${mes}-01&to=${fin}&fresh=1`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().money.fixedExpensesCents as string;
  };

  beforeAll(async () => {
    app = await makeApp(); await app.ready();
    g = await gimnasioPropio({ sedes: [{ name: 'Centro', cajas: 1 }, { name: 'Norte', cajas: 1 }] });
    // El segundo gerente tiene liberado SOLO el Tablero: ve el dinero, no Movimientos.
    await db.user.updateMany({ where: { organizationId: g.organizationId, email: g.correos.gerente2 }, data: { unlockedSections: ['tablero'] } });
    owner = await loginAs(app, g.correos.owner); gerente = await loginAs(app, g.correos.gerente);
    soloTablero = await loginAs(app, g.correos.gerente2); recepcion = await loginAs(app, g.correos.recepcion);
    coach = await loginAs(app, await cuentaDePrueba(g.organizationId, 'COACH', [g.sedes[0]!.id]));
    const r = await db.user.findFirstOrThrow({ where: { organizationId: g.organizationId, email: g.correos.recepcion }, select: { id: true, fullName: true } });
    idRecepcion = r.id; nombreRecepcion = r.fullName;
  });
  afterAll(async () => { await g.cerrar(); await app.close(); await closeDb(); });

  describe('la nómina se anota por pago: fecha, a quién y cuánto', () => {
    const MES = '2024-05';

    it('un pago a una persona del personal y otro a un nombre escrito; cuentan en el mes de su fecha', async () => {
      const aPersona = await post(owner, '/expenses', { category: 'PAYROLL', amountCents: '600000', branchId: g.sedes[0]!.id, paidOn: '2024-05-15', payeeUserId: idRecepcion });
      expect(aPersona.statusCode, aPersona.body).toBe(201);
      expect(diferenciasConElContrato(Expense, aPersona.json())).toEqual([]);
      expect(aPersona.json()).toMatchObject({ category: 'PAYROLL', month: MES, paidOn: '2024-05-15', payeeUserId: idRecepcion, payeeName: nombreRecepcion, description: 'Pago de nómina', amountCents: '600000', recurringId: null });

      const aNombre = await post(gerente, '/expenses', { category: 'PAYROLL', amountCents: '450000', branchId: null, paidOn: '2024-05-31', payeeName: '  Persona de Limpieza  ', description: 'Limpieza de mayo' });
      expect(aNombre.statusCode, aNombre.body).toBe(201);
      expect(aNombre.json()).toMatchObject({ month: MES, paidOn: '2024-05-31', payeeUserId: null, payeeName: 'Persona de Limpieza', description: 'Limpieza de mayo' });

      // Cuentan como cualquier gasto del mes: Movimientos y el Tablero dan lo mismo (D-24: las reglas no cambian).
      expect(await fijosDe(owner, MES)).toBe('-1050000');
      expect(await fijosDelTablero(owner, MES)).toBe('-1050000');
      expect(await fijosDe(owner, '2024-04')).toBe('0');
    });

    it('sin fecha o sin persona no se anota; ni con las dos formas de «a quién», ni a alguien de otro gimnasio, ni con fecha futura', async () => {
      const base = { category: 'PAYROLL', amountCents: '100000', branchId: null };
      const antes = await db.operatingExpense.count({ where: { organizationId: g.organizationId } });
      // Como se anotaba antes (un total del mes): ya no.
      expect((await post(owner, '/expenses', { ...base, description: 'Nómina de mayo', month: MES })).statusCode).toBe(422);
      expect((await post(owner, '/expenses', { ...base, paidOn: '2024-05-10' })).statusCode).toBe(422);
      expect((await post(owner, '/expenses', { ...base, payeeName: 'Alguien' })).statusCode).toBe(422);
      expect((await post(owner, '/expenses', { ...base, paidOn: '2024-05-10', payeeUserId: idRecepcion, payeeName: 'Alguien' })).statusCode).toBe(422);
      expect((await post(owner, '/expenses', { ...base, paidOn: '2024-05-10', payeeName: 'A' })).statusCode).toBe(422);
      expect((await post(owner, '/expenses', { ...base, paidOn: '2024-02-30', payeeName: 'Alguien' })).statusCode).toBe(422);
      // El mes sale de la fecha: no se puede mandar a otro.
      expect((await post(owner, '/expenses', { ...base, paidOn: '2024-05-10', payeeName: 'Alguien', month: '2024-06' })).statusCode).toBe(422);
      const manana = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      expect((await post(owner, '/expenses', { ...base, paidOn: manana, payeeName: 'Alguien' })).statusCode).toBe(422);
      // Una persona de otro gimnasio no existe para este.
      const ajeno = await db.user.findFirstOrThrow({ where: { email: 'recepcion@demo.mx' }, select: { id: true } });
      expect((await post(owner, '/expenses', { ...base, paidOn: '2024-05-10', payeeUserId: ajeno.id })).statusCode).toBe(404);
      // Y la fecha y la persona solo van en la nómina.
      expect((await post(owner, '/expenses', { category: 'RENT', description: 'Renta', amountCents: '100', month: MES, branchId: null, paidOn: '2024-05-10', payeeName: 'Arrendador' })).statusCode).toBe(422);
      expect((await post(owner, '/expenses', { category: 'RENT', amountCents: '100', month: MES, branchId: null })).statusCode).toBe(422);
      expect(await db.operatingExpense.count({ where: { organizationId: g.organizationId } })).toBe(antes);
    });

    it('la bitácora dice que hubo un pago de nómina y de cuánto, no a quién', async () => {
      const asientos = await db.auditLog.findMany({ where: { organizationId: g.organizationId, action: 'expense.payroll.pay' } });
      expect(asientos).toHaveLength(2);
      const texto = JSON.stringify(asientos.map((a) => [a.reason, a.beforeState, a.afterState]));
      expect(texto).not.toContain(nombreRecepcion);
      expect(texto).not.toContain('Persona de Limpieza');
      expect(texto).not.toContain(idRecepcion);
      expect(asientos.map((a) => (a.afterState as { amountCents: string }).amountCents).sort()).toEqual(['450000', '600000']);
    });

    it('quién ve cuánto se le paga a cada persona: la dueña y la gerencia con Movimientos; con solo el Tablero, el total; recepción y coach, nada', async () => {
      // Una nómina «de antes»: un total del mes, sin fecha ni persona (como las que ya existen).
      await db.operatingExpense.create({ data: { id: uuidv7(), organizationId: g.organizationId, branchId: null, category: 'PAYROLL', description: 'Nómina de mayo (total)', amountCents: 2_000_000n, periodMonth: new Date('2024-05-01'), createdByUserId: g.ownerId } });

      for (const cookie of [owner, gerente]) {
        const lista = await gastosDe(cookie, MES);
        expect(lista.hiddenPayroll).toBeNull();
        expect(lista.expenses.map((e) => e.payeeName).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([nombreRecepcion, 'Persona de Limpieza', null].sort((a, b) => String(a).localeCompare(String(b))));
      }
      // Con solo el Tablero: ve el dinero (y la nómina de antes, que no nombra a nadie), no los pagos por persona.
      const sinMovimientos = await gastosDe(soloTablero, MES);
      expect(sinMovimientos.expenses.map((e) => e.description)).toEqual(['Nómina de mayo (total)']);
      expect(sinMovimientos.hiddenPayroll).toEqual({ count: 2, amountCents: '1050000' });
      expect(JSON.stringify(sinMovimientos)).not.toContain(nombreRecepcion);
      // La cifra es la misma para los dos: lo oculto cuenta.
      expect(await fijosDe(soloTablero, MES)).toBe('-3050000');
      expect(await fijosDe(gerente, MES)).toBe('-3050000');
      // No anota ni ve la lista del personal.
      expect((await post(soloTablero, '/expenses', { category: 'OTHER', description: 'Algo', amountCents: '100', month: MES, branchId: null })).statusCode).toBe(403);
      expect((await get(soloTablero, '/expenses/payees')).statusCode).toBe(403);

      for (const cookie of [recepcion, coach]) {
        expect((await get(cookie, `/expenses?month=${MES}`)).statusCode).toBe(403);
        expect((await get(cookie, `/expenses/recurring?month=${MES}`)).statusCode).toBe(403);
        expect((await get(cookie, '/expenses/payees')).statusCode).toBe(403);
        expect((await post(cookie, '/expenses', { category: 'PAYROLL', amountCents: '100', branchId: g.sedes[0]!.id, paidOn: '2024-05-10', payeeName: 'Alguien' })).statusCode).toBe(403);
      }
      // Y no hay interruptor que se lo encienda: ni su puesto lo trae ni está entre lo ajustable por persona.
      for (const p of ['expenses:payroll:read', 'expenses:manage', 'reports:financial:read'] as const) {
        expect(ADJUSTABLE_PERMISSIONS.has(p), p).toBe(false);
        expect(ROLE_PERMISSIONS.RECEPTION).not.toContain(p);
        expect(ROLE_PERMISSIONS.COACH).not.toContain(p);
      }
      expect(ROLE_PERMISSIONS.OWNER).toContain('expenses:payroll:read');
      // La llave: con el Tablero se conserva ver el dinero y se pierde la nómina por persona; con Movimientos, las dos.
      expect(lockedPermissions(['tablero'], ['MANAGER']).has('expenses:payroll:read')).toBe(true);
      expect(lockedPermissions(['tablero'], ['MANAGER']).has('reports:financial:read')).toBe(false);
      expect(lockedPermissions(['movimientos'], ['MANAGER']).has('expenses:payroll:read')).toBe(false);
    });

    it('a quién se le puede pagar: el personal del gimnasio, activo o no, con nombre y puesto', async () => {
      const r = await get(owner, '/expenses/payees');
      expect(r.statusCode, r.body).toBe(200);
      expect(diferenciasConElContrato(ExpensePayees, r.json())).toEqual([]);
      const personas = (r.json() as ExpensePayees).payees;
      expect(personas.find((p) => p.id === idRecepcion)).toMatchObject({ name: nombreRecepcion, role: 'Recepción', active: true });
      expect(personas.length).toBe(await db.user.count({ where: { organizationId: g.organizationId } }));
      expect(r.body).not.toContain('@');
    });
  });

  describe('un mes cerrado no se toca: lo propuesto y sin confirmar no entró en la foto, y lo tardío es un ajuste', () => {
    const MES = '2024-03';
    let renta: string; let quincena: string;

    it('la revisión del cierre avisa de lo que sigue por confirmar, y la foto no lo cuenta', async () => {
      // Dos gastos que se repiten desde marzo de 2024 (por la API solo se dejan desde el mes en curso).
      renta = uuidv7(); quincena = uuidv7();
      await db.recurringExpense.createMany({ data: [
        { id: renta, organizationId: g.organizationId, branchId: null, category: 'RENT', description: 'Renta del local', amountCents: 800_000n, frequency: 'MONTHLY', startsOn: new Date('2024-03-01'), createdByUserId: g.ownerId },
        { id: quincena, organizationId: g.organizationId, branchId: g.sedes[0]!.id, category: 'PAYROLL', description: 'Pago de nómina', amountCents: 300_000n, frequency: 'BIWEEKLY', startsOn: new Date('2024-03-01'), payeeUserId: idRecepcion, payeeName: nombreRecepcion, createdByUserId: g.ownerId },
      ] });
      const lista = await repetidosDe(owner, MES);
      expect(lista.proposals.map((p) => `${p.dueOn} ${p.status}`)).toEqual(['2024-03-01 PENDING', '2024-03-15 PENDING', '2024-03-31 PENDING']);
      expect(lista).toMatchObject({ pending: 3, closed: false });
      // Nada se anotó solo: ni una fila de gasto, ni un peso en las cifras.
      expect(await db.operatingExpense.count({ where: { organizationId: g.organizationId, periodMonth: new Date('2024-03-01') } })).toBe(0);
      expect(await fijosDe(owner, MES)).toBe('0');
      expect(await fijosDelTablero(owner, MES)).toBe('0');

      const previa = await get(gerente, `/reports/monthly-close/preview?month=${MES}`);
      expect(diferenciasConElContrato(MonthlyClosePreview, previa.json())).toEqual([]);
      const p = previa.json() as MonthlyClosePreview;
      expect(p.closable).toBe(true);
      expect(p.warnings.find((w) => w.code === 'EXPENSES_TO_CONFIRM')?.message).toContain('Hay 3 gastos que se repiten por confirmar');

      const token = await aprobacion(app, gerente, 'reports:month:close', g.correos.owner);
      const cierre = await post(gerente, '/reports/monthly-close', { month: MES, reason: 'Cierre contable del mes', approvalToken: token });
      expect(cierre.statusCode, cierre.body).toBe(201);
      expect(cierre.json().totals).toMatchObject({ fixedExpensesCents: '0' });
    });

    it('confirmar tarde una propuesta de ese mes: 409 y, como ajuste, cae en el mes en curso etiquetada', async () => {
      const directo = await post(owner, '/expenses/recurring/confirm', { recurringId: renta, dueOn: '2024-03-01' });
      expect(directo.statusCode, directo.body).toBe(409);
      expect(directo.json()).toMatchObject({ reason: 'MONTH_CLOSED' });
      const ajuste = await post(owner, '/expenses/recurring/confirm', { recurringId: renta, dueOn: '2024-03-01', asAdjustment: true });
      expect(ajuste.statusCode, ajuste.body).toBe(201);
      const enCurso = (await repetidosDe(owner, MES)).currentMonth;
      expect(ajuste.json()).toMatchObject({ month: enCurso, adjustsMonth: MES, amountCents: '800000', recurringId: renta, category: 'RENT', paidOn: null });

      // El pago de la quincena del 15: su fecha cae en el mes cerrado, también es ajuste.
      expect((await post(owner, '/expenses/recurring/confirm', { recurringId: quincena, dueOn: '2024-03-15' })).json()).toMatchObject({ reason: 'MONTH_CLOSED' });
      const pago = await post(owner, '/expenses/recurring/confirm', { recurringId: quincena, dueOn: '2024-03-15', asAdjustment: true });
      expect(pago.statusCode, pago.body).toBe(201);
      expect(pago.json()).toMatchObject({ month: enCurso, adjustsMonth: MES, paidOn: '2024-03-15', payeeUserId: idRecepcion, payeeName: nombreRecepcion, amountCents: '300000' });
      // La del 31 se pagó el 2 de abril, que sigue abierto: cuenta en abril, sin ajuste.
      const abril = await post(owner, '/expenses/recurring/confirm', { recurringId: quincena, dueOn: '2024-03-31', paidOn: '2024-04-02', amountCents: '280000' });
      expect(abril.statusCode, abril.body).toBe(201);
      expect(abril.json()).toMatchObject({ month: '2024-04', adjustsMonth: null, paidOn: '2024-04-02', amountCents: '280000' });

      const lista = await repetidosDe(owner, MES);
      expect(lista.proposals.map((p) => p.status)).toEqual(['CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
      expect(lista).toMatchObject({ pending: 0, closed: true });
      // Corregir el importe una vez no cambió la plantilla.
      expect(lista.recurring.find((r) => r.id === quincena)).toMatchObject({ amountCents: '300000', payeeInactive: false });
      // El mes cerrado sigue en cero; abril trae su pago.
      expect(await fijosDelTablero(owner, MES)).toBe('0');
      expect(await fijosDe(owner, '2024-04')).toBe('-280000');
    });

    it('dejar de repetir: no propone nada más y lo confirmado no cambia', async () => {
      expect((await repetidosDe(owner, '2024-04')).proposals.filter((p) => p.status === 'PENDING')).toHaveLength(3);
      expect((await post(owner, '/expenses/recurring/end', { recurringId: renta })).statusCode).toBe(422);
      expect((await post(recepcion, '/expenses/recurring/end', { recurringId: renta, reason: 'Nos cambiamos de local' })).statusCode).toBe(403);
      for (const id of [renta, quincena]) expect((await post(owner, '/expenses/recurring/end', { recurringId: id, reason: 'Ya no se paga' })).statusCode).toBe(200);
      expect((await post(owner, '/expenses/recurring/end', { recurringId: renta, reason: 'Ya no se paga' })).json()).toMatchObject({ reason: 'EXPENSE_PROPOSAL_RESOLVED' });
      expect(await repetidosDe(owner, '2024-04')).toMatchObject({ recurring: [], proposals: [], pending: 0 });
      expect(await fijosDe(owner, '2024-04')).toBe('-280000');
      expect((await post(owner, '/expenses/recurring/confirm', { recurringId: renta, dueOn: '2024-04-01' })).statusCode).toBe(409);
      expect((await post(owner, '/expenses/recurring/confirm', { recurringId: uuidv7(), dueOn: '2024-04-01' })).statusCode).toBe(404);
    });
  });

  describe('lo que se repite se propone «por confirmar»: nada se anota solo', () => {
    let mes: string; let hoy: string; let renta: string;

    it('un gasto que «se repite cada mes» nace confirmado para este mes; si se anula, vuelve a quedar por confirmar', async () => {
      const inicio = await gastosDe(owner, '2024-01');
      mes = inicio.currentMonth; hoy = inicio.today;
      const base = (await gastosDe(owner, mes)).expenses.length;
      const r = await post(gerente, '/expenses', { category: 'RENT', description: 'Renta de Norte', amountCents: '1000000', month: mes, branchId: g.sedes[1]!.id, repeat: 'MONTHLY' });
      expect(r.statusCode, r.body).toBe(201);
      renta = r.json().recurringId;
      expect(renta).toBeTruthy();
      let lista = await repetidosDe(owner, mes);
      expect(lista.recurring.map((x) => x.id)).toEqual([renta]);
      expect(lista.recurring[0]).toMatchObject({ category: 'RENT', frequency: 'MONTHLY', startsOn: `${mes}-01`, amountCents: '1000000', branchId: g.sedes[1]!.id, payeeName: null });
      expect(lista.proposals).toEqual([{ recurringId: renta, dueOn: `${mes}-01`, status: 'CONFIRMED', expenseId: r.json().id, skippedAt: null, skippedByName: null, skipReason: null }]);
      expect(lista.pending).toBe(0);

      expect((await post(gerente, `/expenses/${r.json().id}/void`, { reason: 'Se capturó con otro importe' })).statusCode).toBe(200);
      lista = await repetidosDe(owner, mes);
      expect(lista.proposals.map((p) => p.status)).toEqual(['PENDING']);
      expect(lista.pending).toBe(1);
      // Por confirmar = no cuenta: ni en la lista de gastos vigentes ni en ninguna cifra.
      expect((await gastosDe(owner, mes)).expenses.filter((e) => !e.voidedAt)).toHaveLength(base);
      const sinRenta = await fijosDelTablero(owner, mes);

      // Se confirma corrigiendo el importe, y se pide que quede para las siguientes.
      const ok = await post(owner, '/expenses/recurring/confirm', { recurringId: renta, dueOn: `${mes}-01`, amountCents: '1200000', keepAmount: true });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(ok.json()).toMatchObject({ month: mes, amountCents: '1200000', recurringId: renta, description: 'Renta de Norte', adjustsMonth: null });
      expect(BigInt(await fijosDelTablero(owner, mes))).toBe(BigInt(sinRenta) - 1_200_000n);
      expect((await repetidosDe(owner, mes)).recurring[0]).toMatchObject({ amountCents: '1200000' });
      // Dos veces, no.
      const otra = await post(owner, '/expenses/recurring/confirm', { recurringId: renta, dueOn: `${mes}-01` });
      expect(otra.statusCode, otra.body).toBe(409);
      expect(otra.json()).toMatchObject({ reason: 'EXPENSE_PROPOSAL_RESOLVED' });
      expect((await post(owner, '/expenses/recurring/skip', { recurringId: renta, dueOn: `${mes}-01` })).json()).toMatchObject({ reason: 'EXPENSE_PROPOSAL_RESOLVED' });
      // Un día que no le toca, tampoco; ni un mes que todavía no llega.
      expect((await post(owner, '/expenses/recurring/confirm', { recurringId: renta, dueOn: `${mes}-02` })).statusCode).toBe(422);
      const d = new Date(`${mes}-01T00:00:00.000Z`);
      const siguiente = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
      expect((await post(owner, '/expenses/recurring/confirm', { recurringId: renta, dueOn: siguiente })).statusCode).toBe(422);
      expect(await repetidosDe(owner, siguiente.slice(0, 7))).toMatchObject({ pending: 0 });
      const asientos = await db.auditLog.findMany({ where: { organizationId: g.organizationId, resourceId: renta }, select: { action: true } });
      expect(asientos.map((a) => a.action).sort()).toEqual(['expense.recurring.create', 'expense.recurring.update']);
    });

    it('la nómina fija de una persona, cada semana: se propone cada vencimiento; se descarta con quién y por qué; lo que no ha llegado no se toca', async () => {
      const r = await post(owner, '/expenses/recurring', { category: 'PAYROLL', amountCents: '250000', branchId: g.sedes[0]!.id, frequency: 'WEEKLY', startsOn: `${mes}-01`, payeeUserId: idRecepcion });
      expect(r.statusCode, r.body).toBe(201);
      expect(diferenciasConElContrato(RecurringExpense, r.json())).toEqual([]);
      const semanal = r.json().id as string;
      expect(r.json()).toMatchObject({ payeeName: nombreRecepcion, description: 'Pago de nómina', frequency: 'WEEKLY' });
      // Dejarlo no anota nada.
      expect(await db.operatingExpense.count({ where: { organizationId: g.organizationId, recurringId: semanal } })).toBe(0);

      const lista = await repetidosDe(owner, mes);
      const mias = lista.proposals.filter((p) => p.recurringId === semanal);
      const dias = [1, 8, 15, 22, 29].map((n) => `${mes}-${String(n).padStart(2, '0')}`).filter((f) => !Number.isNaN(Date.parse(f)) && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f);
      expect(mias.map((p) => p.dueOn)).toEqual(dias);
      expect(mias.every((p) => p.status === 'PENDING')).toBe(true);
      const yaTocaron = dias.filter((f) => f <= hoy);
      expect(lista.pending).toBe(yaTocaron.length);

      // Descartar la primera: queda quién y por qué, y deja de estar por confirmar.
      const fuera = await post(gerente, '/expenses/recurring/skip', { recurringId: semanal, dueOn: `${mes}-01`, reason: 'Esa semana no trabajó' });
      expect(fuera.statusCode, fuera.body).toBe(200);
      const despues = await repetidosDe(owner, mes);
      expect(despues.proposals.find((p) => p.recurringId === semanal && p.dueOn === `${mes}-01`)).toMatchObject({ status: 'SKIPPED', skipReason: 'Esa semana no trabajó', expenseId: null });
      expect(despues.proposals.find((p) => p.recurringId === semanal && p.dueOn === `${mes}-01`)!.skippedByName).toBeTruthy();
      expect(despues.pending).toBe(yaTocaron.length - 1);
      expect((await post(owner, '/expenses/recurring/confirm', { recurringId: semanal, dueOn: `${mes}-01` })).json()).toMatchObject({ reason: 'EXPENSE_PROPOSAL_RESOLVED' });
      expect(await db.operatingExpense.count({ where: { organizationId: g.organizationId, recurringId: semanal } })).toBe(0);
      // La que todavía no llega (si el mes aún tiene alguna) ni se confirma ni se descarta.
      const futura = dias.find((f) => f > hoy);
      if (futura) {
        expect((await post(owner, '/expenses/recurring/confirm', { recurringId: semanal, dueOn: futura })).statusCode).toBe(422);
        expect((await post(owner, '/expenses/recurring/skip', { recurringId: semanal, dueOn: futura })).statusCode).toBe(422);
      }
      // Quien no tiene Movimientos no ve la nómina que se repite; sí la renta de su alcance.
      const sinMovimientos = await repetidosDe(soloTablero, mes);
      expect(sinMovimientos.recurring.map((x) => x.id)).toEqual([renta]);
      expect(JSON.stringify(sinMovimientos)).not.toContain(nombreRecepcion);
    });

    it('lo que no se puede dejar repitiéndose', async () => {
      const base = { amountCents: '100000', branchId: null, startsOn: `${mes}-01` };
      // Hacia atrás no: propondría de golpe meses enteros.
      expect((await post(owner, '/expenses/recurring', { ...base, category: 'RENT', description: 'Renta vieja', frequency: 'MONTHLY', startsOn: '2024-01-01' })).statusCode).toBe(422);
      expect((await post(owner, '/expenses', { category: 'RENT', description: 'Renta vieja', amountCents: '100000', month: '2024-01', branchId: null, repeat: 'MONTHLY' })).statusCode).toBe(422);
      expect((await post(owner, '/expenses', { category: 'PAYROLL', amountCents: '100000', branchId: null, paidOn: '2024-01-15', payeeName: 'Alguien', repeat: 'WEEKLY' })).statusCode).toBe(422);
      // Cada semana o cada quincena es para la nómina.
      expect((await post(owner, '/expenses/recurring', { ...base, category: 'UTILITIES', description: 'Luz', frequency: 'WEEKLY' })).statusCode).toBe(422);
      // El retiro del dueño no es un gasto.
      expect((await post(owner, '/expenses/recurring', { ...base, category: 'OWNER_DRAW', description: 'Retiro', frequency: 'MONTHLY' })).statusCode).toBe(422);
      expect((await post(owner, '/expenses', { category: 'OWNER_DRAW', description: 'Retiro del mes', amountCents: '100000', month: mes, branchId: null, repeat: 'MONTHLY' })).statusCode).toBe(422);
      // La nómina que se repite es de una persona.
      expect((await post(owner, '/expenses/recurring', { ...base, category: 'PAYROLL', frequency: 'BIWEEKLY' })).statusCode).toBe(422);
      // Y recepción no deja nada.
      expect((await post(recepcion, '/expenses/recurring', { ...base, category: 'RENT', description: 'Renta', frequency: 'MONTHLY', branchId: g.sedes[0]!.id })).statusCode).toBe(403);
    });
  });
});
