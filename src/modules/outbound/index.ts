/**
 * Módulo BANDEJA DE SALIDA — los mensajes que el gimnasio le debe a sus socios.
 *
 * Tablas propias: `outbound_messages`.
 *
 * Nació en la auditoría 8 (fase 2, bloque 2.9; hallazgos 25-10, 15-08 y
 * 28-14). Un job diario arma la lista (pago por vencer, pago vencido,
 * suspensión, plan por terminar y «te extrañamos») y recepción manda cada
 * mensaje con un toque: el enlace `wa.me` con el texto ya escrito. Nada sale
 * solo (D-34). El canal es una columna: un proveedor de WhatsApp o la
 * notificación del teléfono serían otros enviadores de la misma tabla.
 *
 * Lee (sin escribir) cargos, membresías, asistencia y seguimientos para
 * saber si el hecho sigue vivo; el «a quién» de Retención lo da `retention`
 * y el contacto que deja un «te extrañamos» lo escribe `follow-ups`.
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerOutboundRoutes } from './outbound.routes.js';
export { OUTBOUND_JOBS } from './outbound.jobs.js';

// Para el Inicio (`GET /me/home`, analytics) cuando le dé renglón a «mensajes
// por mandar»: la misma cuenta que la campana. Hoy nadie la consume.
export { OutboundService } from './outbound.service.js';
export type { AlcanceDeMensajes } from './outbound.repository.js';
