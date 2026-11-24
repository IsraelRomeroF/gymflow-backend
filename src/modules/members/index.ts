/**
 * Módulo SOCIOS — expediente y consentimientos.
 *
 * Tablas propias: `members`, `member_consents`, `member_code_counters`,
 * `member_legacy_codes`. Los prospectos (`prospects`) y el seguimiento
 * (`follow_ups`) tienen módulo propio desde la auditoría 8 (bloque 1.7).
 * Ver la nota sobre fronteras en `modules/organization/index.ts`.
 */
export { registerMemberRoutes } from './members.routes.js';

// Consumida por: memberships (alta), billing (titular del cargo y saldo cacheado).
// `findByIdIncludingArchived` la consume `access`: distinguir credencial
// desconocida de socio dado de baja es lo que permite a recepción decir algo
// útil en la pantalla de excepción.
export { MemberRepository } from './member.repository.js';

// Consumida por: intake. El alta digital termina en un socio real, y crearlo
// aquí —y no replicando la lógica allá— mantiene una sola alta: una sola
// deduplicación, un solo código de socio, una sola entrada de bitácora.
export { MemberService } from './member.service.js';

// Consumida por: prospects. «Inscribir» desde un interesado da de alta con las
// reglas del mostrador y convierte en la misma unidad de trabajo (bloque 2.4).
export { altaEnMostrador, leerAlta, responderAlta } from './profile.routes.js';

// Consumida por: payments. La evidencia del mandato de domiciliación es un
// consentimiento como los demás y vive con ellos: tenerla en otra tabla sería
// tener dos sitios donde buscar qué firmó un socio.
export { ConsentRepository } from './consent.repository.js';

// Consumida por: imports. Los códigos del sistema anterior son parte del
// expediente (se buscan desde recepción), así que viven aquí y no en la importación.
export { LegacyCodeRepository } from './legacy-code.repository.js';

// Los TEXTOS que firma el socio viven con sus consentimientos. Consumido por:
// intake (alta digital y la pantalla de textos) y access (biometría).
export { ConsentDocumentRepository, type ConsentDocumentRecord } from './consent-document.repository.js';

// Consumida por: privacy (el portal dice al socio que su firma biométrica es
// de un texto anterior al vigente; 6-03, 21-09).
export { firmasBiometricasPorRenovar, type FirmaBiometricaPorRenovar } from './biometric-renewal.js';

// FIRMAR Y RETIRAR, un solo servicio (auditoría 8, bloque 1.10). Consumida por:
// privacy (portal, solicitudes ARCO y la inscripción de los efectos del
// retiro), payments (el mandato) y access (quitar el último rostro retira su permiso).
export {
  firmarConsentimiento, retirarConsentimiento, retirarBiometricoSinRegistro, registrarEfectoDeRetiro, efectosDeRetiroInscritos,
  type CanalDeFirma, type FirmaInput, type RetiroInput, type RetiroHecho, type ViaDeRetiro, type EfectoDeRetiro,
} from './consent.service.js';

// Los textos: revisar antes de publicar, historial y retirar. Consumida por:
// intake (las rutas `/consent-documents` de listar, publicar y retirar viven allí).
export { listarTextos, publicarTexto, retirarTexto, revisionDeTexto } from './consent-document.service.js';
// D-25 (3.7): el aviso de privacidad no se publica sin la firma de la dueña. Consumida por: intake (la ruta de publicar).
export { esAvisoPorFirmar, pedirFirmaDelAviso } from './aviso-firma.js';

// Consumida por: portal (lista y job de avisos) e intake (alta aprobada). Los avisos son del socio (PS-03).
export { MemberNoticeRepository, type NoticeKind } from './notice.repository.js';

// Consumida por: intake (bloque 3.4). El responsable del celular compartido (D-09) y el tutor de un menor (D-10).
export { guardianSchema, responsibleSchema, prepararResponsable, asentarResponsable, ResponsibleRepository, type GuardianInput, type ResponsibleInput } from './responsible.js';

// Fase 4, bloque 4.8 (D-36): el socio cambia su contacto desde el portal. Consumida por: portal (las rutas
// `/portal/me/contact`) y analytics (el renglón del Inicio que avisa al mostrador).
export { cambiarContactoPropio, contactoPropio, contactoPropioSchema, olvidarFallosDeConfirmacion, type ContactoCambiado, type ContactoPropioInput } from './contacto-propio.js';
export { ContactChangeRepository } from './contact-change.repository.js';
// Las monta el módulo PORTAL (como la invitación): su permiso es del portal, y apagado el portal no existen.
export { registerContactChangeRoutes } from './contact-changes.routes.js';
