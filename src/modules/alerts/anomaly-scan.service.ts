import {
  OWNER_ALERT_LOOKBACK_DAYS, PRIVACY_REQUEST_ALERT_DAYS, diaYMes, formatMoney, hoyEn, isoDate, money, diasEntre, textoDeAviso,
  type OwnerAlertFacts, type OwnerAlertKind,
} from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import { CashAlertsService } from '../cash/index.js';
import type { NuevoAviso } from './owner-alert.repository.js';
import { OwnerAlertRepository } from './owner-alert.repository.js';
import { OwnerAlertsService } from './owner-alerts.service.js';
import { ScanSourcesRepository } from './scan-sources.repository.js';

const DIA = 86_400_000;
const pesos = (c: bigint | string) => formatMoney(money(BigInt(c)));
type Renglon = { label: string; value: string };
const renglones = (pares: Array<[string, string | null | undefined]>): Renglon[] => pares.filter((p): p is [string, string] => !!p[1]).map(([label, value]) => ({ label, value }));
const campo = (estado: unknown, llave: string): unknown => (estado && typeof estado === 'object' && !Array.isArray(estado) ? (estado as Record<string, unknown>)[llave] : undefined);
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const numero = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const centavos = (v: unknown): string | null => (typeof v === 'string' && /^-?\d+$/.test(v) ? v : null);

const NOMBRE_DE_SOLICITUD: Record<string, string> = {
  ACCESS: 'Acceso a sus datos', RECTIFICATION: 'Corrección de sus datos', CANCELLATION: 'Cancelación de sus datos', OPPOSITION: 'Oposición a un uso', REVOCATION: 'Revocación de un permiso',
};

/** Los asientos de la bitácora que se vuelven aviso, uno por uno. */
const ASIENTOS_QUE_AVISAN = ['approval.remote.over_limit', 'catalog.plan.price_change', 'billing.debt.lost.summary'] as const;

export type PasadaDeAvisos = {
  /** Esta fue la primera corrida del gimnasio: nada sonó; lo pendiente quedó anotado en el panel. */
  primera: boolean;
  /** Avisos nuevos (creados por esta corrida). */
  nuevos: number;
  /** De los nuevos, cuántos salieron a por lo menos un teléfono. */
  alTelefono: number;
  /** Lo que se encontró y ya estaba avisado. */
  yaAvisados: number;
  errores: Array<{ entityId: string; error: string }>;
};

type Candidato = Omit<NuevoAviso, 'silent' | 'title' | 'body' | 'url'> & { hechos: OwnerAlertFacts };

/**
 * `audit.anomaly-scan` · LO QUE LA DUEÑA DEBE SABER SIN ABRIR EL PANEL (bloque
 * 4.2; D-05). Corre cada 15 minutos por gimnasio y se puede repetir las veces
 * que haga falta: cada hallazgo tiene una llave y un aviso con esa llave solo
 * se crea (y solo suena) una vez.
 *
 * LA PRIMERA CORRIDA EN UN GIMNASIO NO SUENA. Fija «desde aquí aviso» y anota
 * en el panel, sin mandar nada al teléfono, lo que en ese momento ya estaba
 * pendiente (cajas sin cortar, solicitudes por vencer, el aviso de privacidad
 * por firmar). Lo que pasó antes de ese instante (cortes, cambios de precio,
 * insistencias) no se avisa nunca: ya está en la Bitácora.
 *
 * «Hoy» es el día de operación de cada sede; nada depende de la fecha del
 * servidor. Si la computadora estuvo apagada, lo de más de 7 días ya no suena.
 */
export class AnomalyScanService {
  constructor(private readonly avisos: OwnerAlertsService = new OwnerAlertsService()) {}

  async pasada(organizationId: string, ahora: Date = new Date()): Promise<PasadaDeAvisos> {
    const repo = new OwnerAlertRepository(organizationId);
    const { startedAt, nuevo: primera } = await repo.fijarArranque(ahora);
    const desde = new Date(Math.max(startedAt.getTime(), ahora.getTime() - OWNER_ALERT_LOOKBACK_DAYS * DIA));
    const r: PasadaDeAvisos = { primera, nuevos: 0, alTelefono: 0, yaAvisados: 0, errores: [] };

    const candidatos = await this.candidatos(organizationId, desde, ahora, primera, r.errores);

    const ya = await repo.yaAvisadas(candidatos.map((c) => c.dedupeKey));
    for (const { hechos, ...c } of candidatos) {
      if (ya.has(c.dedupeKey)) { r.yaAvisados += 1; continue; }
      try {
        const dado = await this.avisos.dar(organizationId, { ...c, ...textoDeAviso(hechos), silent: primera }, ahora);
        if (!dado.creado) { r.yaAvisados += 1; continue; }
        r.nuevos += 1;
        if (dado.equipos > 0) r.alTelefono += 1;
      } catch (e) {
        r.errores.push({ entityId: c.dedupeKey, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return r;
  }

  /** Todo lo que hoy merece aviso, sin escribir nada. En la primera corrida la bitácora no se mira: `desde` es este instante. */
  private async candidatos(organizationId: string, desde: Date, ahora: Date, primera: boolean, errores: PasadaDeAvisos['errores']): Promise<Candidato[]> {
    const candidatos: Candidato[] = [];
    const juntar = async (que: string, arma: () => Promise<Candidato[]>) => {
      // Una fuente que falla no calla a las demás: se anota y la corrida sigue.
      try { candidatos.push(...await arma()); } catch (e) { errores.push({ entityId: que, error: e instanceof Error ? e.message : String(e) }); }
    };
    const fuentes = new ScanSourcesRepository(organizationId);
    const sedes = await fuentes.sedes();

    await juntar('cajas-sin-cortar', () => this.cajasSinCortar(organizationId, ahora));
    await juntar('cortes-con-diferencia', () => this.cortes(fuentes, desde));
    await juntar('tope-de-pases', () => this.topeDePases(organizationId, sedes, desde, ahora));
    await juntar('privacidad-por-vencer', () => this.privacidad(organizationId, fuentes, ahora));
    await juntar('aviso-por-firmar', () => this.avisoPorFirmar(fuentes));
    if (!primera) await juntar('bitacora', () => this.deLaBitacora(fuentes, sedes, desde));
    return candidatos;
  }

  /**
   * QUÉ HARÍA LA PRÓXIMA CORRIDA, SIN ESCRIBIR NADA: si sería la primera del
   * gimnasio (la que no suena) y cuántos avisos nuevos daría de cada tipo.
   * Para mirarlo en una base en uso antes de dejar correr el job.
   */
  async vistaPrevia(organizationId: string, ahora: Date = new Date()): Promise<{ startedAt: Date | null; primera: boolean; porTipo: Record<string, number>; errores: PasadaDeAvisos['errores'] }> {
    const repo = new OwnerAlertRepository(organizationId);
    const startedAt = await repo.arranque();
    const primera = startedAt === null;
    const desde = new Date(Math.max((startedAt ?? ahora).getTime(), ahora.getTime() - OWNER_ALERT_LOOKBACK_DAYS * DIA));
    const errores: PasadaDeAvisos['errores'] = [];
    const candidatos = await this.candidatos(organizationId, desde, ahora, primera, errores);
    const ya = await repo.yaAvisadas(candidatos.map((c) => c.dedupeKey));
    const porTipo: Record<string, number> = {};
    for (const c of new Map(candidatos.filter((x) => !ya.has(x.dedupeKey)).map((x) => [x.dedupeKey, x])).values()) porTipo[c.kind] = (porTipo[c.kind] ?? 0) + 1;
    return { startedAt, primera, porTipo, errores };
  }

  /** Cajas que amanecieron abiertas (D-05; la definición es la de Caja, D-17). Una vez por turno olvidado. */
  private async cajasSinCortar(organizationId: string, ahora: Date): Promise<Candidato[]> {
    const cajas = await new CashAlertsService().unclosed(organizationId, null);
    const nombres = await new ScanSourcesRepository(organizationId).personas(cajas.map((c) => c.openedByUserId));
    return cajas.map((c) => ({
      kind: 'CASH_UNCLOSED' as OwnerAlertKind, dedupeKey: `cash-unclosed:${c.id}`, branchId: c.branchId, occurredAt: ahora,
      hechos: { kind: 'CASH_UNCLOSED', registerName: c.registerName, branchName: c.branchName, businessDate: isoDate(c.businessDate) },
      detail: { lines: renglones([['Caja', c.registerName], ['Sucursal', c.branchName], ['La abrió', nombres.get(c.openedByUserId)], ['Abierta desde el', diaYMes(isoDate(c.businessDate))]]) },
    }));
  }

  /** Cortes que cerraron con más de la tolerancia de diferencia y nadie ha revisado (D-05, D-17). */
  private async cortes(fuentes: ScanSourcesRepository, desde: Date): Promise<Candidato[]> {
    return (await fuentes.cortesPorRevisar(desde)).map((c) => ({
      kind: 'CASH_VARIANCE' as OwnerAlertKind, dedupeKey: `cash-variance:${c.id}`, branchId: c.branchId, occurredAt: c.closedAt,
      hechos: { kind: 'CASH_VARIANCE', registerName: c.registerName, branchName: c.branchName, varianceCents: c.varianceCents.toString() },
      detail: {
        lines: renglones([
          ['Caja', c.registerName], ['Sucursal', c.branchName],
          [c.varianceCents < 0n ? 'Faltó' : 'Sobró', pesos(c.varianceCents < 0n ? -c.varianceCents : c.varianceCents)],
          ['Abrió el turno (responsable)', c.openedByName], ['Hizo el corte', c.closedByName], ['Explicación', c.varianceReason],
        ]),
      },
    }));
  }

  /**
   * Alguien pasó su tope de «dejar pasar» (D-05): la misma cuenta que la
   * Bitácora (por persona, día de operación y sede). Una vez por persona, día
   * y sede: si sigue dejando pasar, no vuelve a sonar ese día.
   */
  private async topeDePases(organizationId: string, sedes: Map<string, string>, desde: Date, ahora: Date): Promise<Candidato[]> {
    // Solo los días de operación de hoy y de ayer de cada sede: lo más viejo ya no es «al momento».
    const filas = (await new AuditService().exceptionSummary(organizationId, { from: new Date(Math.max(desde.getTime(), ahora.getTime() - 2 * DIA)) }))
      .filter((f) => f.limit !== null && f.count > f.limit && f.actorUserId);
    return filas.map((f) => ({
      kind: 'ENTRY_EXCEPTIONS_OVER_LIMIT' as OwnerAlertKind, dedupeKey: `exceptions:${isoDate(f.businessDate)}:${f.actorUserId}:${f.branchId ?? 'sin-sede'}`,
      branchId: f.branchId, occurredAt: ahora,
      hechos: { kind: 'ENTRY_EXCEPTIONS_OVER_LIMIT', branchName: f.branchId ? sedes.get(f.branchId) ?? null : null, count: f.count, limit: f.limit! },
      detail: {
        lines: renglones([
          ['Quién', f.actorName], ['Sucursal', f.branchId ? sedes.get(f.branchId) : null], ['Día', diaYMes(isoDate(f.businessDate))],
          ['Dejó pasar por excepción', `${f.count} veces`], ['Tope de su puesto', String(f.limit)],
        ]),
      },
    }));
  }

  /** Solicitudes de privacidad a 5 días o menos de su plazo de ley (D-05). Una vez por solicitud y etapa. */
  private async privacidad(organizationId: string, fuentes: ScanSourcesRepository, ahora: Date): Promise<Candidato[]> {
    const zona = await new BusinessCalendar(organizationId).timezoneFor(null);
    const hoy = hoyEn(zona, ahora);
    const filas = await fuentes.solicitudesPorVencer(new Date(ahora.getTime() + (PRIVACY_REQUEST_ALERT_DAYS + 1) * DIA));
    return filas
      .map((s) => ({ s, quedan: diasEntre(hoy, hoyEn(zona, s.vence)) }))
      .filter(({ quedan }) => quedan <= PRIVACY_REQUEST_ALERT_DAYS)
      .map(({ s, quedan }) => ({
        kind: 'PRIVACY_REQUEST_DUE' as OwnerAlertKind, dedupeKey: `privacy-due:${s.id}:${s.etapa}`, occurredAt: ahora,
        hechos: { kind: 'PRIVACY_REQUEST_DUE', daysLeft: quedan },
        detail: {
          lines: renglones([
            ['Qué pidió', NOMBRE_DE_SOLICITUD[s.kind] ?? 'Una solicitud sobre sus datos'],
            ['Falta', s.etapa === 'answer' ? 'Contestarle' : 'Hacer efectivo lo que procedió'],
            ['Vence el', diaYMes(hoyEn(zona, s.vence))],
          ]),
        },
      }));
  }

  /** El aviso de privacidad que espera la firma de la dueña (D-25): hasta hoy solo se enteraba al abrir el panel. */
  private async avisoPorFirmar(fuentes: ScanSourcesRepository): Promise<Candidato[]> {
    return (await fuentes.firmasDelAvisoPendientes()).map((q) => ({
      kind: 'NOTICE_SIGNATURE_PENDING' as OwnerAlertKind, dedupeKey: `notice-signature:${q.id}`, occurredAt: q.requestedAt,
      hechos: { kind: 'NOTICE_SIGNATURE_PENDING', version: q.version },
      detail: { lines: renglones([['Versión', q.version], ['La pidió', q.requestedByName], ['Motivo', q.reason]]) },
    }));
  }

  /** Lo que la bitácora asentó y la dueña debe saber: la cuarta insistencia, un cambio de precio y la deuda dada por perdida. */
  private async deLaBitacora(fuentes: ScanSourcesRepository, sedes: Map<string, string>, desde: Date): Promise<Candidato[]> {
    const asientos = await fuentes.asientos(ASIENTOS_QUE_AVISAN, desde);
    const planes = await fuentes.planes(asientos.filter((a) => a.action === 'catalog.plan.price_change' && a.resourceId).map((a) => a.resourceId!));
    const salida: Candidato[] = [];
    for (const a of asientos) {
      const sede = a.branchId ? sedes.get(a.branchId) ?? null : null;
      const dia = isoDate(a.businessDate);
      if (a.action === 'approval.remote.over_limit') {
        // Una vez por persona y día: quien insiste cinco veces no hace sonar el teléfono cinco veces.
        const importe = centavos(campo(a.afterState, 'amountCents'));
        salida.push({
          kind: 'SIGNATURE_INSISTENCE', dedupeKey: `insistence:${dia}:${a.actorUserId ?? 'sistema'}`, branchId: a.branchId, occurredAt: a.at,
          hechos: { kind: 'SIGNATURE_INSISTENCE', branchName: sede },
          detail: { lines: renglones([['Quién', a.actorName], ['Sucursal', sede], ['Importe', importe ? pesos(importe) : null], ['Intento', numero(campo(a.afterState, 'attempt'))?.toString()]]) },
        });
      } else if (a.action === 'catalog.plan.price_change') {
        const plan = a.resourceId ? planes.get(a.resourceId) ?? null : null;
        const de = centavos(campo(a.beforeState, 'priceCents')); const al = centavos(campo(a.afterState, 'priceCents'));
        const tocadas = numero(campo(a.afterState, 'touched'));
        salida.push({
          kind: 'PLAN_PRICE_CHANGE', dedupeKey: `price-change:${a.id}`, branchId: a.branchId, occurredAt: a.at,
          hechos: { kind: 'PLAN_PRICE_CHANGE', planName: plan },
          detail: {
            lines: renglones([
              ['Plan', plan], ['Antes', de ? pesos(de) : null], ['Ahora', al ? pesos(al) : null], ['Lo cambió', a.actorName], ['Motivo', texto(a.reason)],
              ['Membresías que cambian de precio', tocadas !== null ? String(tocadas) : null],
            ]),
          },
        });
      } else if (a.action === 'billing.debt.lost.summary') {
        const importe = centavos(campo(a.afterState, 'amountCents')) ?? '0';
        const socios = numero(campo(a.afterState, 'members')) ?? 0;
        const plazo = numero(campo(a.afterState, 'lostDebtDays'));
        salida.push({
          kind: 'DEBT_LOST', dedupeKey: `debt-lost:${a.id}`, occurredAt: a.at,
          hechos: { kind: 'DEBT_LOST', amountCents: importe, members: socios },
          detail: {
            lines: renglones([
              ['Salió de «Por cobrar»', pesos(importe)], ['Socios', String(socios)], ['Cargos', numero(campo(a.afterState, 'charges'))?.toString()],
              ['Plazo', plazo !== null ? `${plazo} días suspendida` : null],
              ['Primera corrida', campo(a.afterState, 'firstRun') === true ? 'Sí: incluye toda la deuda vieja que ya cumplía el plazo' : null],
            ]),
          },
        });
      }
    }
    return salida;
  }
}
