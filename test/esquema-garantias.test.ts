import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPrismaClient } from '@gymflow/db';
import { closeDb, getDb } from '../src/platform/db/client.js';

/**
 * LAS GARANTÍAS QUE NO ESTÁN EN `schema.prisma` (28-20; bloque 1.17b).
 *
 * El libro de solo agregar no lo sostiene Prisma: lo sostienen triggers y
 * permisos escritos a mano en las migraciones (`REVOKE DELETE`, `…_append_only`,
 * `…_no_update`). `prisma migrate diff` no los ve: si una migración recrea
 * una tabla y se le olvida su trigger, el esquema «coincide» y la bitácora ya
 * se puede editar. `verify-schema.mjs` de `gymflow-db` solo los imprime.
 *
 * Aquí están escritos. Una migración que agregue, quite o cambie uno hace
 * fallar esta prueba, y quien la toque tiene que venir a decir que era eso lo
 * que quería.
 */
const TRIGGERS = [
  // tabla · trigger · sobre qué (I insertar, U actualizar, D borrar)
  'access_decisions · access_decisions_append_only · UD',
  'attendance_events · attendance_events_append_only · UD',
  'audit_logs · audit_logs_no_delete · D',
  'audit_logs · audit_logs_no_update · U',
  'cash_movements · cash_movements_append_only · UD',
  'cash_movements · cash_movements_session_open · I',
  'charge_adjustments · charge_adjustments_append_only · UD',
  'consent_documents · consent_document_immutable_trg · U',
  'consent_documents · consent_document_solo_borrador_se_borra_trg · D',
  'inventory_movements · inventory_movements_append_only · UD',
  'member_consents · member_consents_immutable · U',
  'membership_events · membership_events_no_delete · D',
  'membership_events · membership_events_no_update · U',
  'payment_allocations · payment_allocations_append_only · D',
  'payment_attempts · payment_attempt_resolve_once_trg · U',
  'payments · payments_cash_session_open · I',
  'payments · payments_no_delete · D',
  'platform_audit_logs · platform_audit_logs_no_delete · D',
  'platform_audit_logs · platform_audit_logs_no_update · U',
  'pos_sale_lines · pos_sale_lines_append_only · UD',
  'pos_sales · pos_sales_cash_session_open · IU',
  'pos_sales · pos_sales_no_delete · D',
  'refunds · refund_within_payment_trg · IU',
  'visit_ledger_entries · visit_ledger_no_delete · D',
  'visit_ledger_entries · visit_ledger_no_update · U',
  'webhook_events · webhook_events_solo_borrar_invalidos · D',
];

/** Lo que el rol de la aplicación (`gymflow_app`) NO puede hacer. Toda tabla que no está aquí: leer, insertar, actualizar y borrar. */
const SOLO_AGREGAR = [
  'access_decisions', 'attendance_events', 'audit_logs', 'cash_movements', 'charge_adjustments', 'class_booking_blocks', 'follow_ups',
  'inventory_movements', 'member_consents', 'membership_events', 'payment_allocations', 'platform_audit_logs', 'pos_sale_lines', 'visit_ledger_entries',
];
const SIN_BORRAR = [
  'approval_grants', 'approval_requests', 'approval_signer_locks', 'billing_cycles', 'biometric_enrollments', 'branch_module_overrides', 'cash_sessions',
  'chargebacks', 'charges', 'member_credentials', 'member_imports', 'member_intakes', 'member_legacy_codes', 'operating_expenses',
  'organization_entitlements', 'organization_modules', 'payment_attempts', 'payments', 'platform_invoices', 'platform_payments', 'platform_plans',
  'pos_sales', 'refunds',
];
const SIN_ACTUALIZAR = ['face_templates'];

describe('las garantías del esquema que Prisma no ve', () => {
  let owner: ReturnType<typeof createPrismaClient>;
  beforeAll(() => { owner = createPrismaClient(process.env.DATABASE_URL_MIGRATOR); });
  afterAll(async () => { await owner.$disconnect(); await closeDb(); });

  it('los triggers escritos a mano son exactamente estos', async () => {
    const filas = await owner.$queryRawUnsafe<Array<{ t: string; n: string; tipo: number }>>(
      `select tgrelid::regclass::text t, tgname n, tgtype::int tipo from pg_trigger where not tgisinternal order by 1, 2`);
    const sobre = (tipo: number) => [[4, 'I'], [16, 'U'], [8, 'D'], [32, 'T']].filter(([bit]) => (tipo & (bit as number)) > 0).map(([, l]) => l).join('');
    expect(filas.map((f) => `${f.t} · ${f.n} · ${sobre(f.tipo)}`)).toEqual(TRIGGERS);
  });

  it('el rol de la aplicación no puede borrar ni corregir el libro: los permisos son exactamente estos', async () => {
    const filas = await owner.$queryRawUnsafe<Array<{ tabla: string; permisos: string | null }>>(
      `select t.tablename tabla, string_agg(p.privilege_type, ',' order by p.privilege_type) permisos
         from pg_tables t left join information_schema.table_privileges p
           on p.table_name = t.tablename and p.table_schema = 'public' and p.grantee = 'gymflow_app'
              and p.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
        where t.schemaname = 'public' and t.tablename <> '_prisma_migrations'
        group by 1 order by 1`);
    const con = (permisos: string) => filas.filter((f) => (f.permisos ?? '') === permisos).map((f) => f.tabla);
    expect(con('INSERT,SELECT'), 'solo agregar').toEqual(SOLO_AGREGAR);
    expect(con('INSERT,SELECT,UPDATE'), 'sin borrar').toEqual(SIN_BORRAR);
    expect(con('DELETE,INSERT,SELECT'), 'sin actualizar').toEqual(SIN_ACTUALIZAR);
    // Todo lo demás, completo: una tabla nueva sin permisos (la aplicación no la podría usar) también se nota aquí.
    const resto = filas.filter((f) => ![...SOLO_AGREGAR, ...SIN_BORRAR, ...SIN_ACTUALIZAR].includes(f.tabla));
    expect(resto.filter((f) => f.permisos !== 'DELETE,INSERT,SELECT,UPDATE').map((f) => `${f.tabla}: ${f.permisos}`)).toEqual([]);
  });

  it('y de verdad no puede: la base rechaza a la aplicación cuando intenta borrar o editar la bitácora, un pago o un cargo', async () => {
    const nadie = '00000000-0000-7000-8000-000000000000';
    for (const sql of [
      `DELETE FROM "audit_logs" WHERE "id" = '${nadie}'`,
      `UPDATE "audit_logs" SET "reason" = 'editado' WHERE "id" = '${nadie}'`,
      `DELETE FROM "payments" WHERE "id" = '${nadie}'`,
      `DELETE FROM "charges" WHERE "id" = '${nadie}'`,
      `DELETE FROM "membership_events" WHERE "id" = '${nadie}'`,
      `UPDATE "payment_allocations" SET "amountCents" = 1 WHERE "paymentId" = '${nadie}'`,
    ]) {
      await expect(getDb().$executeRawUnsafe(sql), sql).rejects.toThrow(/permission denied|permiso denegado/i);
    }
  });

  it('ni el dueño de las tablas borra un asiento o un pago: el trigger lo impide', async () => {
    const asiento = await owner.auditLog.findFirst({ select: { id: true } });
    if (asiento) await expect(owner.$executeRawUnsafe(`DELETE FROM "audit_logs" WHERE "id" = '${asiento.id}'`)).rejects.toThrow();
    const pago = await owner.payment.findFirst({ select: { id: true } });
    if (pago) await expect(owner.$executeRawUnsafe(`DELETE FROM "payments" WHERE "id" = '${pago.id}'`)).rejects.toThrow();
    expect(asiento ?? pago, 'la base de pruebas tiene al menos un asiento o un pago').toBeTruthy();
  });
});
