/**
 * Módulo IDENTIDAD — personal, roles, sesiones y MFA.
 *
 * Tablas propias: `users`, `roles`, `permissions`, `role_permissions`,
 * `role_assignments`, `role_limit_sets`, `sessions` (`mfa_factors` queda sin uso desde 2026-10-09).
 *
 * NO gestiona socios: un socio no es un usuario (ADR-023). La segunda firma
 * (maker-checker) tiene módulo propio desde la auditoría 8: `approvals`.
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerAuthRoutes } from './auth.routes.js';
export { authPlugin } from './auth.plugin.js';
export { registerStaffRoutes } from './identity.routes.js';

// Consumida por: app.ts (montaje del plugin) y por las pruebas de seguridad.
export { SessionRepository } from './session.repository.js';


// Consumida por: cash. El corte dice quién abrió y quién cerró el turno.
export { UserRepository } from './user.repository.js';

// Consumidas por: approvals. Quién puede firmar (sus permisos en la base),
// su contraseña con la misma escalera de fallos que el inicio de sesión, y el
// aviso a su teléfono cuando le piden una firma a distancia.
export { AuthUserRepository } from './user.repository.js';
export { GrantRepository } from './role.repository.js';
export { PushService } from './push.service.js';
export type { AuthService } from './auth.service.js';

// Consumida por: members. Los coaches del gimnasio, para asignar el de un socio.
export { StaffRepository } from './staff.repository.js';
