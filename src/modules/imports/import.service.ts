import {
  conflict, corregirDato, notFound, validation, type CampoDudoso,
} from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import type { RequestContext } from '../../platform/context.js';
import { BranchRepository } from '../organization/index.js';
import { PlanRepository, type PlanRecord } from '../catalog/index.js';
import { MemberRepository } from '../members/index.js';
import {
  MemberImportRepository, SIN_PLAN,
  type ImportDecision, type ImportKind, type ImportRecord, type ImportRowRecord,
} from './import.repository.js';
import { dia, prepararFilas, type FilaEntrante } from './import-stage.js';
import { aplicarFila, precioPactado, saldoYaCargado as saldoInicialYaCargado } from './import-apply.js';

/** Hasta cuántas filas por archivo. Un gimnasio grande tiene unos miles; más es otra cosa. */
export const MAX_FILAS = 20_000;
/** Filas por lote al aplicar: cada una es una transacción y el lote cabe en una petición. */
const LOTE_APLICAR = 200;

export type { FilaEntrante } from './import-stage.js';

/** Lo que una persona escribe al corregir un dato dudoso (D18-02): centavos o aaaa-mm-dd; null = sin ese dato. */
export type CorreccionDatos = Partial<Record<CampoDudoso, string | null>>;

/** Etiqueta de un plan del archivo para una persona: las vigencias sin plan también se nombran. */
export const nombreDePlanDelArchivo = (label: string) => (label === SIN_PLAN ? 'Sin plan en el archivo' : label);

/**
 * IMPORTACIÓN DE SOCIOS (docs/09 §3–5).
 *
 * 1. `stage`: limpia cada fila, la compara contra el padrón y contra las
 *    filas anteriores del MISMO archivo, y propone qué hacer. No toca socios.
 * 2. Una persona del gimnasio revisa lo dudoso (`decide`): solo ella
 *    reconoce las caras. Fusionar a dos personas distintas es un incidente de
 *    privacidad; no fusionar a la misma le cobra dos veces. También decide
 *    los datos que no se entendieron (`decideData`) y qué plan de GymFlow
 *    corresponde a cada plan del archivo.
 * 3. `apply`, por lotes y reanudable: crea o completa fichas, guarda los
 *    códigos anteriores, el saldo inicial y la vigencia. Cada fila es una
 *    transacción, una fila aplicada no se vuelve a aplicar y un socio recibe
 *    a lo más un saldo inicial por registro del sistema anterior.
 *
 * Este servicio orquesta y escribe la bitácora; la limpieza y el
 * emparejamiento viven en `import-stage.ts` y aplicar cada fila en
 * `import-apply.ts` (auditoría 8, bloque 1.7).
 */
export class ImportService {
  private readonly audit = new AuditService();

  async stage(ctx: RequestContext, input: {
    fileName: string; branchId: string; cutoffDate: string; rows: FilaEntrante[]; reason: string;
  }): Promise<string> {
    const orgId = ctx.tenant.organizationId;
    if (input.rows.length === 0) throw validation('El archivo no trae filas');
    if (input.rows.length > MAX_FILAS) throw validation(`Hasta ${MAX_FILAS.toLocaleString('es-MX')} filas por archivo: divídelo`);
    const sedes = await new BranchRepository(orgId).list();
    const sedeDeCasa = sedes.find((b) => b.id === input.branchId);
    if (!sedeDeCasa) throw validation('La sucursal no existe en este gimnasio');
    const hoy = (await new BusinessCalendar(orgId).today(input.branchId)).toISOString().slice(0, 10);
    if (input.cutoffDate > hoy) throw validation('La fecha de corte no puede estar en el futuro');

    const { filas, branchMap } = await prepararFilas(orgId, input.rows, sedes, hoy, sedeDeCasa);

    return enUnaTransaccion(async () => {
      const repo = new MemberImportRepository(orgId);
      const importId = await repo.create({
        fileName: input.fileName, branchId: input.branchId, cutoffDate: dia(input.cutoffDate)!,
        totalRows: filas.length, createdByUserId: ctx.tenant.actorUserId!, branchMap,
      });
      await repo.insertRows(importId, filas);
      await this.audit.record(ctx, {
        action: 'members.import.stage', resourceType: 'MemberImport', resourceId: importId, branchId: input.branchId,
        afterState: { fileName: input.fileName, rows: filas.length, doubtful: filas.filter((f) => f.dataStatus === 'PENDING').length }, reason: input.reason,
      });
      return importId;
    });
  }

  /**
   * Decisión de una persona sobre una fila. MERGE con un socio exige que ese
   * socio exista; MERGE de una repetida del archivo se une a su fila principal.
   */
  async decide(ctx: RequestContext, importId: string, rowId: string, decision: Exclude<ImportDecision, 'PENDING'>, memberId?: string | null): Promise<ImportRowRecord> {
    const orgId = ctx.tenant.organizationId;
    const repo = new MemberImportRepository(orgId);
    const { row } = await this.filaEditable(repo, importId, rowId);
    if (row.kind === 'INVALID' && decision !== 'SKIP') throw validation('Una fila sin nombre no se puede importar: corrígela en el archivo');
    let destino = memberId === undefined ? undefined : memberId;
    if (decision === 'MERGE') {
      const objetivo = memberId ?? row.matchMemberId;
      if (objetivo) {
        const socio = await new MemberRepository(orgId).findByIdIncludingArchived(objetivo);
        if (!socio || socio.anonymizedAt) throw validation('Ese socio no existe');
        destino = objetivo;
      } else if (!row.matchRowId) throw validation('Para unir, elige con qué socio');
    }
    await repo.decide(importId, rowId, decision, ctx.tenant.actorUserId!, destino);
    return (await repo.row(importId, rowId))!;
  }

  /**
   * Los datos dudosos de una fila (D18-02): entra SIN ese dato o con el valor
   * que escribe la persona. Solo se corrige lo que no se entendió; lo demás
   * del archivo no se edita aquí. Cada nueva decisión reemplaza a la anterior:
   * volver a «sin ese dato» borra la corrección.
   */
  async decideData(ctx: RequestContext, importId: string, rowId: string, data: 'WITHOUT' | 'FIXED', fix?: CorreccionDatos): Promise<ImportRowRecord> {
    const orgId = ctx.tenant.organizationId;
    const repo = new MemberImportRepository(orgId);
    const { imp, row } = await this.filaEditable(repo, importId, rowId);
    if (row.kind === 'INVALID') throw validation('Una fila sin nombre no se puede importar: corrígela en el archivo');
    if (!row.dataStatus) throw validation('Esta fila no trae datos dudosos');
    const dudosos = new Set(row.doubtful.map((d) => d.field));
    const pedidos = Object.keys(fix ?? {}) as CampoDudoso[];
    if (data === 'WITHOUT' && pedidos.length > 0) throw validation('«Sin ese dato» no lleva valores: para escribirlos, corrige');
    if (data === 'FIXED' && pedidos.length === 0) throw validation('Escribe el valor correcto, o elige que entre sin ese dato');
    if (pedidos.some((c) => !dudosos.has(c))) throw validation('Solo se corrigen los datos que no se entendieron');

    const hoy = (await new BusinessCalendar(orgId).today(imp.branchId)).toISOString().slice(0, 10);
    const valores: { balanceCents?: bigint | null; periodEnd?: Date | null; joinedAt?: Date | null } = {};
    for (const campo of dudosos) {
      const r = corregirDato(campo, data === 'FIXED' ? fix?.[campo] ?? null : null, hoy);
      if (!r.ok) throw validation(r.error);
      if (campo === 'balance') valores.balanceCents = r.value as bigint | null;
      else valores[campo] = dia(r.value as string | null);
    }
    if (!(await repo.decideData(importId, rowId, data, ctx.tenant.actorUserId!, valores))) throw conflict('Esa fila ya se aplicó');
    return (await repo.row(importId, rowId))!;
  }

  /** "Aceptar todas" las de un tipo: p. ej. dejar como nuevas todas las que no tienen parecido. */
  async decideAll(ctx: RequestContext, importId: string, kind: ImportKind, decision: Exclude<ImportDecision, 'PENDING'>): Promise<number> {
    const repo = new MemberImportRepository(ctx.tenant.organizationId);
    const imp = await repo.find(importId);
    if (!imp) throw notFound('Esta importación no existe');
    if (imp.status !== 'REVIEW') throw conflict('Esta importación ya se aplicó o se canceló');
    if (kind === 'INVALID' && decision !== 'SKIP') throw validation('Las filas sin nombre no se pueden importar');
    // Lo dudoso se decide UNO POR UNO: "unir todas" de golpe es justo el error que esta pantalla evita.
    if (kind === 'REVIEW' && decision === 'MERGE') throw validation('Las coincidencias dudosas se unen una por una');
    return repo.decideAll(importId, kind, ['PENDING', 'CREATE', 'MERGE', 'SKIP'], decision, ctx.tenant.actorUserId!);
  }

  async setMaps(ctx: RequestContext, importId: string, maps: { planMap?: Record<string, string | null>; branchMap?: Record<string, string | null> }): Promise<void> {
    const orgId = ctx.tenant.organizationId;
    const repo = new MemberImportRepository(orgId);
    const imp = await repo.find(importId);
    if (!imp) throw notFound('Esta importación no existe');
    if (imp.status !== 'REVIEW') throw conflict('Esta importación ya se aplicó o se canceló');
    if (maps.planMap) {
      const planes = new PlanRepository(orgId);
      for (const id of Object.values(maps.planMap)) {
        if (!id) continue;
        const p = await planes.findById(id);
        if (!p) throw validation('Uno de los planes elegidos no existe');
        if (p.billingModel !== 'RECURRING' && p.billingModel !== 'PREPAID_PERIOD') throw validation(`${p.name} no es un plan por periodo: las vigencias solo se cargan en mensualidades y prepagos`);
      }
    }
    if (maps.branchMap) {
      const sedes = new Set((await new BranchRepository(orgId).list()).map((b) => b.id));
      if (Object.values(maps.branchMap).some((id) => id && !sedes.has(id))) throw validation('Una de las sucursales elegidas no existe');
    }
    await repo.setMaps(importId, maps);
  }

  /**
   * Lo que todavía impide aplicar, con palabras de la gerencia. Vacío = se
   * puede. Cada plan del archivo que trae vigencias exige una decisión
   * explícita (18-03): «cargar como <plan>» o «no cargar su vigencia»; un
   * valor por omisión que deja sin membresía a socios pagados es el error
   * más caro del cambio de sistema.
   */
  async pendientes(orgId: string, imp: ImportRecord): Promise<string[]> {
    const repo = new MemberImportRepository(orgId);
    const c = await repo.counts(imp.id);
    const faltan: string[] = [];
    const pendientes = c.byDecision.PENDING ?? 0;
    if (pendientes > 0) faltan.push(pendientes === 1 ? 'Falta 1 coincidencia por revisar' : `Faltan ${pendientes} coincidencias por revisar`);
    if (c.dataPending > 0) faltan.push(c.dataPending === 1 ? 'Falta 1 fila con datos dudosos por decidir' : `Faltan ${c.dataPending} filas con datos dudosos por decidir`);
    const sinPlan = (await repo.labels(imp.id)).plans.filter((p) => p.vigentes > 0 && !Object.prototype.hasOwnProperty.call(imp.planMap, p.label));
    if (sinPlan.length > 0) faltan.push(`Falta decidir qué plan de GymFlow corresponde a: ${sinPlan.map((p) => `${nombreDePlanDelArchivo(p.label)} (${p.vigentes} con vigencia)`).join(', ')}`);
    return faltan;
  }

  /**
   * Aplica el siguiente lote. Se llama hasta que `remaining` sea 0; si se
   * corta a la mitad, se reanuda donde quedó (cada fila aplicada queda marcada).
   */
  async applyBatch(ctx: RequestContext, importId: string, reason: string): Promise<{ applied: number; remaining: number; done: boolean }> {
    const orgId = ctx.tenant.organizationId;
    const repo = new MemberImportRepository(orgId);
    const imp = await repo.find(importId);
    if (!imp) throw notFound('Esta importación no existe');
    if (imp.status !== 'REVIEW') throw conflict('Esta importación ya se aplicó o se canceló');
    const faltan = await this.pendientes(orgId, imp);
    if (faltan.length > 0) throw conflict(`${faltan.join('. ')} antes de aplicar`);

    const planes = new PlanRepository(orgId);
    const planCache = new Map<string, PlanRecord | null>();
    const precioCache = new Map<string, bigint>();
    const hoy = await new BusinessCalendar(orgId).today(imp.branchId);
    const lote = await repo.nextToApply(importId, LOTE_APLICAR);
    const sedeDeCasa = (await new BranchRepository(orgId).findById(imp.branchId))?.name ?? '';
    let applied = 0;
    for (const row of lote) {
      // Las vigencias sin plan en el archivo van con lo que se decidió para «Sin plan en el archivo».
      const planId = imp.planMap[row.planLabel ?? SIN_PLAN] ?? null;
      if (planId && !planCache.has(planId)) planCache.set(planId, await planes.findById(planId));
      const plan = planId ? planCache.get(planId) ?? null : null;
      const branchId = (row.branchLabel ? imp.branchMap[row.branchLabel] : null) ?? imp.branchId;
      // Precio pactado de la vigencia (16-04): el de ese plan en esa sucursal hoy, como una venta.
      let precio: bigint | null = null;
      if (plan && row.periodEnd) {
        const k = `${plan.id}|${branchId}`;
        if (!precioCache.has(k)) precioCache.set(k, await precioPactado(planes, plan, branchId));
        precio = precioCache.get(k)!;
      }
      if (await enUnaTransaccion(() => aplicarFila(ctx, imp, hoy, row, branchId, plan, precio, sedeDeCasa))) applied++;
    }
    const remaining = (await repo.counts(importId)).pendingApply;
    if (remaining === 0) {
      await enUnaTransaccion(async () => {
        if (!(await repo.setStatus(importId, 'APPLIED', ctx.tenant.actorUserId!, reason))) return;
        const fin = await repo.counts(importId);
        await this.audit.record(ctx, {
          action: 'members.import.apply', resourceType: 'MemberImport', resourceId: importId, branchId: imp.branchId,
          afterState: {
            applied: fin.applied, created: fin.byDecision.CREATE ?? 0, merged: fin.byDecision.MERGE ?? 0, skipped: fin.byDecision.SKIP ?? 0,
            balancesLoaded: fin.balancesLoaded, balancesNotReloaded: fin.balancesNotReloaded,
            withoutData: fin.byData.WITHOUT ?? 0, fixedData: fin.byData.FIXED ?? 0,
          },
          reason,
        });
      });
    }
    return { applied, remaining, done: remaining === 0 };
  }

  /**
   * El dinero y las vigencias del archivo, para cotejar con el reporte de
   * cartera del sistema anterior ANTES de aplicar (18-04) y con lo que de
   * verdad se cargó después. Solo cuenta lo que entra (altas y uniones).
   */
  async dinero(orgId: string, imp: ImportRecord): Promise<{
    debtCents: bigint; debtRows: number; creditCents: bigint; creditRows: number;
    memberships: number; membershipsNotLoaded: number; expired: number; unreadBalances: number;
    loadedDebtCents: bigint; loadedCreditCents: bigint;
  }> {
    const repo = new MemberImportRepository(orgId);
    const hoy = await new BusinessCalendar(orgId).today(imp.branchId);
    const m = await repo.money(imp.id, hoy);
    // Una vigencia se carga si su plan del archivo tiene un plan de GymFlow elegido.
    const conPlan = m.vigentesPorPlan.filter((v) => !!imp.planMap[v.label]).reduce((a, v) => a + v.n, 0);
    const total = m.vigentesPorPlan.reduce((a, v) => a + v.n, 0);
    return {
      debtCents: m.debtCents, debtRows: m.debtRows, creditCents: m.creditCents, creditRows: m.creditRows,
      memberships: conPlan, membershipsNotLoaded: total - conPlan, expired: m.expired, unreadBalances: m.unreadBalances,
      loadedDebtCents: m.loadedDebtCents, loadedCreditCents: m.loadedCreditCents,
    };
  }

  /** ¿El socio ya tiene este saldo inicial? (D18-01). La regla vive en `import-apply.ts`. */
  async saldoYaCargado(orgId: string, importId: string, memberId: string, row: ImportRowRecord, momento: 'revision' | 'aplicada'): Promise<string | null> {
    return saldoInicialYaCargado(orgId, importId, memberId, row, momento);
  }

  async cancel(ctx: RequestContext, importId: string, reason: string): Promise<void> {
    const repo = new MemberImportRepository(ctx.tenant.organizationId);
    const imp = await repo.find(importId);
    if (!imp) throw notFound('Esta importación no existe');
    if (imp.status !== 'REVIEW') throw conflict('Esta importación ya se aplicó o se canceló');
    if ((await repo.counts(importId)).applied > 0) throw conflict('Ya se aplicó una parte: termina de aplicarla');
    await enUnaTransaccion(async () => {
      if (!(await repo.setStatus(importId, 'CANCELED', ctx.tenant.actorUserId!, reason))) throw conflict('Esta importación ya se aplicó o se canceló');
      await this.audit.record(ctx, { action: 'members.import.cancel', resourceType: 'MemberImport', resourceId: importId, branchId: imp.branchId, reason });
    });
  }

  /** La importación sigue en revisión y la fila existe y no se ha aplicado. */
  private async filaEditable(repo: MemberImportRepository, importId: string, rowId: string): Promise<{ imp: ImportRecord; row: ImportRowRecord }> {
    const imp = await repo.find(importId);
    if (!imp) throw notFound('Esta importación no existe');
    if (imp.status !== 'REVIEW') throw conflict('Esta importación ya se aplicó o se canceló');
    const row = await repo.row(importId, rowId);
    if (!row) throw notFound('Esa fila no existe');
    if (row.appliedAt) throw conflict('Esa fila ya se aplicó');
    return { imp, row };
  }
}
