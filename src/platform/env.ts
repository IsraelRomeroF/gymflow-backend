import { z } from 'zod';
import { LLAVE_DATOS, LLAVE_DATOS_ANTERIOR, avisarSiNombreAnterior, llaveDeDatos } from './sensitive.js';
import { CORS_POR_OMISION, abiertoAInternet, datosDeConexion, perfilDe, problemasDeArranque, procesadorPorOmision, tipoDeBase, type Perfil } from './perfiles.js';

/** Valor de desarrollo. En producción se rechaza explícitamente. */
const DEV_WEBHOOK_SECRET = 'sandbox-dev-secret';

const schema = z.object({
  /**
   * SIN valor por defecto. Antes era `development`: un despliegue que
   * olvidara la variable arrancaba sin cookies `Secure`, sin CSP y aceptando
   * el secreto público del webhook, sin quejarse. Ahora no arranca.
   */
  NODE_ENV: z.enum(['development', 'test', 'production'], { message: 'Falta NODE_ENV (development, test o production)' }),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1, 'Falta DATABASE_URL'),
  /**
   * Dominio de las cookies de sesión (D-01). Vacía, cada cookie vale solo en
   * la dirección exacta que la puso, que es lo más cerrado y lo que basta con
   * una dirección fija por aplicación. Con valor (`tu-dominio.mx`), la cookie
   * vale en ese dominio y lo que cuelga de él, y SOLO se le pone a quien
   * entró por ahí: quien entra por `localhost` o por la red del gimnasio
   * recibe la suya sin dominio (`platform/http/sesion.ts`). La combinación la
   * revisa `platform/perfiles.ts`.
   */
  SESSION_COOKIE_DOMAIN: z.string().default(''),
  SESSION_TTL_STAFF_HOURS: z.coerce.number().int().positive().default(12),
  CORS_ORIGINS: z.string().default(CORS_POR_OMISION),
  /**
   * LLAVE DE LOS DATOS SENSIBLES (21-17): 32 bytes en base64. De ella se
   * derivan las que cifran las notas de salud y las plantillas del rostro
   * (`platform/sensitive.ts`). Perderla o cambiarla deja ilegibles esos datos:
   * se respalda aparte del volcado (doc 16 §6). Obligatoria: el vacío por
   * omisión solo deja que llegue con el nombre anterior.
   */
  SENSITIVE_DATA_KEY: z.string().default(''),
  /** Nombre ANTERIOR de la misma llave (nació para el 2FA retirado): se acepta una versión más, con aviso. */
  MFA_ENCRYPTION_KEY: z.string().default(''),
  /**
   * Clave PRIVADA Ed25519 (PEM) con la que se firma el padrón.
   *
   * El gateway vive en una red que el gimnasio no controla del todo: sin
   * firma, quien alcance ese equipo le escribe un padrón propio y abre la
   * puerta a quien quiera. Opcional en desarrollo; en producción, obligatoria.
   */
  ROSTER_SIGNING_KEY: z.string().optional(),
  /**
   * Intentos de activación del portal por IP y ventana de 5 minutos.
   *
   * Protege sobre todo de agotar recursos: adivinar el código es inviable
   * —31¹⁰ combinaciones— pero martillear el endpoint no lo es. Es
   * configurable porque la batería de pruebas necesita activar decenas de
   * dispositivos y bajar el límite real para que quepan sería debilitar el
   * control por comodidad.
   */
  PORTAL_ENROLL_ATTEMPTS: z.coerce.number().int().positive().default(10),
  /**
   * Envíos del formulario público de alta por TELÉFONO capturado cada 10
   * minutos (sin teléfono, por correo). Antes era por IP, y en una promoción
   * veinte teléfonos salen por la misma IP del gimnasio (9-05).
   */
  INTAKE_SUBMIT_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Altas por QR aceptadas por SUCURSAL en una hora (D28-01): cubre una inscripción de enero y frena la basura. */
  INTAKE_SUBMIT_PER_BRANCH: z.coerce.number().int().positive().default(60),
  /** Web Push (DP-10): llaves VAPID propias, sin proveedor. Sin ellas el panel no ofrece avisos al teléfono. */
  VAPID_PUBLIC_KEY: z.string().min(20).optional(),
  VAPID_PRIVATE_KEY: z.string().min(20).optional(),
  VAPID_SUBJECT: z.string().default('mailto:soporte@gymflow.mx'),
  /**
   * GymFlow como emisor de sus facturas a los gimnasios (D-39, bloque 4.9; `tenants/emisor.ts`).
   * Datos fiscales reales: van en la configuración del servidor, NUNCA en el repositorio.
   * Sin la razón social, la factura sale a nombre de «GymFlow» y sin datos de pago.
   */
  GYMFLOW_ISSUER_LEGAL_NAME: z.string().optional(),
  GYMFLOW_ISSUER_RFC: z.string().optional(),
  GYMFLOW_ISSUER_ADDRESS: z.string().optional(),
  GYMFLOW_ISSUER_PAYMENT: z.string().optional(),
  GYMFLOW_ISSUER_CONTACT: z.string().optional(),
  /** Altas digitales SIN revisar que admite una sucursal antes de cerrar el formulario (PS-09). */
  INTAKE_PENDING_MAX_PER_BRANCH: z.coerce.number().int().positive().default(200),
  /**
   * Intentos por PERSONA cada 5 minutos (el nombre es histórico): al entrar,
   * el mismo correo desde la misma IP real; al firmar o cambiar la
   * contraseña, la misma sesión. Antes contaba solo la IP, y detrás del panel
   * todo el gimnasio era una sola (24-01). Ver `platform/http/rate-limit.ts`.
   */
  AUTH_ATTEMPTS_PER_IP: z.coerce.number().int().positive().default(30),
  /**
   * Inicios de sesión desde una misma IP real, de CUALQUIER correo, cada 5
   * minutos. El bloqueo por cuenta y el límite por persona no frenan probar
   * una misma contraseña contra quinientos correos, ni el gasto de CPU de mil
   * verificaciones de Argon2 seguidas; este tope sí.
   */
  AUTH_ATTEMPTS_PER_NETWORK: z.coerce.number().int().positive().default(100),

  /**
   * Proxies de confianza, separados por comas. Vacío = no se confía en nadie.
   *
   * Estaba en `trustProxy: true`, que significa confiar en TODOS los saltos:
   * `request.ip` salía del `X-Forwarded-For` que manda el cliente. Un
   * `curl -H "X-Forwarded-For: ..."` distinto en cada petición anulaba los
   * cinco límites por IP a la vez.
   *
   * Y tenía una segunda consecuencia peor: la IP que se guarda como
   * **evidencia del mandato de domiciliación** la elegía el propio socio.
   * Ante un contracargo esa prueba no vale nada — y la carga de la prueba es
   * del comercio.
   *
   * En local los perfiles ponen `127.0.0.1,::1` (el proxy de Next y el túnel
   * corren en la misma computadora): por el túnel llega la IP real que pone
   * Cloudflare, y cada persona cuenta aparte (24-01). El uso real y el modo
   * remoto no arrancan sin ella (`platform/perfiles.ts`).
   */
  TRUSTED_PROXIES: z.string().default(''),

  /**
   * Secreto con el que se verifica la firma de los webhooks del procesador.
   *
   * Es lo ÚNICO que autentica esa ruta: no hay sesión detrás de un webhook.
   * En desarrollo tiene valor por defecto; en producción, un valor débil
   * equivale a dejar que cualquiera declare pagos cobrados.
   */
  PAYMENT_WEBHOOK_SECRET: z.string().min(8).default(DEV_WEBHOOK_SECRET),

  /**
   * Procesador de pagos con tarjeta. `none` = el cobro en línea no está
   * conectado: el portal no ofrece domiciliar ni pagar y todo se cobra en
   * recepción. `sandbox` es la caja de arena: aprueba sin mover dinero, así
   * que solo corre con una base de pruebas (`gymflow_pruebas`, `gymflow_test*`,
   * `gymflow_dev`) y nunca en producción: un socio vería "pago aplicado" sin
   * que nadie le cobrara. Sin valor: `sandbox` en esas bases fuera de
   * producción, `none` en cualquier otra (el uso real, `gymflow_local`).
   */
  PAYMENT_PROVIDER: z.enum(['none', 'sandbox']).optional(),

  /**
   * Orígenes del portal del socio: los únicos a los que el procesador puede
   * devolver al socio tras el 3DS (SEC-13). Sin esta lista, `returnUrl` era
   * una redirección abierta con la marca del gimnasio encima. Vacía en
   * desarrollo = cualquiera (el portal se abre por IP de la red local).
   */
  PORTAL_ORIGINS: z.string().default(''),

  /**
   * CONSOLA DE PLATAFORMA: el panel de mayor rango (libera, suspende y cobra a
   * todos los gimnasios). Sesión más corta, cierre por inactividad,
   * reconfirmación con la contraseña antes de cualquier cambio y, si se
   * configura, solo desde IPs conocidas. Sin verificación en dos pasos
   * (decisión del dueño, 2026-10-09; nota en ADR-008).
   */
  /**
   * RECONOCIMIENTO FACIAL con la cámara de recepción (2026-10-09). El motor es
   * el de GymFlow (`motor-facial/`, InsightFace; copia propia del sidecar de
   * HRFlow desde la auditoría 8): recibe cuadros, devuelve el embedding y la
   * prueba de vida; no guarda nada. Sin él, la biometría por cámara se muestra
   * como no disponible.
   */
  FACE_SIDECAR_URL: z.string().default('http://127.0.0.1:5101'),
  /**
   * Token que el motor exige en la cabecera `X-Face-Token` (A5-N4): el mismo
   * valor aquí y en el motor. Vive fuera de los repositorios
   * (`~/.gymflow/uso-real.env` y el `.env` de la API); lo crea y lo pasa
   * gymflow.sh con `motor-facial/token.sh`. Sin él, o con otro, el motor
   * responde 401 y la cámara se muestra como no disponible, con el motivo.
   */
  FACE_SIDECAR_TOKEN: z.string().optional(),
  /** Similitud coseno mínima para reconocer (buffalo_sc calibrado en HRFlow: 0.38). */
  FACE_MATCH_THRESHOLD: z.coerce.number().min(0.2).max(0.9).default(0.38),
  /** Ventaja mínima sobre el segundo candidato: si dos se parecen igual, no se adivina. */
  FACE_MATCH_MARGIN: z.coerce.number().min(0).max(0.5).default(0.05),
  /**
   * Dónde vale un rostro (5-16, 6-13; bloque 2.3). `branch` (hoy): la Estación
   * compara solo con los rostros tomados en SU sucursal. `organization`:
   * compara con todos los del gimnasio y la puerta autoriza con el plan («tu
   * plan no cubre esta sucursal»). Cambia quién entra con su rostro y crece el
   * padrón contra el que se compara: NO se pasa a `organization` hasta medir
   * el umbral con socios reales (`fase2/2.3-guia-de-medicion.md`).
   */
  FACE_RECOGNITION_SCOPE: z.enum(['branch', 'organization']).default('branch'),

  PLATFORM_SESSION_HOURS: z.coerce.number().int().min(1).max(12).default(8),
  PLATFORM_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  PLATFORM_STEP_UP_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  /** IPs desde las que se puede operar la plataforma, separadas por coma. Vacía = cualquiera. */
  PLATFORM_ALLOWED_IPS: z.string().default(''),
});

export type Env = z.infer<typeof schema> & {
  corsOrigins: string[]; trustedProxies: string[]; portalOrigins: string[]; paymentProvider: 'none' | 'sandbox'; platformAllowedIps: string[];
  /** El perfil de arranque por la base: `uso-real`, `pruebas` o ninguno (`platform/perfiles.ts`). */
  perfil: Perfil | null;
  /** D-01: el panel o el portal se sirven en una dirección que no es de esta computadora ni de su red. */
  abiertoAInternet: boolean;
  /** Dirección pública del panel y del portal, sin diagonal final; `null` si no hay. */
  panelPublicUrl: string | null;
  portalPublicUrl: string | null;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  · ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida:\n${issues}`);
  }
  // Una sola llave de datos sensibles: con su nombre propio o, una versión más,
  // con el anterior. Las dos variables quedan con el MISMO valor, así que quien
  // todavía lea `MFA_ENCRYPTION_KEY` (el motor facial) descifra igual.
  const llave = llaveDeDatos({ [LLAVE_DATOS]: parsed.data.SENSITIVE_DATA_KEY, [LLAVE_DATOS_ANTERIOR]: parsed.data.MFA_ENCRYPTION_KEY });
  if (!llave) throw new Error(`Falta ${LLAVE_DATOS}: es la llave de los datos sensibles (notas de salud y rostros). Ver doc 16 §2 y §6`);
  if (Buffer.from(llave.valor, 'base64').length !== 32) {
    throw new Error(`${llave.nombre} debe ser exactamente 32 bytes en base64`);
  }
  avisarSiNombreAnterior(llave, parsed.data.NODE_ENV);
  parsed.data.SENSITIVE_DATA_KEY = llave.valor;
  parsed.data.MFA_ENCRYPTION_KEY = llave.valor;
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.ROSTER_SIGNING_KEY) {
    throw new Error('En producción ROSTER_SIGNING_KEY es obligatoria: un padrón sin firmar es un padrón falsificable');
  }
  // El secreto del webhook tenía valor por defecto y ninguna guardia, así que
  // un despliegue que olvidara la variable arrancaba sin quejarse con un
  // secreto publicado en el repositorio: cualquiera podría declarar pagos
  // cobrados o abrir contracargos falsos.
  // Detrás del proxy de Next o de un balanceador, sin proxies de confianza
  // TODAS las peticiones llegan con la IP del proxy: los límites por IP se
  // vuelven uno solo para todo el mundo (un atacante bloquea el login de
  // todos) y la IP guardada como evidencia de un consentimiento es falsa.
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.TRUSTED_PROXIES.trim()) {
    throw new Error('En producción TRUSTED_PROXIES es obligatoria: incluye el servidor de Next y el balanceador');
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.PORTAL_ORIGINS.trim()) {
    throw new Error('En producción PORTAL_ORIGINS es obligatoria: sin ella el regreso del 3DS es una redirección abierta');
  }
  // Sin valor: la caja de arena solo en una base de pruebas y nunca en
  // producción. Antes bastaba con no estar en producción, y el uso real (que
  // corre en desarrollo) cobraba con ella (25-01).
  const tipo = tipoDeBase(datosDeConexion(parsed.data.DATABASE_URL)?.nombre);
  const paymentProvider = parsed.data.PAYMENT_PROVIDER ?? procesadorPorOmision(parsed.data.NODE_ENV, tipo);
  if (parsed.data.NODE_ENV === 'production' && paymentProvider === 'sandbox') {
    throw new Error('En producción PAYMENT_PROVIDER no puede ser sandbox: la caja de arena aprueba cobros sin mover dinero');
  }
  if (parsed.data.NODE_ENV === 'production' && paymentProvider !== 'none' && parsed.data.PAYMENT_WEBHOOK_SECRET === DEV_WEBHOOK_SECRET) {
    throw new Error('En producción PAYMENT_WEBHOOK_SECRET es obligatoria: es lo ÚNICO que autentica el webhook del procesador');
  }
  const env: Env = {
    ...parsed.data,
    paymentProvider,
    perfil: perfilDe(parsed.data.DATABASE_URL),
    abiertoAInternet: abiertoAInternet({ PANEL_PUBLIC_URL: source.PANEL_PUBLIC_URL, PORTAL_PUBLIC_URL: source.PORTAL_PUBLIC_URL }),
    panelPublicUrl: (source.PANEL_PUBLIC_URL ?? '').trim().replace(/\/$/, '') || null,
    portalPublicUrl: (source.PORTAL_PUBLIC_URL ?? '').trim().replace(/\/$/, '') || null,
    platformAllowedIps: parsed.data.PLATFORM_ALLOWED_IPS.split(',').map((x) => x.trim()).filter(Boolean),
    corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    trustedProxies: parsed.data.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean),
    portalOrigins: parsed.data.PORTAL_ORIGINS.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  };
  // PERFILES (fase 0.1): el uso real y las pruebas no se confunden. Con una
  // combinación inválida no se arranca, y se dice todo lo que falla y cómo se
  // arregla (`platform/perfiles.ts`).
  const problemas = problemasDeArranque({
    NODE_ENV: env.NODE_ENV, API_PORT: env.API_PORT, DATABASE_URL: env.DATABASE_URL, paymentProvider,
    trustedProxies: env.trustedProxies, CORS_ORIGINS: env.CORS_ORIGINS, portalOrigins: env.portalOrigins,
    PORTAL_PUBLIC_URL: source.PORTAL_PUBLIC_URL, PANEL_PUBLIC_URL: source.PANEL_PUBLIC_URL,
    SESSION_COOKIE_DOMAIN: env.SESSION_COOKIE_DOMAIN,
  });
  if (problemas.length > 0) {
    throw new Error(`La configuración no corresponde a ningún perfil válido (uso real, pruebas o producción):\n${problemas.map((p) => `  · ${p}`).join('\n')}`);
  }
  return env;
}
