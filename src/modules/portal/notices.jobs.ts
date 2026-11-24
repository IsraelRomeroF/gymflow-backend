import { formatMoney, money } from '@gymflow/core';
import type { JobHandler, JobResult } from '../../platform/jobs/types.js';
import { onlinePaymentsEnabled } from '../../platform/payments-mode.js';
import { GlobalRepository } from '../../platform/db/tenant-repository.js';
import { PortalNotificationsService, esperarEnvios } from './notificaciones.js';
import { sqlDeSede } from '../../platform/db/filtro-de-sede.js';
import { BusinessCalendar, type SedesDelDia } from '../../platform/time/business-calendar.js';

// `dueDate` es @db.Date (medianoche UTC): leída en hora de México caía un día antes.
const fecha = (d: Date) => d.toLocaleDateString('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'long' });
const LOTE = 500;

/**
 * Solo lee: lo que hoy merece un aviso. Las tablas son de otros módulos; aquí no se escribe en ellas.
 *
 * «Hoy» es el día de operación de la sede del cargo o de la clase (2.13), no el
 * `CURRENT_DATE` de la base (que va en UTC: desde las 18:00 de la Ciudad de
 * México ya era «mañana»). `sedes: null` son todas: el gimnasio entero en la misma fecha.
 */
class NoticeScanRepository extends GlobalRepository {
  dueSoon(organizationId: string, dias: number, hoy: Date, sedes: SedesDelDia | null) {
    return this.db.$queryRaw<Array<{ id: string; memberId: string; concept: string; amountCents: bigint; dueDate: Date }>>`
      SELECT c."id", c."memberId", c."concept", (c."amountCents" - c."allocatedCents" - c."adjustedCents") AS "amountCents", c."dueDate"
        FROM "charges" c JOIN "members" m ON m."id" = c."memberId" AND m."deletedAt" IS NULL
       WHERE c."organizationId" = ${organizationId}::uuid AND c."status" IN ('OPEN','PARTIALLY_PAID')
         AND c."dueDate" = (${hoy}::date + ${dias}::int) AND ${sqlDeSede('c."branchId"', sedes)} LIMIT ${LOTE}`;
  }
  overdue(organizationId: string, hoy: Date, sedes: SedesDelDia | null) {
    return this.db.$queryRaw<Array<{ id: string; memberId: string; concept: string; amountCents: bigint; dueDate: Date }>>`
      SELECT c."id", c."memberId", c."concept", (c."amountCents" - c."allocatedCents" - c."adjustedCents") AS "amountCents", c."dueDate"
        FROM "charges" c JOIN "members" m ON m."id" = c."memberId" AND m."deletedAt" IS NULL
       WHERE c."organizationId" = ${organizationId}::uuid AND c."status" = 'OVERDUE'
         AND c."dueDate" >= ${hoy}::date - 7 AND ${sqlDeSede('c."branchId"', sedes)} LIMIT ${LOTE}`;
  }
  classesTomorrow(organizationId: string, hoy: Date, sedes: SedesDelDia | null) {
    return this.db.$queryRaw<Array<{ id: string; memberId: string; name: string; startsAt: Date; branch: string; zona: string }>>`
      SELECT b."id", b."memberId", t."name", s."startsAt", br."name" AS branch, COALESCE(br."timezone", o."timezone") AS zona
        FROM "class_bookings" b JOIN "class_schedules" s ON s."id" = b."classScheduleId"
        JOIN "class_types" t ON t."id" = s."classTypeId" JOIN "branches" br ON br."id" = s."branchId"
        JOIN "organizations" o ON o."id" = b."organizationId"
       WHERE b."organizationId" = ${organizationId}::uuid AND b."status" = 'BOOKED' AND s."status" = 'SCHEDULED'
         AND s."businessDate" = ${hoy}::date + 1 AND ${sqlDeSede('s."branchId"', sedes)} LIMIT ${LOTE}`;
  }
  suspendedToday(organizationId: string) {
    return this.db.$queryRaw<Array<{ id: string; memberId: string }>>`
      SELECT ms."id", ms."memberId" FROM "memberships" ms JOIN "members" m ON m."id" = ms."memberId" AND m."deletedAt" IS NULL
       WHERE ms."organizationId" = ${organizationId}::uuid AND ms."status" = 'SUSPENDED' AND ms."updatedAt" >= now() - interval '2 days' LIMIT ${LOTE}`;
  }
  /** Socios cuyo aviso de privacidad firmado ya no es la versión publicada. */
  privacyOutdated(organizationId: string) {
    return this.db.$queryRaw<Array<{ memberId: string; version: string }>>`
      WITH vigente AS (
        SELECT "version" FROM "consent_documents" WHERE "organizationId" = ${organizationId}::uuid AND "consentType" = 'PRIVACY_NOTICE' AND "status" = 'PUBLISHED' LIMIT 1
      ), firmado AS (
        SELECT DISTINCT ON (c."memberId") c."memberId", c."documentVersion"
          FROM "member_consents" c WHERE c."organizationId" = ${organizationId}::uuid AND c."consentType" = 'PRIVACY_NOTICE' AND c."granted" = true AND c."revokedAt" IS NULL
         ORDER BY c."memberId", c."grantedAt" DESC
      )
      SELECT f."memberId", v."version" FROM firmado f, vigente v
        JOIN "members" m ON true
       WHERE m."id" = f."memberId" AND m."deletedAt" IS NULL AND m."status" = 'ACTIVE' AND f."documentVersion" <> v."version"
       LIMIT ${LOTE}`;
  }
}

/**
 * Avisos del día (PS-03): pago por vencer, pago vencido, clase mañana,
 * suspensión, aviso de privacidad nuevo. Corre después de marcar la mora,
 * para que el "vencido" sea de hoy. Idempotente por `dedupeKey`.
 */
const notices: JobHandler = async (organizationId) => {
  const result: JobResult = { job: 'portal.notices', processed: 0, skipped: 0, batches: 1, truncated: false, errors: [] };
  const scan = new NoticeScanRepository();
  // Cada aviso nace en la campana y, si el socio tiene encendidas las notificaciones de ese tema, sale a su teléfono (3.10; D-34 c).
  const notificaciones = new PortalNotificationsService();
  const avisos = { emit: (aviso: Parameters<PortalNotificationsService['avisar']>[1]) => notificaciones.avisar(organizationId, aviso) };
  // Con cobro en línea no se manda al socio al mostrador (UX7 Portal 6).
  const enLinea = onlinePaymentsEnabled();
  // Las sedes agrupadas por su fecha de hoy: casi siempre un solo grupo.
  const dias = (await new BusinessCalendar(organizationId).dias()).grupos;
  const pasos: Array<[string, () => Promise<number>]> = [
    ['pago-por-vencer', async () => {
      let n = 0;
      for (const { day, sedes } of dias) {
      const filas = await scan.dueSoon(organizationId, 3, day, sedes);
      for (const c of filas) n += await avisos.emit({ memberId: c.memberId, kind: 'PAYMENT_DUE_SOON', dedupeKey: `PAYMENT_DUE_SOON:${c.id}`, title: 'Tu pago vence pronto', body: `${c.concept}: ${formatMoney(money(c.amountCents))} vence el ${fecha(c.dueDate)}. ${enLinea ? 'Puedes pagarlo desde Pagos.' : 'Puedes pagar en recepción.'}` });
      if (filas.length === LOTE) result.truncated = true;
      }
      return n;
    }],
    ['pago-vencido', async () => {
      let n = 0;
      for (const { day, sedes } of dias) {
      const filas = await scan.overdue(organizationId, day, sedes);
      for (const c of filas) n += await avisos.emit({ memberId: c.memberId, kind: 'PAYMENT_OVERDUE', dedupeKey: `PAYMENT_OVERDUE:${c.id}`, title: 'Tienes un pago vencido', body: `${c.concept}: ${formatMoney(money(c.amountCents))} venció el ${fecha(c.dueDate)}. ${enLinea ? 'Págalo desde Pagos y te pones al corriente al momento.' : 'Pásate a recepción para ponerte al corriente.'}` });
      if (filas.length === LOTE) result.truncated = true;
      }
      return n;
    }],
    ['clase-manana', async () => {
      let n = 0;
      for (const { day, sedes } of dias)
      for (const b of await scan.classesTomorrow(organizationId, day, sedes)) n += await avisos.emit({ memberId: b.memberId, kind: 'CLASS_TOMORROW', dedupeKey: `CLASS_TOMORROW:${b.id}`, title: `Mañana: ${b.name}`, body: `A las ${b.startsAt.toLocaleTimeString('es-MX', { timeZone: b.zona, hour: '2-digit', minute: '2-digit', hour12: false })} en ${b.branch}. Si no vas a ir, cancela desde Clases para que otro tome tu lugar.` });
      return n;
    }],
    ['suspension', async () => {
      let n = 0;
      for (const ms of await scan.suspendedToday(organizationId)) n += await avisos.emit({ memberId: ms.memberId, kind: 'MEMBERSHIP_SUSPENDED', dedupeKey: `MEMBERSHIP_SUSPENDED:${ms.id}`, title: 'Tu membresía está suspendida', body: enLinea ? 'Se agotó el plazo de gracia. En cuanto pagues, aquí o en recepción, vuelves a entrar.' : 'Se agotó el plazo de gracia. En cuanto pagues en recepción, vuelves a entrar.' });
      return n;
    }],
    ['aviso-de-privacidad', async () => {
      let n = 0;
      const filas = await scan.privacyOutdated(organizationId);
      for (const f of filas) n += await avisos.emit({ memberId: f.memberId, kind: 'PRIVACY_NOTICE_UPDATED', dedupeKey: `PRIVACY_NOTICE_UPDATED:${f.version}`, title: 'Hay una versión nueva del aviso de privacidad', body: 'Puedes leerla en recepción; la versión que firmaste sigue guardada en tu cuenta.' });
      if (filas.length === LOTE) result.truncated = true;
      return n;
    }],
  ];
  for (const [paso, fn] of pasos) {
    try { result.processed += await fn(); } catch (error) { result.errors.push({ entityId: paso, error: error instanceof Error ? error.message : String(error) }); }
  }
  // El proceso del cierre diario termina al acabar: antes, que salgan las notificaciones.
  await esperarEnvios();
  return result;
};

export const PORTAL_JOBS: ReadonlyArray<{ name: string; handler: JobHandler }> = [
  { name: 'portal.notices', handler: notices },
];
