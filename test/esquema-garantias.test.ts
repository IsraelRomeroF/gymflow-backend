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
  // Bloque 3.9 (D-32): nadie se anonimiza sin la firma de su lista, y lo firmado no cambia.
  'privacy_batch_items · privacy_batch_items_firma_trg · IU',
  'privacy_batches · privacy_batches_firma_trg · U',
  'refunds · refund_within_payment_trg · IU',
  'visit_ledger_entries · visit_ledger_no_delete · D',
  'visit_ledger_entries · visit_ledger_no_update · U',
  'webhook_events · webhook_events_solo_borrar_invalidos · D',
];

/** Lo que el rol de la aplicación (`gymflow_app`) NO puede hacer. Toda tabla que no está aquí: leer, insertar, actualizar y borrar. */
const SOLO_AGREGAR = [
  'access_decisions', 'attendance_events', 'audit_logs', 'cash_movements', 'charge_adjustments', 'class_booking_blocks', 'follow_ups',
  // `membership_price_changes` y `plan_price_changes` (bloque 3.6, D-19): la historia de un cambio de precio no se corrige.
  // `pos_sale_returns` (bloque 3.5, D-13): la devolución de una venta de tienda es un asiento; no se corrige ni se borra.
  // `owner_alert_starts` (bloque 4.2, D-05): desde cuándo avisa cada gimnasio se escribe una vez; moverlo haría sonar de golpe lo pasado.
  'inventory_movements', 'member_consents', 'membership_events', 'membership_price_changes', 'owner_alert_starts', 'payment_allocations', 'plan_price_changes', 'platform_audit_logs', 'pos_sale_lines', 'pos_sale_returns', 'privacy_conservation_starts',
  // `privacy_calculated_baja_starts` (bloque 4.18, P-01): el arranque de la baja calculada se escribe una vez; moverlo borraría rostros antes de tiempo.
  'privacy_calculated_baja_starts',
  // `membership_price_applications` (bloque 4.20, P-14): con qué cuota llegó un aumento que esperó sus 15 días; no se corrige ni se borra.
  'membership_price_applications',
  // `recurring_expense_skips` (bloque 4.5, D-26): la propuesta descartada queda con quién y cuándo; no se corrige ni se borra.
  'recurring_expense_skips',
  // `trial_passes` (bloque 3.3, D-08): un pase de prueba ya dado no se borra ni se corrige; si no, «uno por persona» no valdría.
  'trial_passes', 'visit_ledger_entries',
];
const SIN_BORRAR = [
  // `approval_proxies` (bloque 3.1, D-02): el nombramiento de apoderado es la constancia de quién pudo firmar y de cuándo a cuándo.
  'approval_grants', 'approval_proxies', 'approval_requests', 'approval_signer_locks', 'billing_cycles', 'biometric_enrollments', 'branch_module_overrides', 'cash_sessions',
  // `gym_change_requests` (bloque 4.6, D-27): la solicitud de cambio a GymFlow y su respuesta son la constancia de quién pidió qué.
  'chargebacks', 'charges', 'gym_change_requests', 'member_credentials', 'member_imports', 'member_intakes', 'member_legacy_codes', 'operating_expenses',
  // `owner_alerts` y `push_preferences` (bloque 4.2, D-05): un aviso dado a la dueña se marca como visto, no se borra; y lo que apagó en su teléfono queda apagado, no borrado.
  // `organization_billing_adjustments` y `platform_tax_changes` (bloque 4.9, D-39): el descuento dado explica por qué una factura salió más baja, y del IVA anunciado sale qué IVA llevaba la factura de un mes pasado.
  'organization_billing_adjustments', 'organization_entitlements', 'organization_modules', 'owner_alerts', 'payment_attempts', 'payments', 'platform_invoices',
  // `platform_notices` y `platform_price_changes` (bloque 3.11, D-37 y D-38): el aviso es la constancia de que se avisó antes de suspender, y de los cambios sale lo que valía un mes pasado.
  'platform_notices', 'platform_payments', 'platform_plans', 'platform_price_changes', 'platform_tax_changes',
  // `pos_sale_flags` (bloque 3.5, D-13): la marca «por corregir» se resuelve, no se borra.
  // `recurring_expenses` (bloque 4.5, D-26): un gasto que se repite se deja de repetir, no se borra: de él salieron gastos ya confirmados.
  'pos_sale_flags', 'pos_sales', 'privacy_batch_items', 'privacy_batches', 'push_preferences', 'recurring_expenses', 'refunds',
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
    // Se ordena aquí y no en SQL: el orden de «privacy_batch_items» y «privacy_batches» depende de la
    // intercalación de la base (la de CI no es la local), y lo que se afirma es el conjunto.
    expect(filas.map((f) => `${f.t} · ${f.n} · ${sobre(f.tipo)}`).sort()).toEqual([...TRIGGERS].sort());
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
    expect(con('INSERT,SELECT').sort(), 'solo agregar').toEqual([...SOLO_AGREGAR].sort());
    expect(con('INSERT,SELECT,UPDATE').sort(), 'sin borrar').toEqual([...SIN_BORRAR].sort());
    expect(con('DELETE,INSERT,SELECT').sort(), 'sin actualizar').toEqual([...SIN_ACTUALIZAR].sort());
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
