/**
 * Módulo AVISOS — lo que la dueña debe saber sin abrir el panel (auditoría 8,
 * fase 4, bloque 4.2; decisión D-05: alertas al momento, resumen del lunes a
 * las 7:00 y cada aviso se puede apagar).
 *
 * Tablas propias: `owner_alerts` y `owner_alert_starts`. (`push_preferences`,
 * qué apagó cada quien en su teléfono, es de `identity`, junto a las
 * suscripciones.)
 *
 * Solo LEE de los demás: las cajas sin cortar se las pide a `cash`, la semana
 * en cifras a `analytics`, y lo demás lo lee de la bitácora y de las tablas de
 * otros módulos como hace `analytics`, sin escribir en ninguna. Nadie depende
 * de él: los avisos que otros módulos ya mandaban (la lista de exsocios, los
 * fallos con la contraseña) los siguen mandando ellos con `PushService` y su
 * `kind`, y aquí solo se pueden apagar. Las solicitudes de firma y la cuenta
 * con GymFlow llegan siempre.
 *
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerAlertRoutes } from './alerts.routes.js';
export { ALERT_JOBS } from './alerts.jobs.js';
