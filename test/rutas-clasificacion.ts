import type { GimnasioDeRutas, RecursoClase } from './rutas-fixtures.js';

/**
 * CLASIFICACIÓN DE LAS RUTAS (bloque 1.17b).
 *
 * `rutas-registro.test.ts` recorre el REGISTRO de rutas (lo que de verdad
 * monta la API) y a cada una le pregunta por su sesión, su permiso, su
 * alcance de sede y su aislamiento entre gimnasios. Lo que no se puede
 * deducir del registro se declara aquí, y una ruta que no esté clasificada
 * hace fallar la prueba: nace una ruta, se decide aquí qué es.
 *
 * Qué toca cuando se agrega una ruta:
 *  1. Con parámetro (`/algo/:id`): su prefijo debe estar en
 *     `RECURSO_POR_PREFIJO` (de qué clase es el id). Si es una clase nueva,
 *     se siembra en `rutas-fixtures.ts` (y se sube `VERSION`).
 *  2. Si escribe y valida el cuerpo antes de buscar el recurso: su cuerpo
 *     mínimo válido va en `CUERPOS`.
 *  3. Si con un recurso ajeno no responde 404: va en `SIN_404_AJENO` con el
 *     porqué (y la prueba comprueba lo que se declare).
 *  4. Con permiso: comprueba la sede del recurso, o va en `DE_ORGANIZACION`
 *     con el porqué de que valga para todo el gimnasio.
 */

/** De qué clase es el `:id` de cada familia de rutas (el prefijo es lo que va antes del primer parámetro). */
export const RECURSO_POR_PREFIJO: Record<string, RecursoClase> = {
  '/access/decisions': 'accessDecision',
  '/access/gateways': 'accessGateway',
  '/approvals/requests': 'approvalRequest',
  '/biometric-enrollments': 'biometricEnrollment',
  '/branches': 'branch',
  '/cash-registers': 'cashRegister',
  '/cash-sessions': 'cashSession',
  '/charges': 'charge',
  '/classes/bookings': 'classBooking',
  '/classes/schedules': 'classSchedule',
  '/classes/templates': 'classTemplate',
  '/classes/types': 'classType',
  '/coaches': 'user',
  '/consent-documents': 'consentDocument',
  '/credentials': 'credential',
  '/expenses': 'expense',
  '/intakes': 'intake',
  '/member-imports': 'memberImport',
  '/members': 'member',
  '/memberships': 'membership',
  '/payments': 'payment',
  '/payments/attempts': 'paymentAttempt',
  '/plans': 'plan',
  '/pos/sales': 'posSale',
  '/privacy/requests': 'privacyRequest',
  '/products': 'product',
  '/prospects': 'prospect',
  '/routines': 'routine',
  '/users': 'user',
  '/visit-packs': 'visitPack',
};

/** Los parámetros que no se llaman `:id`. */
export const OTROS_PARAMETROS: Record<string, RecursoClase | { literal: string }> = {
  ':cid': 'consent',
  ':rowId': 'memberImportRow',
  ':branchId': 'branch',
  // La clave de un módulo no es un recurso de ningún gimnasio.
  ':key': { literal: 'classes' },
};

export type Cuerpo = (g: GimnasioDeRutas) => Record<string, unknown>;

const MOTIVO = 'Prueba del registro de rutas';
/** Lo que se manda cuando la ruta no tiene cuerpo propio aquí: casi todas las que escriben piden solo el motivo. */
export const CUERPO_POR_OMISION: Record<string, unknown> = { reason: MOTIVO };

/**
 * Cuerpo mínimo VÁLIDO de las rutas que validan antes de buscar el recurso.
 * Los ids que lleva son del gimnasio de rutas (el mismo que el del `:id`).
 * Sin un cuerpo válido la ruta responde 422 y no se llega a preguntar nada.
 */
export const CUERPOS: Record<string, Cuerpo> = {
  'PATCH /classes/schedules/:id/capacity': () => ({ capacity: 12 }),
  'PATCH /consent-documents/:id': () => ({ title: 'Texto de rutas, corregido' }),
  'PATCH /plans/:id': () => ({ reason: MOTIVO, name: 'Mensual de rutas' }),
  'PATCH /users/:id': () => ({ reason: MOTIVO, fullName: 'Recepción de rutas' }),
  'POST /access/decisions/:id/collect': () => ({ method: 'CASH', amountCents: '100' }),
  'POST /access/gateways/:id/heartbeat': () => ({ policyVersion: 'v1' }),
  'POST /approvals/requests/:id/answer': () => ({ answer: 'Sí, ya está contado' }),
  'POST /approvals/requests/:id/approve': () => ({ password: 'no-es-la-contraseña' }),
  // Fase 3 · bloque 3.7: la firma de la dueña en el aviso (busca el texto y su solicitud antes de mirar la contraseña).
  'POST /consent-documents/:id/sign': () => ({ password: 'no-es-la-contraseña' }),
  'POST /approvals/requests/:id/ask': () => ({ question: '¿De qué socio es?' }),
  'POST /cash-sessions/:id/close': () => ({ countedCashCents: '0' }),
  // D-15 (bloque 3.5): `/movements` es de quien retira; `/petty-movements`, de quien anota fondo y gasto chico.
  'POST /cash-sessions/:id/movements': () => ({ movementType: 'WITHDRAWAL', amountCents: '100', reason: MOTIVO }),
  'POST /cash-sessions/:id/petty-movements': () => ({ movementType: 'FLOAT_IN', amountCents: '100', reason: MOTIVO }),
  // Fase 4 · bloque 4.3 (D-17): la revisión del descuadre lleva su nota; el retiro del dueño, importe y motivo.
  'POST /cash-sessions/:id/variance/review': () => ({ note: MOTIVO }),
  'POST /cash-sessions/:id/owner-draw': () => ({ amountCents: '100', reason: MOTIVO }),
  'POST /charges/:id/adjustments': () => ({ adjustmentType: 'DISCOUNT', amountCents: '100', reason: MOTIVO }),
  'POST /classes/schedules/:id/bookings': (g) => ({ memberId: g.ids.member }),
  'POST /intakes/:id/link': (g) => ({ memberId: g.ids.member }),
  'POST /member-imports/:id/decide-all': () => ({ kind: 'NEW', decision: 'SKIP' }),
  'POST /members/:id/biometric-enrollments': (g) => ({ modality: 'FACE', branchId: g.sedeB, templateRef: 'rutas:plantilla', algorithmVendor: 'prueba', reason: MOTIVO }),
  'POST /members/:id/biometric-enrollments/face': (g) => ({ branchId: g.sedeB, frames: ['A'.repeat(120)], reto: 'turn_left', reason: MOTIVO }),
  // Fase 2 · bloque 2.3 (biometría): «Actualizar» valida los cuadros antes de buscar el enrolamiento.
  'POST /biometric-enrollments/:id/renew': () => ({ frames: ['A'.repeat(120)] }),
  // Fase 3 · bloque 3.3 (pase de prueba, D-08): valida la sede antes de buscar al socio.
  'POST /members/:id/trial-pass': (g) => ({ branchId: g.sedeB }),
  'POST /members/:id/charges': (g) => ({ chargeType: 'MANUAL_ADJUSTMENT', concept: 'Cargo de rutas', subtotalCents: '100', reason: MOTIVO, branchId: g.sedeB }),
  'POST /members/:id/consents': () => ({ consentType: 'MARKETING', granted: true }),
  'POST /members/:id/credentials': () => ({ kind: 'PIN', pin: '4821' }),
  'POST /members/:id/credit/apply': (g) => ({ branchId: g.sedeB }),
  // Fase 3 · bloque 3.5 (D-12): el perdón del adeudo valida el motivo de catálogo antes de buscar al socio.
  'POST /members/:id/debt/waiver': () => ({ reasonCode: 'CORTESIA', reason: MOTIVO }),
  // D-13: las dos devoluciones validan importe, llave y por dónde sale el dinero antes de buscar el registro.
  'POST /payments/:id/return': () => ({ amountCents: '100', reason: MOTIVO, requestKey: 'rutas-devolucion-0001' }),
  'POST /members/:id/credit/return': (g) => ({ amountCents: '100', method: 'CASH', branchId: g.sedeB, reason: MOTIVO, requestKey: 'rutas-saldo-0001' }),
  'POST /members/:id/day-passes': (g) => ({ planId: g.ids.plan, branchId: g.sedeB, saleKey: 'rutas-pase-0001' }),
  'POST /members/:id/follow-ups': () => ({ channel: 'CALL', outcome: 'ANSWERED' }),
  // Fase 2 · bloque 2.9 (bandeja de salida): valida el cuerpo antes de buscar al socio; el mensaje se busca después (no existe: 404).
  'POST /members/:id/outbound-messages/mark': (g) => ({ messageId: g.ids.member, as: 'DISMISSED' }),
  'POST /members/:id/memberships/sale': (g) => ({ planId: g.ids.plan, branchId: g.sedeB }),
  'POST /members/:id/payments': (g) => ({ method: 'CASH', amountCents: '100', idempotencyKey: 'rutas-cobro-0001', branchId: g.sedeB }),
  'POST /members/:id/privacy-requests': () => ({ kind: 'ACCESS' }),
  'POST /members/:id/routine': (g) => ({ routineId: g.ids.routine }),
  'POST /members/:id/visit-packs': (g) => ({ planId: g.ids.plan, saleKey: 'rutas-paquete-0001', branchId: g.sedeB }),
  'PUT /memberships/:id/price-protection': () => ({ protected: true, reason: MOTIVO }),
  // Fase 3 · bloque 3.5 (D-14).
  'PUT /memberships/:id/auto-renew': () => ({ autoRenew: false, reason: MOTIVO }),
  // Fase 4 · bloque 4.4 (D-18): los plazos del socio. Los de la deuda piden además la firma de la dueña (428 sin ella).
  'PUT /member-terms/retention': () => ({ dormantDays: 21, reason: MOTIVO }),
  'PUT /member-terms/debt': () => ({ lostDebtDays: 90, reason: MOTIVO }),
  'POST /memberships/:id/debt-decision': () => ({ decision: 'FORGIVE', reason: MOTIVO }),
  'POST /memberships/:id/freeze': () => ({ days: 7, reason: MOTIVO }),
  'POST /memberships/:id/plan-change': (g) => ({ planId: g.ids.plan, reason: MOTIVO }),
  'POST /memberships/:id/renewal': () => ({ expectedPeriodStart: '2026-01-01' }),
  'POST /payments/:id/refund': () => ({ amountCents: '100', reason: MOTIVO }),
  'POST /privacy/requests/:id/effect': () => ({ note: MOTIVO }),
  'POST /privacy/requests/:id/identity': () => ({ note: MOTIVO }),
  'POST /privacy/requests/:id/resolve': () => ({ outcome: 'DENIED', resolution: MOTIVO }),
  'POST /prospects/:id/convert': (g) => ({ memberId: g.ids.member }),
  // Fase 2 · bloque 2.4 (captación): validan el cuerpo antes de buscar al interesado o el alta.
  'POST /prospects/:id/close': () => ({ reasonCode: 'PRECIO' }),
  'PATCH /intakes/:id/corrections': () => ({ corrections: { emergencyContactName: 'Ana' } }),
  'POST /intakes/:id/reject': () => ({ reasonCode: 'PRUEBA' }),
  'POST /prospects/:id/follow-ups': () => ({ channel: 'CALL', outcome: 'ANSWERED' }),
  'POST /users/:id/rescue': () => ({ action: 'deactivate', reason: MOTIVO }),
  'POST /visit-packs/:id/adjust': () => ({ delta: 1, reason: MOTIVO }),
  'PUT /classes/schedules/:id/coach': (g) => ({ coachUserId: g.ids.user }),
  'PUT /classes/templates/:id/coach': (g) => ({ coachUserId: g.ids.user }),
  'PUT /member-imports/:id/rows/:rowId': () => ({ decision: 'SKIP' }),
  'PUT /members/:id/coach': (g) => ({ coachUserId: g.ids.user }),
  'PUT /organization/modules/:key': () => ({ enabled: true }),
  'PUT /organization/modules/:key/branches/:branchId': () => ({ enabled: true }),
  'PUT /routines/:id': () => ({ name: 'Rutina de rutas', days: [{ name: 'Día 1', items: [] }] }),
  'PUT /users/:id/role': () => ({ roleKey: 'RECEPTION', reason: MOTIVO }),
  'PUT /users/:id/sections': () => ({ sections: [], reason: MOTIVO }),
};

/** Lo que va en la URL después de `?` en las lecturas que exigen algo (un motivo, una fecha, de quién). */
export const CONSULTAS: Record<string, string | ((g: GimnasioDeRutas) => string)> = {
  'GET /members/:id/export': `reason=${encodeURIComponent(MOTIVO)}`,
  'GET /audit/export.csv': `reason=${encodeURIComponent(MOTIVO)}`,
  'GET /members/follow-ups/latest': (g) => `ids=${g.ids.member}`,
  'GET /access/manual-policy': (g) => `memberId=${g.ids.member}`,
  'GET /reports/daily': 'from=2026-01-01&to=2026-01-31',
  'GET /reports/movements': 'date=2026-01-15',
  'GET /expenses': (g) => `month=${g.mes}`,
  // Fase 4 · bloque 4.5 (D-26): lo que se repite y lo que propone para un mes.
  'GET /expenses/recurring': (g) => `month=${g.mes}`,
  // Fase 3 · bloque 3.7: el resumen de a quién toca lo que se firma.
  'GET /reports/signature-brief': (g) => `resourceType=Member&resourceId=${g.ids.member}`,
};

/** Rutas con permiso que tienen los cuatro puestos: ninguna cuenta del catálogo recibe 403 de la puerta. */
export const PERMISO_DE_TODOS: string[] = [
  'GET /inventory', 'GET /plans', 'GET /plans/:id', 'GET /plans/:id/quote', 'GET /products',
  // Fase 4 · bloque 4.4 (D-18): los plazos del socio los lee toda pantalla que dice uno (ninguna escribe su número).
  'GET /member-terms',
];

/** Rutas con parámetro que no nombra un recurso de un gimnasio (no hay «ajeno» que pedir). */
export const SIN_RECURSO_DE_GIMNASIO: Record<string, string> = {
  'PUT /organization/modules/:key': 'la clave es la de un módulo del producto, no un recurso; el gimnasio es el de la sesión',
};

/** Rutas que con un recurso de otro gimnasio no responden 404, y por qué está bien. */
export const SIN_404_AJENO: Record<string, { status: number[]; porque: string; sinDatos?: (cuerpo: string) => boolean }> = {
  'GET /members/:id/visit-packs': { status: [200], porque: 'lista vacía: no confirma que el socio exista', sinDatos: (c) => c === '[]' },
  'GET /payments/:id/refunds': { status: [200], porque: 'lista vacía: no confirma que el pago exista', sinDatos: (c) => c.includes('"refunds":[]') && c.includes('"refundedCents":"0"') },
  'POST /members/:id/biometric-enrollments/face': { status: [422, 503], porque: 'procesa las imágenes con el motor facial antes de buscar al socio: el rechazo es de la foto (o del motor caído), nunca un alta' },
  'POST /members/:id/memberships/sale': { status: [409], porque: 'mira primero que el plan se venda en la sede (los dos del cuerpo, también ajenos): «no se vende ahí», sin confirmar nada' },
};

/** Rutas con permiso que valen para todo el gimnasio: no miran la sede del recurso, y por qué. */
export const DE_ORGANIZACION: Record<string, string> = {
    // Fase 4 · bloque 4.5 (D-26): a quién se le anota un pago de nómina. Nombre y puesto de todo el personal, sin sueldos;
    // exige anotar gastos para TODO el gimnasio (la dueña y la gerencia), no en una sede.
    'GET /expenses/payees': 'el personal es de todo el gimnasio: exige el permiso con alcance de organización',
    // Bloque 3.5 (D-15): los topes del cajón son del gimnasio, no de una sede; los ve quien ve o mueve la caja en cualquiera.
    'GET /cash/limits': 'los topes del cajón valen para todo el gimnasio',
    // Fase 4 · bloque 4.4 (D-18): los plazos del socio son del gimnasio, no de una sede.
    'GET /member-terms': 'los plazos del socio valen para todo el gimnasio',
    'PUT /member-terms/retention': 'los plazos de retención son del gimnasio: exige `retention:terms:set` sobre toda la organización',
    'PUT /member-terms/debt': 'los plazos de la deuda son del gimnasio: exige `billing:debt-terms:set` sobre toda la organización, y la firma de la dueña',
    'GET /members/:id/standing': 'expediente único: si el socio está de baja (D-18) se pregunta desde cualquier sede; lo que debe solo se le dice a quien ve estados de cuenta',
    // Bloque 3.5 (D-12): lo que debe un socio se ve como su estado de cuenta, desde cualquier sede.
    'GET /members/:id/debt': 'expediente único',
    // El expediente del socio es ÚNICO en la organización: se cobra y se
    // atiende en cualquier sede (cartera consolidada, cobro cruzado).
    'GET /members': 'expediente único', 'GET /members/search': 'expediente único',
    'GET /members/:id': 'expediente único', 'POST /members/check-duplicates': 'deduplicar es de toda la organización',
    'GET /members/:id/consents': 'expediente único', 'GET /members/:id/memberships': 'expediente único',
    'GET /memberships/:id': 'expediente único', 'GET /memberships/:id/events': 'expediente único',
    'GET /members/:id/visit-packs': 'expediente único', 'GET /visit-packs/:id': 'expediente único',
    'GET /members/:id/statement': 'cobro cruzado entre sedes',
    'GET /members/:id/statement/charges': 'cobro cruzado entre sedes', 'GET /members/:id/statement/payments': 'cobro cruzado entre sedes',
    'GET /payments/:id/receipt': 'el comprobante se reimprime en cualquier sede', 'GET /charges/:id/adjustments': 'cobro cruzado entre sedes',
    'GET /members/:id/credentials': 'expediente único', 'GET /members/:id/biometric-enrollments': 'expediente único',
    'GET /members/:id/payment-methods': 'la tarjeta es del socio, no de la sede',
    'GET /prospects': 'prospectos de la organización',
    // Catálogos compartidos: el precio por sede se resuelve dentro.
    'GET /plans': 'catálogo', 'GET /plans/:id': 'catálogo', 'GET /plans/:id/quote': 'catálogo',
    'GET /products': 'catálogo', 'POST /products': 'catálogo', 'PATCH /products/:id': 'catálogo',
    'POST /classes/types': 'catálogo de clases', 'PATCH /classes/types/:id': 'catálogo de clases',
    'GET /discount-reasons': 'lista cerrada de motivos',
    'GET /consent-documents': 'textos de la organización', 'GET /consent-documents/:id': 'textos de la organización',
    'POST /consent-documents': 'textos de la organización',
    'GET /users': 'directorio de personal', 'GET /users/:id': 'directorio de personal',
    'GET /roles': 'catálogo de roles',
    'GET /users/adjustable-permissions': 'lista cerrada de acciones ajustables por persona',
    'GET /members/coaches': 'directorio de coaches de la organización para asignar al socio',
    'GET /classes/coaches': 'directorio de coaches de la organización para asignar a una clase',
    'GET /members/access-summary': 'mismo alcance que el padrón y la búsqueda: los socios entran a varias sedes',
    'GET /roles/matrix': 'catálogo de roles con sus permisos y topes',
    'GET /payments/:id/refunds': 'detalle de un pago ya autorizado',
    // Rutinas: son de la organización y el socio entrena con la misma en
    // cualquier sede.
    'GET /exercises': 'catálogo de ejercicios', 'POST /exercises': 'catálogo de ejercicios',
    'GET /routines': 'rutinas de la organización', 'GET /routines/:id': 'rutinas de la organización',
    'POST /routines': 'rutinas de la organización', 'PUT /routines/:id': 'rutinas de la organización',
    'POST /routines/:id/archive': 'rutinas de la organización',
    'GET /members/:id/routine': 'la rutina es del socio, no de la sede',
    'POST /members/:id/routine': 'la rutina es del socio, no de la sede',
    'POST /members/:id/routine/end': 'la rutina es del socio, no de la sede',
    // Distribución a los gateways: toda sede necesita saber qué se revocó.
    'GET /access/roster/public-key': 'clave pública', 'GET /access/revocations': 'revocaciones a todos los gateways',
  // Lo que la prueba de comportamiento encontró sin declarar (1.17b).
  'GET /consent-documents/:id/review': 'textos de la organización',
  'GET /access/face/status': 'el estado del motor facial no es de ninguna sede (la lectura del código se la saltaba: llevaba `module:` entre la URL y la seguridad)',
  'GET /members/:id/day-passes': 'expediente único: los pases del día del socio, como sus paquetes de visitas',
  // Fase 3 · bloque 3.3 (biometría y entrada).
  'GET /members/:id/trial-pass': 'expediente único: el pase de prueba es uno por persona en TODO el gimnasio; cualquier sede pregunta si ya lo usó',
  'PUT /access/face-rule': 'la regla «entrar solo con rostro» (D-06) es del gimnasio entero: exige `settings:org` sobre toda la organización',
  // Fase 2 · bloque 2.7 (dirección).
  'GET /plans/:id/impact': 'catálogo: el impacto de un plan se cuenta en todo el gimnasio (lo pide quien tiene `catalog:manage` sobre toda la organización)',
  // Fase 3 · bloque 3.7 (dirección): el aviso de privacidad es de todo el gimnasio y lo firma quien firma por todo el gimnasio.
  'GET /consent-documents/signature-requests': 'textos de la organización',
  'POST /consent-documents/:id/sign': 'el aviso de privacidad es de todo el gimnasio: exige `approvals:grant` sobre toda la organización',
  'POST /consent-documents/:id/sign/reject': 'el aviso de privacidad es de todo el gimnasio: exige `approvals:grant` sobre toda la organización',
  // Fase 3 · bloque 3.1 (D-02): al apoderado lo nombra y lo revoca quien da la segunda firma de todo el gimnasio.
  'POST /approvals/proxy': 'el apoderado es uno por gimnasio: exige `approvals:grant` sobre toda la organización',
  'POST /approvals/proxy/revoke': 'el apoderado es uno por gimnasio: exige `approvals:grant` sobre toda la organización',
  'GET /plans/:id/protected-prices': 'catálogo (D-19, bloque 3.6): quiénes conservan su precio en un plan se revisa para todo el gimnasio, con `catalog:manage` sobre la organización',
  'PUT /memberships/:id/price-protection': 'catálogo (D-19, bloque 3.6): marcar que una membresía conserva su precio es una decisión de precio de todo el gimnasio (`catalog:manage` sobre la organización), no del mostrador de una sede',
  // Fase 2 · bloque 2.2 (ficha del socio).
  'GET /members/:id/pos-sales': 'expediente único: las compras de la tienda del socio, como su estado de cuenta (cobro cruzado entre sedes)',
  'GET /members/:id/history': 'expediente único: la historia del socio; cada parte se filtra dentro con el permiso de quien pregunta sobre la sede de casa',
  // Fase 2 · bloque 2.4 (captación).
  'GET /members/:id/onboarding': 'expediente único: lo que falta para terminar el alta se atiende en cualquier sede; cuánto debe solo lo ve quien puede cobrar en la sede del socio',
  // Fase 3 · bloque 3.4 (altas).
  'GET /members/:id/shared-phone': 'expediente único: con quién comparte celular y quién responde por el número; a quien no ve teléfonos en la sede del socio no se le dice nada (`hidden`)',
  'GET /prospects/sources': 'catálogo de «¿Cómo se enteró?» del gimnasio', 'PUT /prospects/sources': 'catálogo de «¿Cómo se enteró?» del gimnasio (lo cambia quien configura la organización)',
  // Fase 2 · bloque 2.5 (clases).
  'GET /members/:id/bookings': 'expediente único: las clases del socio (también las que toma en otra sede) se ven desde su ficha en cualquier sede; cuál es su cargo solo lo recibe quien ve estados de cuenta en la sede del socio',
  // Fase 2 · bloque 2.6 (coach).
  'POST /members/:id/routine/personalize': 'la rutina es del socio, no de la sede',
  'GET /coach/today': 'el inicio del coach: sus socios y sus rutinas, siempre de quien pregunta (no recibe un id)',
  'GET /coaches/:id/members': 'cuántos socios tiene un coach: el coach de un socio es de toda la organización',
  // Fase 3 · bloque 3.8 (coach, D-29).
  'POST /coach/claim': '«Hacerme su coach»: no recibe un socio, solo el código que el socio dictó; el coach de un socio es de toda la organización',
};

/** Rutas con parámetro que con un recurso de otra sede no responden 403, y por qué está bien. */
export const SEDE_SIN_403: Record<string, { status: number; porque: string }> = {
  'PATCH /members/:id': { status: 200, porque: 'expediente único: cualquier sede corrige nombre y notas; el contacto que no ve no lo pisa (1.1 §7-6) y mudarlo de sede sí exige alcance (branch-isolation.test.ts)' },
};

/** Lecturas sin parámetro que no reciben `branchId` (responden lo de las sedes de quien pide, o no son de sede). */
export const LECTURAS_SIN_FILTRO_DE_SEDE: Record<string, string> = {
  // Fase 3 · bloque 3.3: la regla del rostro es del gimnasio; las cuentas que trae son solo de las sedes de quien pregunta.
  'GET /access/face-rule': 'no recibe sede: la regla es del gimnasio y las cuentas por sucursal son solo las de las sedes de quien pregunta',
  'GET /members/biometric-renewals': 'no recibe sede: quien no tiene la bitácora ve solo los socios de sus sedes',
  'GET /members/follow-ups/latest': 'recibe socios, no sede: de los que no son de sus sedes no devuelve nada',
  'GET /biometric-enrollments/pending-deletion': 'no recibe sede: filtra por las sedes de quien pide',
  // Fase 2 · bloque 2.3 (biometría).
  'GET /biometric-enrollments/summary': 'no recibe sede: cuenta solo los rostros de las sedes de quien pide',
  'GET /access/face/measurements': 'no recibe sede: trae solo los intentos de medición de las sedes de quien pide',
  'GET /access/face/status': 'el estado del motor facial no es de ninguna sede',
  'GET /intakes/pending-count': 'no recibe sede: cuenta las altas de las sedes de quien pide',
  'GET /prospects/pending': 'no recibe sede: cuenta los interesados de las sedes de quien pide',
  // Fase 4 · bloque 4.7 (D-31): la vista previa del cierre solo.
  'GET /prospects/auto-close': 'no recibe sede: cuenta los interesados por cerrarse solos de las sedes de quien pide',
  'GET /expenses': 'no recibe sede: quien ve solo sus sedes no ve los gastos de las demás ni los del gimnasio',
  // Fase 4 · bloque 4.5 (D-26).
  'GET /expenses/recurring': 'no recibe sede: quien ve solo sus sedes no ve lo que se repite en las demás ni lo de todo el gimnasio',
  'GET /member-imports': 'no recibe sede: lista las importaciones de las sedes de quien pide',
};
