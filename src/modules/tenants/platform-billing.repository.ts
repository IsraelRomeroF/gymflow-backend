import { uuidv7 } from '@gymflow/core';
import { GlobalRepository } from '../../platform/db/tenant-repository.js';

/**
 * Un renglón. Desde D-39 (bloque 4.9) puede decir de qué clase es: un mes
 * completo (CHARGE o nada), cobrado por días (PRORATED), los días de un mes
 * anterior (CATCH_UP) o el descuento, en negativo (DISCOUNT).
 */
export type LineaFactura = { key: string; name: string; monthlyCents: string; kind?: 'CHARGE' | 'PRORATED' | 'CATCH_UP' | 'DISCOUNT'; listCents?: string; days?: number; ofDays?: number };
export type Factura = {
  id: string; organizationId: string; folio: string; periodStart: Date; periodEnd: Date; lines: LineaFactura[];
  totalCents: bigint; paidCents: bigint; status: string; issuedAt: Date; dueDate: Date; paidAt: Date | null;
  paymentMethod: string | null; paymentRef: string | null; note: string | null; voidReason: string | null;
  /** D-39: el desglose. `subtotalCents` null = emitida antes de D-39, por un total sin desglose. `totalCents` es siempre lo que se paga. */
  subtotalCents: bigint | null; taxCents: bigint; taxRateBps: number; taxIncluded: boolean; discountCents: bigint;
  /** Los datos fiscales del gimnasio y de GymFlow como estaban al emitir. */
  receiver: unknown; issuer: unknown;
};
/** Un pago (o abono) de una factura. `undoneAt` = se deshizo: no cuenta. */
export type Pago = {
  id: string; invoiceId: string; amountCents: bigint; paymentMethod: string; paymentRef: string | null;
  paidOn: Date; note: string | null; createdAt: Date; createdByUserId: string | null;
  undoneAt: Date | null; undoneByUserId: string | null; undoReason: string | null;
};
export type MarcaParaCobro = {
  id: string; tradeName: string; serviceStatus: string; activatedAt: Date | null; createdAt: Date;
  /** Prórroga de la suspensión automática (D-37) y si la suspensión vigente la hizo el sistema. */
  autoSuspendHoldUntil: Date | null; suspendedAutomatically: boolean;
  /** El plan y la versión que la marca tiene de él (D-38). */
  platformPlanId: string | null; platformPlanSnapshot: unknown;
  /** Sus datos fiscales, de la ficha de marca (D-27, bloque 4.6): salen en la factura (D-39). */
  legalName: string; rfc: string | null;
};

const SELECT = {
  id: true, organizationId: true, folio: true, periodStart: true, periodEnd: true, lines: true, totalCents: true, paidCents: true, status: true,
  issuedAt: true, dueDate: true, paidAt: true, paymentMethod: true, paymentRef: true, note: true, voidReason: true,
  subtotalCents: true, taxCents: true, taxRateBps: true, taxIncluded: true, discountCents: true, receiver: true, issuer: true,
} as const;
const SELECT_PAGO = {
  id: true, invoiceId: true, amountCents: true, paymentMethod: true, paymentRef: true, paidOn: true, note: true,
  createdAt: true, createdByUserId: true, undoneAt: true, undoneByUserId: true, undoReason: true,
} as const;
const SELECT_MARCA = {
  id: true, tradeName: true, serviceStatus: true, activatedAt: true, createdAt: true,
  autoSuspendHoldUntil: true, suspendedAutomatically: true, platformPlanId: true, platformPlanSnapshot: true, legalName: true, rfc: true,
} as const;

/** Un día de calendario (`AAAA-MM-DD`) como lo guarda una columna DATE. */
const dia = (fecha: string): Date => new Date(`${fecha}T00:00:00.000Z`);

export type ResultadoDePago =
  | { ok: true; pago: Pago; factura: Factura }
  | { ok: false; por: 'NO_EXISTE' | 'PAGADA' | 'ANULADA' | 'EXCEDE'; saldoCents?: bigint };
export type ResultadoDeDeshacer =
  | { ok: true; pago: Pago; factura: Factura }
  | { ok: false; por: 'NO_EXISTE' | 'YA_DESHECHO' | 'ANULADA' | 'FUERA_DE_PLAZO' };

/**
 * COBRO DE LA PLATAFORMA A LAS MARCAS (ADR-038). Es global: lo opera quien
 * lleva GymFlow, no el personal de ningún gimnasio.
 */
export class PlatformBillingRepository extends GlobalRepository {
  async prices(): Promise<Map<string, bigint>> {
    const filas = await this.db.platformPrice.findMany({ select: { moduleKey: true, monthlyCents: true } });
    return new Map(filas.map((f) => [f.moduleKey, f.monthlyCents]));
  }

  /**
   * Fija varios precios en UNA transacción (23-09): o cambian todos o ninguno.
   * Devuelve lo que de verdad cambió, con el precio de antes, para el asiento.
   */
  async setPrices(cambios: ReadonlyArray<{ moduleKey: string; monthlyCents: bigint }>, byUserId: string | null): Promise<Array<{ moduleKey: string; beforeCents: bigint | null; afterCents: bigint }>> {
    return this.db.$transaction(async (tx) => {
      const antes = new Map((await tx.platformPrice.findMany({ where: { moduleKey: { in: cambios.map((c) => c.moduleKey) } }, select: { moduleKey: true, monthlyCents: true } })).map((f) => [f.moduleKey, f.monthlyCents]));
      const hechos: Array<{ moduleKey: string; beforeCents: bigint | null; afterCents: bigint }> = [];
      for (const c of cambios) {
        const previo = antes.get(c.moduleKey) ?? null;
        if (previo === c.monthlyCents) continue;
        await tx.platformPrice.upsert({
          where: { moduleKey: c.moduleKey },
          create: { moduleKey: c.moduleKey, monthlyCents: c.monthlyCents, updatedByUserId: byUserId },
          update: { monthlyCents: c.monthlyCents, updatedByUserId: byUserId, updatedAt: new Date() },
        });
        hechos.push({ moduleKey: c.moduleKey, beforeCents: previo, afterCents: c.monthlyCents });
      }
      return hechos;
    });
  }

  invoices(organizationId: string): Promise<Factura[]> {
    return this.db.platformInvoice.findMany({ where: { organizationId }, select: SELECT, orderBy: [{ periodStart: 'desc' }, { folio: 'desc' }] }) as unknown as Promise<Factura[]>;
  }

  invoice(id: string): Promise<Factura | null> {
    return this.db.platformInvoice.findFirst({ where: { id }, select: SELECT }) as unknown as Promise<Factura | null>;
  }

  /** Los pagos de una factura, vivos y deshechos, del más viejo al más nuevo. */
  payments(invoiceId: string): Promise<Pago[]> {
    return this.db.platformPayment.findMany({ where: { invoiceId }, select: SELECT_PAGO, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  }

  /** Todas las facturas de todas las marcas (DP-03), filtradas por estado o mes. */
  all(filtro: { status?: string | undefined; periodStart?: string | undefined } = {}): Promise<Array<Factura & { tradeName: string }>> {
    return this.db.platformInvoice.findMany({
      where: { ...(filtro.status ? { status: filtro.status } : {}), ...(filtro.periodStart ? { periodStart: dia(filtro.periodStart) } : {}) },
      select: { ...SELECT, organization: { select: { tradeName: true } } },
      orderBy: [{ periodStart: 'desc' }, { folio: 'desc' }], take: 2000,
    }).then((xs) => xs.map(({ organization, ...f }) => ({ ...f, tradeName: organization.tradeName }))) as unknown as Promise<Array<Factura & { tradeName: string }>>;
  }

  /** Marcas con factura VIVA de ese periodo, en una consulta (la emisión mensual recorre todas). */
  async organizationsWithInvoiceFor(periodStart: string): Promise<Set<string>> {
    const rows = await this.db.platformInvoice.findMany({ where: { periodStart: dia(periodStart), status: { not: 'VOID' } }, select: { organizationId: true } });
    return new Set(rows.map((r) => r.organizationId));
  }

  /**
   * Lo que hace falta para el estado de cobro de TODAS las marcas en una
   * consulta: lo que deben y la factura viva del mes en curso.
   */
  forStatus(periodStart: string): Promise<Factura[]> {
    return this.db.platformInvoice.findMany({
      where: { OR: [{ status: 'PENDING' }, { periodStart: dia(periodStart), status: { not: 'VOID' } }] }, select: SELECT,
    }) as unknown as Promise<Factura[]>;
  }

  /** Marcas en uso: a ellas se les factura cada mes. */
  activeOrganizations(): Promise<MarcaParaCobro[]> {
    return this.db.organization.findMany({ where: { deletedAt: null, serviceStatus: 'ACTIVE' }, select: SELECT_MARCA, orderBy: { tradeName: 'asc' } });
  }

  /** Todas las marcas (en uso o no), para el estado de cobro de la lista. */
  organizations(): Promise<MarcaParaCobro[]> {
    return this.db.organization.findMany({ where: { deletedAt: null }, select: SELECT_MARCA, orderBy: { tradeName: 'asc' } });
  }

  /**
   * Lo que cada marca tiene contratado, de TODAS a la vez (22-15): su plan y lo
   * que la plataforma marcó como no contratado. Dos consultas en total; antes
   * el panorama preguntaba esto marca por marca (hasta seis consultas cada una).
   */
  async contratacion(): Promise<Map<string, { planId: string | null; noContratados: Set<string> }>> {
    const [marcas, negados] = await Promise.all([
      this.db.organization.findMany({ where: { deletedAt: null }, select: { id: true, platformPlanId: true } }),
      this.db.organizationEntitlement.findMany({ where: { granted: false }, select: { organizationId: true, moduleKey: true } }),
    ]);
    const mapa = new Map(marcas.map((m) => [m.id, { planId: m.platformPlanId as string | null, noContratados: new Set<string>() }]));
    for (const n of negados) mapa.get(n.organizationId)?.noContratados.add(n.moduleKey);
    return mapa;
  }

  organization(id: string): Promise<MarcaParaCobro | null> {
    return this.db.organization.findFirst({ where: { id, deletedAt: null }, select: SELECT_MARCA });
  }

  /** Lo pendiente de todas las marcas, para la portada de la plataforma. */
  pending(): Promise<Array<Factura & { tradeName: string }>> {
    return this.db.platformInvoice.findMany({
      where: { status: 'PENDING' }, select: { ...SELECT, organization: { select: { tradeName: true } } }, orderBy: { dueDate: 'asc' },
    }).then((xs) => xs.map(({ organization, ...f }) => ({ ...f, tradeName: organization.tradeName }))) as unknown as Promise<Array<Factura & { tradeName: string }>>;
  }

  /** Emite la factura del periodo. El folio es correlativo por año; la unicidad la garantiza la base. */
  async issue(input: {
    organizationId: string; periodStart: string; periodEnd: string; lines: LineaFactura[]; totalCents: bigint; dueDate: string; note: string | null; byUserId: string | null;
    /** D-39: el desglose y los datos fiscales se congelan con la factura. Sin desglose, el subtotal es el total (sin IVA ni descuento). */
    subtotalCents?: bigint; taxCents?: bigint; taxRateBps?: number; taxIncluded?: boolean; discountCents?: bigint; receiver?: object | null; issuer?: object | null;
  }): Promise<Factura> {
    return this.db.$transaction(async (tx) => {
      const anio = input.periodStart.slice(0, 4);
      // Candado por año: dos emisiones a la vez no se pelean el folio.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`platform_invoices_${anio}`}))`;
      const emitidas = await tx.platformInvoice.count({ where: { folio: { startsWith: `GF-${anio}-` } } });
      const folio = `GF-${anio}-${String(emitidas + 1).padStart(6, '0')}`;
      const creada = await tx.platformInvoice.create({
        data: {
          id: uuidv7(), organizationId: input.organizationId, folio, periodStart: dia(input.periodStart), periodEnd: dia(input.periodEnd),
          lines: input.lines, totalCents: input.totalCents, dueDate: dia(input.dueDate), note: input.note, createdByUserId: input.byUserId,
          subtotalCents: input.subtotalCents ?? input.totalCents, taxCents: input.taxCents ?? 0n, taxRateBps: input.taxRateBps ?? 0, taxIncluded: input.taxIncluded ?? false, discountCents: input.discountCents ?? 0n,
          ...(input.receiver ? { receiver: input.receiver } : {}), ...(input.issuer ? { issuer: input.issuer } : {}),
        },
        select: SELECT,
      });
      return creada as unknown as Factura;
    });
  }

  /**
   * Registra un pago o un abono (23-08). Todo en una transacción con la
   * factura bajo candado: dos capturas a la vez no pasan del total. Sin
   * `amountCents` se paga lo que falta. Al completarse, la factura queda PAID.
   */
  async registerPayment(invoiceId: string, input: { amountCents: bigint | null; paidOn: string; paymentMethod: string; paymentRef: string | null; note: string | null; byUserId: string | null }): Promise<ResultadoDePago> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "platform_invoices" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`;
      const f = await tx.platformInvoice.findFirst({ where: { id: invoiceId }, select: SELECT }) as unknown as Factura | null;
      if (!f) return { ok: false as const, por: 'NO_EXISTE' as const };
      if (f.status === 'PAID') return { ok: false as const, por: 'PAGADA' as const };
      if (f.status !== 'PENDING') return { ok: false as const, por: 'ANULADA' as const };
      const saldo = f.totalCents - f.paidCents;
      const importe = input.amountCents ?? saldo;
      if (importe <= 0n || importe > saldo) return { ok: false as const, por: 'EXCEDE' as const, saldoCents: saldo };
      const pago = await tx.platformPayment.create({
        data: {
          id: uuidv7(), invoiceId, organizationId: f.organizationId, amountCents: importe, paymentMethod: input.paymentMethod,
          paymentRef: input.paymentRef, paidOn: dia(input.paidOn), note: input.note, createdByUserId: input.byUserId,
        },
        select: SELECT_PAGO,
      });
      const pagado = f.paidCents + importe;
      const factura = await tx.platformInvoice.update({
        where: { id: invoiceId },
        data: {
          paidCents: pagado, status: pagado === f.totalCents ? 'PAID' : 'PENDING',
          // Los datos del último pago; la hora no la captura nadie: mediodía UTC cae en ese mismo día en México (23-15).
          paidAt: new Date(`${input.paidOn}T12:00:00.000Z`), paymentMethod: input.paymentMethod, paymentRef: input.paymentRef,
        },
        select: SELECT,
      }) as unknown as Factura;
      return { ok: true as const, pago, factura };
    });
  }

  /**
   * Deshace un pago registrado por error (23-07): el pago queda con su motivo,
   * no se borra, y la factura vuelve a deber ese importe. `desde` es el
   * instante más viejo de registro que todavía se puede deshacer.
   */
  async undoPayment(invoiceId: string, paymentId: string, input: { reason: string; byUserId: string | null; desde: Date }): Promise<ResultadoDeDeshacer> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "platform_invoices" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`;
      const f = await tx.platformInvoice.findFirst({ where: { id: invoiceId }, select: SELECT }) as unknown as Factura | null;
      const p = await tx.platformPayment.findFirst({ where: { id: paymentId, invoiceId }, select: SELECT_PAGO });
      if (!f || !p) return { ok: false as const, por: 'NO_EXISTE' as const };
      if (p.undoneAt) return { ok: false as const, por: 'YA_DESHECHO' as const };
      if (f.status === 'VOID') return { ok: false as const, por: 'ANULADA' as const };
      if (p.createdAt.getTime() < input.desde.getTime()) return { ok: false as const, por: 'FUERA_DE_PLAZO' as const };
      const pago = await tx.platformPayment.update({
        where: { id: paymentId }, data: { undoneAt: new Date(), undoneByUserId: input.byUserId, undoReason: input.reason }, select: SELECT_PAGO,
      });
      const vivos = await tx.platformPayment.findMany({ where: { invoiceId, undoneAt: null }, select: SELECT_PAGO, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const ultimo = vivos.at(-1) ?? null;
      const factura = await tx.platformInvoice.update({
        where: { id: invoiceId },
        data: {
          paidCents: vivos.reduce((a, x) => a + x.amountCents, 0n), status: 'PENDING',
          paidAt: ultimo ? new Date(`${ultimo.paidOn.toISOString().slice(0, 10)}T12:00:00.000Z`) : null,
          paymentMethod: ultimo?.paymentMethod ?? null, paymentRef: ultimo?.paymentRef ?? null,
        },
        select: SELECT,
      }) as unknown as Factura;
      return { ok: true as const, pago, factura };
    });
  }

  /** Anula una factura que todavía debe TODO: con pagos registrados, primero se deshacen. */
  async void(id: string, reason: string): Promise<boolean> {
    const { count } = await this.db.platformInvoice.updateMany({ where: { id, status: 'PENDING', paidCents: 0n }, data: { status: 'VOID', voidReason: reason } });
    return count > 0;
  }

  /**
   * SUSPENSIÓN AUTOMÁTICA POR ADEUDO (D-37). Con la marca bajo candado y la
   * factura vuelta a leer: si entre la decisión y este instante se registró el
   * pago, se reanudó, se dio una prórroga o alguien ya la suspendió, no pasa
   * nada. Solo cambia el estado del servicio: no toca facturas, pagos ni datos
   * del gimnasio.
   */
  async suspenderPorAdeudo(organizationId: string, invoiceId: string, hoy: string, reason: string, ahora: Date): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const marcas = await tx.$queryRaw<Array<{ serviceStatus: string; hold: Date | null }>>`
        SELECT "serviceStatus", "autoSuspendHoldUntil" AS hold FROM organizations WHERE id = ${organizationId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
      const marca = marcas[0];
      if (!marca || marca.serviceStatus !== 'ACTIVE') return false;
      if (marca.hold && marca.hold.toISOString().slice(0, 10) >= hoy) return false;
      const facturas = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "platform_invoices"
         WHERE id = ${invoiceId}::uuid AND "organizationId" = ${organizationId}::uuid AND status = 'PENDING' AND "paidCents" < "totalCents" AND "dueDate" < ${hoy}::date
           FOR UPDATE`;
      if (facturas.length === 0) return false;
      await tx.organization.update({
        where: { id: organizationId },
        data: { serviceStatus: 'SUSPENDED', suspendedAt: ahora, suspendedReason: reason, suspendedAutomatically: true },
      });
      return true;
    });
  }

  /** La prórroga de la suspensión automática: hasta ese día, incluido; null la quita. */
  async setHold(organizationId: string, until: string | null): Promise<boolean> {
    const { count } = await this.db.organization.updateMany({ where: { id: organizationId, deletedAt: null }, data: { autoSuspendHoldUntil: until ? dia(until) : null } });
    return count > 0;
  }

  async setBillingEmail(organizationId: string, email: string | null): Promise<void> {
    await this.db.organization.updateMany({ where: { id: organizationId }, data: { billingEmail: email } });
  }
}
