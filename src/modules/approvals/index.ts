/**
 * Módulo FIRMAS — la segunda firma del maker-checker: en el mostrador (quien
 * firma teclea su contraseña) y a distancia (quien opera la pide y quien puede
 * la da desde su teléfono).
 *
 * Tablas propias: `approval_grants`, `approval_requests`, `approval_signer_locks`.
 *
 * Nació en la auditoría 8 (fase 1, bloque 1.7; A4 «Se mueve») con lo que
 * vivía en `identity`, donde la identidad y la firma compartían archivo.
 * Depende de `identity` (usuarios, permisos, avisos al teléfono y la
 * contraseña); nada de la identidad depende de él.
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerApprovalRoutes } from './approvals.routes.js';

// `request.verifyApprover`, que usan las rutas de billing, cash, memberships,
// payments, privacy y finance antes de autorizar. Se pone al montar el módulo.
export { registerApprovalVerifier } from './approval-verifier.js';

// Consumida por: las pruebas de control. El maker-checker comprueba contra la
// base que el segundo usuario existe, está activo, es de esta organización y
// TIENE el permiso que aprueba; el dominio (`authorize.ts`) es puro y no puede.
export { ApprovalService } from './approval.service.js';

// Consumida por: `modules.ts` (el plan de jobs). La pasada de las solicitudes
// a distancia que vencieron sin respuesta (bloque 1.16).
export { APPROVAL_JOBS } from './approvals.jobs.js';
