import { AUDIT_SUMMARIZED, AUDIT_SUMMARIZED_WITHOUT_FACE, type WeeklyFigures } from '@gymflow/core';
import { AuditService } from '../../platform/audit/audit.service.js';
import { systemContext } from '../../platform/jobs/types.js';
import { plazosDe } from '../../platform/plazos/plazos-del-socio.repository.js';
import { BajaRepository } from '../memberships/index.js';
import { AnalyticsService } from './analytics.service.js';
import { PulseRepository } from './pulse.repository.js';
import { medianoche } from './pulse.service.js';
import { WeeklyRepository, type PersonaDeLaSemana } from './weekly.repository.js';

const DIA = 86_400_000;
const total = (filas: ReadonlyArray<{ total: number }>) => filas.reduce((a, f) => a + f.total, 0);
const centavos = (filas: ReadonlyArray<{ cents: bigint }>) => filas.reduce((a, f) => a + BigInt(f.cents), 0n);
const fecha = (texto: string) => new Date(`${texto}T00:00:00.000Z`);

export type SemanaEnCifras = { figures: WeeklyFigures; people: PersonaDeLaSemana[] };

/**
 * LA SEMANA EN CIFRAS, para el resumen del lunes de la dueña (bloque 4.2; D-05).
 *
 * `from` y `to` son fechas de calendario del gimnasio (`to` es el lunes
 * siguiente, fin semiabierto). Cada cifra usa LA MISMA definición que su
 * pantalla: lo que entró es el del Inicio de la dueña, las bajas son las de
 * D-18, la cartera es la del Tablero, las entradas por excepción son las de la
 * Bitácora. «Por cobrar» y «espera tu firma» son de HOY, no de la semana.
 */
export class WeeklyService {
  async semana(organizationId: string, semana: { from: string; to: string }, zona: string, ahora: Date = new Date()): Promise<SemanaEnCifras> {
    const pulso = new PulseRepository(organizationId);
    const repo = new WeeklyRepository(organizationId);
    const audit = new AuditService();
    const desdeDia = fecha(semana.from); const hastaDia = fecha(semana.to);
    // Los instantes de la semana, en la zona del gimnasio (mediodía UTC cae siempre dentro de ese día local en México).
    const desde = medianoche(zona, new Date(desdeDia.getTime() + 12 * 3_600_000));
    const hasta = medianoche(zona, new Date(hastaDia.getTime() + 12 * 3_600_000));
    const antes = new Date(desde.getTime() - 7 * DIA);

    const [
      entradas, entradasAntes, altas, bajas, entro, entroAntes, devoluciones, tablero,
      cortes, firmas, esperan, asientos, fechadas, perdida, compartidos, excepciones, cadena, personas,
    ] = await Promise.all([
      repo.entradas(desdeDia, hastaDia),
      repo.entradas(new Date(desdeDia.getTime() - 7 * DIA), desdeDia),
      pulso.altas(desdeDia, hastaDia),
      plazosDe(organizationId).then((p) => new BajaRepository(organizationId).bajasEntre(desdeDia, hastaDia, p.churnDays)),
      pulso.entroEntre(desde, hasta),
      pulso.entroEntre(antes, desde),
      pulso.devoluciones(desde, hasta),
      new AnalyticsService().dashboard(systemContext(organizationId), { from: desdeDia, to: hastaDia }, null),
      repo.cortes(desdeDia, hastaDia),
      repo.firmas(desde, hasta),
      repo.esperanFirma(ahora),
      repo.asientos([...WeeklyRepository.DESCUENTOS, ...AUDIT_SUMMARIZED, ...AUDIT_SUMMARIZED_WITHOUT_FACE], desde, hasta),
      repo.ventasConFechaAnterior(desde, hasta),
      repo.deudaPerdida(desde, hasta),
      repo.celularesCompartidos(desde, hasta),
      audit.exceptionSummary(organizationId, { from: desde, to: hasta }),
      // «La bitácora está íntegra» (D-05 c): se verifica al armar el resumen. Si no se puede verificar, se dice «sin dato».
      audit.verifyChain(organizationId).catch(() => null),
      repo.porPersona(desde, hasta),
    ]);
    const cuenta = (acciones: readonly string[]) => acciones.reduce((a, x) => a + (asientos.get(x) ?? 0), 0);

    return {
      figures: {
        entries: { total: entradas, previous: entradasAntes },
        members: { joined: total(altas), left: total(bajas) },
        money: {
          collectedCents: centavos(entro).toString(), previousCollectedCents: centavos(entroAntes).toString(),
          outstandingCents: tablero.outstandingCents.toString(), overdueCents: tablero.overdueCents.toString(),
          refunds: { count: total(devoluciones), cents: centavos(devoluciones).toString() },
          discounts: cuenta(WeeklyRepository.DESCUENTOS), backdatedSales: fechadas, lostDebtCents: perdida.toString(),
        },
        cash: { variances: cortes.variances, shortCents: cortes.shortCents.toString(), overCents: cortes.overCents.toString(), pendingReview: cortes.pendingReview },
        signatures: firmas,
        awaiting: esperan,
        exceptions: {
          manualEntries: cuenta(AUDIT_SUMMARIZED),
          overLimit: excepciones.filter((f) => f.limit !== null && f.count > f.limit).length,
          withoutFace: cuenta(AUDIT_SUMMARIZED_WITHOUT_FACE),
          sharedPhoneChanges: compartidos,
        },
        audit: { intact: cadena ? cadena.ok : null, checked: cadena?.checked ?? 0 },
      },
      people: personas,
    };
  }
}
