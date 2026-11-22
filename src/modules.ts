import { registerAuthRoutes, registerStaffRoutes } from './modules/identity/index.js';
import { registerApprovalRoutes, registerApprovalVerifier, APPROVAL_JOBS } from './modules/approvals/index.js';
import { registerOrganizationRoutes } from './modules/organization/index.js';
import { registerTenantRoutes, TENANT_JOBS } from './modules/tenants/index.js';
import { registerMemberRoutes } from './modules/members/index.js';
import { registerProspectRoutes } from './modules/prospects/index.js';
import { registerFollowUpRoutes } from './modules/follow-ups/index.js';
import { registerCatalogRoutes } from './modules/catalog/index.js';
import { registerMembershipRoutes, MEMBERSHIP_JOBS } from './modules/memberships/index.js';
import { registerBillingRoutes, registerBillingHooks, BILLING_JOBS } from './modules/billing/index.js';
import { registerCashRoutes } from './modules/cash/index.js';
import { registerPosRoutes, registerPosShiftContributor } from './modules/pos/index.js';
import { registerAnalyticsRoutes, registerAnalyticsMonthFigures } from './modules/analytics/index.js';
import { registerFinanceRoutes } from './modules/finance/index.js';
import { registerRetentionRoutes } from './modules/retention/index.js';
import { registerOutboundRoutes, OUTBOUND_JOBS } from './modules/outbound/index.js';
import { registerPrivacyRoutes, PRIVACY_JOBS } from './modules/privacy/index.js';
import { registerAccessRoutes } from './modules/access/index.js';
import { registerPortalRoutes, PORTAL_JOBS } from './modules/portal/index.js';
import { registerIntakeRoutes } from './modules/intake/index.js';
import { registerClassRoutes, CLASS_JOBS, registerClassHooks } from './modules/classes/index.js';
import { registerPaymentRoutes, PAYMENT_JOBS } from './modules/payments/index.js';
import { registerTrainingRoutes } from './modules/training/index.js';
import { registerImportRoutes } from './modules/imports/index.js';
import { registerHealthRoutes } from './platform/http/health.routes.js';
import { registerAuditRoutes } from './platform/audit/audit.routes.js';
import { AUDIT_JOBS } from './platform/audit/audit.jobs.js';
import type { BackendModule } from './platform/modules/types.js';

/**
 * TODOS los módulos de código, en el orden en que se montan (ADR-036).
 *
 * Es el único archivo que conoce a todos: lo consumen `app.ts` (rutas) y
 * `platform/jobs/run-daily.ts` y `run-frequent.ts` (los jobs). Extraer un módulo a
 * servicio propio se reduce a quitar su entrada.
 *
 * `module` dice a qué módulo de PRODUCTO pertenecen sus rutas: el que el
 * gimnasio enciende o apaga. Las que son de otro (la biometría y el monitor
 * viven en `access`; volver a firmar el texto biométrico, en `members`) lo
 * declaran una a una en su ruta.
 */
export const BACKEND_MODULES: readonly BackendModule[] = [
  {
    name: 'platform', module: 'core',
    register: (app) => { registerHealthRoutes(app); registerAuditRoutes(app); },
    jobs: AUDIT_JOBS,
  },
  { name: 'identity', module: 'core', register: (app, env) => { registerAuthRoutes(app, env); registerStaffRoutes(app); } },
  {
    // La segunda firma salió de `identity` (bloque 1.7). Pone `request.verifyApprover`
    // antes de que se monten los módulos que la consumen.
    name: 'approvals', module: 'core',
    register: (app, env) => { registerApprovalVerifier(app); registerApprovalRoutes(app, env); },
    jobs: APPROVAL_JOBS,
  },
  { name: 'organization', module: 'core', register: (app) => registerOrganizationRoutes(app) },
  { name: 'tenants', module: 'core', register: (app, env) => registerTenantRoutes(app, env), jobs: TENANT_JOBS },
  { name: 'catalog', module: 'core', register: (app) => registerCatalogRoutes(app) },
  { name: 'members', module: 'core', register: (app) => registerMemberRoutes(app) },
  // Prospectos y seguimientos salieron de `members` (auditoría 8, bloque 1.7).
  { name: 'prospects', module: 'prospects', register: (app) => registerProspectRoutes(app) },
  { name: 'follow-ups', module: 'retention', register: (app) => registerFollowUpRoutes(app) },
  { name: 'memberships', module: 'core', register: (app) => registerMembershipRoutes(app), jobs: MEMBERSHIP_JOBS },
  {
    name: 'billing', module: 'core',
    // Escucha el cierre de membresías (DM-03) sin que memberships conozca a billing.
    register: (app) => { registerBillingHooks(); registerBillingRoutes(app); },
    jobs: BILLING_JOBS,
  },
  { name: 'cash', module: 'cash', register: (app) => registerCashRoutes(app) },
  {
    name: 'pos', module: 'pos',
    register: (app) => {
      // El punto de venta se registra como contribuyente del corte: así el
      // documento del turno suma producto sin que caja conozca a pos. Corre
      // siempre: un turno abierto debe sumar lo vendido aunque hoy se apague.
      registerPosShiftContributor();
      registerPosRoutes(app);
    },
  },
  { name: 'access', module: 'core', register: (app, env) => registerAccessRoutes(app, env) },
  { name: 'portal', module: 'member_portal', register: (app, env) => registerPortalRoutes(app, env), jobs: PORTAL_JOBS },
  {
    // Clases va DESPUÉS del portal: consume su resolución de sesión de socio.
    name: 'classes', module: 'classes',
    register: (app) => { registerClassHooks(); registerClassRoutes(app); },
    // Apagar deja de CREAR sesiones nuevas, pero las que quedaron abiertas se
    // cierran igual: una clase no puede quedarse "en curso" para siempre.
    jobs: CLASS_JOBS.map((j) => (j.name === 'class.close-finished' ? { ...j, whenDisabled: 'run' as const } : j)),
  },
  { name: 'training', module: 'training', register: (app) => registerTrainingRoutes(app) },
  { name: 'intake', module: 'intake', register: (app, env) => registerIntakeRoutes(app, env) },
  { name: 'payments', module: 'core', register: (app, env) => registerPaymentRoutes(app, env), jobs: PAYMENT_JOBS },
  {
    // Solo lee (A3-T12). Calcula las cifras que congela el cierre de mes y se
    // registra en `finance` para dárselas, sin que `finance` la conozca.
    name: 'analytics', module: 'core',
    register: (app) => { registerAnalyticsMonthFigures(); registerAnalyticsRoutes(app); },
  },
  // Gastos y cierre de mes, y las alertas de retención, salieron de `analytics` (bloque 1.7).
  { name: 'finance', module: 'core', register: (app) => registerFinanceRoutes(app) },
  { name: 'retention', module: 'retention', register: (app) => registerRetentionRoutes(app) },
  // Bandeja de salida (fase 2, bloque 2.9): los mensajes que recepción manda por WhatsApp con un toque.
  { name: 'outbound', module: 'core', register: (app) => registerOutboundRoutes(app), jobs: OUTBOUND_JOBS },
  { name: 'privacy', module: 'core', register: (app) => registerPrivacyRoutes(app), jobs: PRIVACY_JOBS },
  { name: 'imports', module: 'core', register: (app) => registerImportRoutes(app) },
];
