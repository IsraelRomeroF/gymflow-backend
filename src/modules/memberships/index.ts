/**
 * Módulo MEMBRESÍAS — contrato socio↔plan, calendario y paquetes de visitas.
 *
 * Tablas propias: `memberships`, `membership_branch_access`,
 * `membership_events`, `visit_packs`, `visit_ledger_entries`.
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerMembershipRoutes } from './membership.routes.js';
export { MEMBERSHIP_JOBS } from './membership.jobs.js';

// Consumida por: billing.
//   · `MembershipRepository` para leer el periodo que se factura.
//   · `settleByPayment` es el ÚNICO comando que billing puede invocar aquí:
//     liquidar la cuota transiciona la membresía. Es la frontera más delicada
//     del sistema y por eso está explícitamente acotada a una función.
export { MembershipRepository, type MembershipRecord } from './membership.repository.js';
export { MembershipService } from './membership.service.js';
//   · `VisitPackRepository` porque VENDER un paquete es una operación de
//     dinero: crea su cargo. Consumirlo y consultarlo siguen siendo de este
//     módulo. Poner la venta aquí obligaría a memberships a depender de
//     billing, y billing ya depende de memberships: sería un ciclo, y un ciclo
//     hace inextraíbles a los dos.
export { VisitPackRepository, type VisitPackRecord } from './visitpack.repository.js';

// Consumida por: billing, que se registra para anular las cuotas sin pagar de
// una membresía que se cancela (DM-03). `memberships` no sabe quién escucha.
export { registerMembershipClosedHook, emitMembershipClosed, type MembershipClosed } from './closed-hooks.js';
