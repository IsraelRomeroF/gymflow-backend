/**
 * Datos de PRESENTACIÓN.
 *
 * Llena la base de demostración (`gymflow_pruebas`, nunca la de pruebas) con un
 * gimnasio que se ve vivo: socios con nombres variados, membresías vendidas
 * en distintas fechas, pagos por varios medios, adeudos vencidos, altas
 * digitales esperando revisión y enrolamientos biométricos.
 *
 * Todo pasa por la API —`app.inject`, sin servidor— para que las reglas de
 * negocio se apliquen igual que en el mostrador: el libro, los cargos y las
 * asignaciones de pago son los que produciría recepción. Solo se tocan
 * directamente tres cosas que la API no permite fechar hacia atrás, y es a
 * propósito que no lo permita: la antigüedad del socio, la fecha de
 * revocación de dos enrolamientos y dos suspensiones de hace meses, para que
 * haya historia que mostrar. También se fecha cada cobro con tarjeta o
 * transferencia el día en que empezó su periodo (vista de Movimientos).
 *
 * Uso: `pnpm demo:reset` (ver scripts/demo-reset.sh).
 */
import { LISTA_DEL_AVISO_DE_PRIVACIDAD, modeloDeTexto } from '@gymflow/core';
import { loadDotenvFromRepoRoot } from '../src/platform/load-env.js';

loadDotenvFromRepoRoot();

if (!process.env.DATABASE_URL?.includes('gymflow_pruebas')) {
  // Salvaguarda: este sembrado crea cientos de socios. Contra la base de
  // pruebas o la de un gimnasio real sería un desastre difícil de deshacer.
  console.error('ABORTADO: DATABASE_URL no apunta a gymflow_pruebas.');
  process.exit(1);
}

const { buildApp } = await import('../src/app.js');
const { loadEnv } = await import('../src/platform/env.js');
const { getDb, closeDb } = await import('../src/platform/db/client.js');
const { uuidv7 } = await import('@gymflow/core');

const app = await buildApp(loadEnv({
  ...process.env,
  NODE_ENV: 'test',
  // La API en memoria es la de PRUEBAS (fase 0.1): su puerto, aunque no escuche.
  API_PORT: '4001',
  AUTH_ATTEMPTS_PER_IP: '10000',
  AUTH_ATTEMPTS_PER_NETWORK: '100000',
  INTAKE_SUBMIT_ATTEMPTS: '1000',
  INTAKE_SUBMIT_PER_BRANCH: '100000',
}));
await app.ready();
const db = getDb();

// ── Azar reproducible ───────────────────────────────────────────────────────
// Misma semilla, mismo gimnasio: la demo se ve igual cada vez que se regenera.
let semilla = 20260929;
function azar(): number {
  semilla |= 0; semilla = (semilla + 0x6d2b79f5) | 0;
  let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const uno = <T,>(xs: readonly T[]): T => xs[Math.floor(azar() * xs.length)]!;
const entre = (a: number, b: number) => a + Math.floor(azar() * (b - a + 1));
const ponderado = <T,>(xs: ReadonlyArray<[T, number]>): T => {
  const total = xs.reduce((s, [, p]) => s + p, 0);
  let r = azar() * total;
  for (const [v, p] of xs) { if ((r -= p) < 0) return v; }
  return xs[0]![0];
};

const NOMBRES_M = ['José', 'Juan', 'Luis', 'Carlos', 'Jorge', 'Miguel', 'Pedro', 'Francisco', 'Ricardo', 'Fernando', 'Roberto', 'Alejandro', 'Daniel', 'Javier', 'Manuel', 'Arturo', 'Sergio', 'Eduardo', 'Raúl', 'Diego', 'Emilio', 'Santiago', 'Mateo', 'Sebastián', 'Andrés', 'Iván', 'Óscar', 'Héctor', 'Gerardo', 'Rodrigo', 'Tomás', 'Adrián', 'Hugo', 'Ernesto', 'Julio', 'Marco', 'Rafael', 'Gustavo', 'Leonardo', 'Emiliano'];
const NOMBRES_F = ['María', 'Guadalupe', 'Ana', 'Carmen', 'Rosa', 'Patricia', 'Laura', 'Alejandra', 'Sofía', 'Gabriela', 'Verónica', 'Mónica', 'Claudia', 'Adriana', 'Leticia', 'Silvia', 'Beatriz', 'Rocío', 'Martha', 'Daniela', 'Fernanda', 'Valeria', 'Regina', 'Ximena', 'Paola', 'Andrea', 'Mariana', 'Lucía', 'Renata', 'Camila', 'Natalia', 'Karla', 'Diana', 'Elena', 'Itzel', 'Jimena', 'Paulina', 'Lorena', 'Montserrat', 'Isabel'];
const APELLIDOS = ['Hernández', 'García', 'Martínez', 'López', 'González', 'Pérez', 'Rodríguez', 'Sánchez', 'Ramírez', 'Cruz', 'Flores', 'Gómez', 'Morales', 'Vázquez', 'Reyes', 'Jiménez', 'Torres', 'Díaz', 'Gutiérrez', 'Ruiz', 'Mendoza', 'Aguilar', 'Ortiz', 'Castillo', 'Romero', 'Álvarez', 'Chávez', 'Ramos', 'Herrera', 'Medina', 'Rojas', 'Vargas', 'Castro', 'Guerrero', 'Ríos', 'Domínguez', 'Salazar', 'Contreras', 'Luna', 'Estrada', 'Navarro', 'Cervantes', 'Ibarra', 'Velázquez', 'Delgado', 'Figueroa', 'Campos', 'Cortés', 'Solís', 'Ponce', 'Montes', 'Valdez', 'Orozco', 'Cabrera', 'Rosales', 'Fuentes', 'Villanueva', 'Espinoza', 'Juárez', 'Moreno'];

function persona() {
  const mujer = azar() < 0.5;
  const pila = uno(mujer ? NOMBRES_F : NOMBRES_M);
  const segundo = azar() < 0.3 ? ` ${uno(mujer ? NOMBRES_F : NOMBRES_M)}` : '';
  const a1 = uno(APELLIDOS);
  let a2 = uno(APELLIDOS);
  while (a2 === a1) a2 = uno(APELLIDOS);
  return { firstName: `${pila}${segundo}`, lastName: `${a1} ${a2}` };
}

const quitarAcentos = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '');
let telSeq = 0;
const telefono = () => `+5255${String(31_000_000 + (telSeq++ * 7919) % 68_000_000).padStart(8, '0')}`;

// ── Utilidades HTTP ─────────────────────────────────────────────────────────

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'GymFlow.dev.2026' } });
  const c = res.cookies.find((x) => x.name === 'gf_session');
  if (!c) throw new Error(`login falló: ${email} ${res.body}`);
  return `gf_session=${c.value}`;
}
// Opera la gerencia general: la dueña solo consulta (2026-10-02).
const owner = await login('gerencia@demo.mx');

async function call<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, cookie = owner): Promise<T> {
  const res = await app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as object } : {}) });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body.slice(0, 300)}`);
  return res.json() as T;
}

const hoy = new Date();
const diasAtras = (n: number) => new Date(hoy.getTime() - n * 86_400_000);
const iso = (d: Date) => d.toISOString().slice(0, 10);

// ── Organización y personal ─────────────────────────────────────────────────

const org = await db.organization.findFirstOrThrow({ where: { tradeName: 'Gimnasio Demo' } });
// Nombres de persona para el personal: "Dueño Demo" se ve a prueba en una
// presentación. Son ficticios.
for (const [email, fullName] of [
  ['owner@demo.mx', 'Mariana Villaseñor'], ['gerencia@demo.mx', 'Lucía Fernández'], ['gerente@demo.mx', 'Héctor Salinas'],
  ['recepcion@demo.mx', 'Paola Núñez'], ['coach@demo.mx', 'Diego Arriaga'],
] as const) {
  await db.user.updateMany({ where: { organizationId: org.id, email }, data: { fullName } });
}

type Branch = { id: string; code: string; name: string };
const branches = (await call<Branch[]>('GET', '/branches'));
const sede = (code: string) => branches.find((b) => b.code === code)!;
const [CEN, NOR, FRO] = [sede('CEN'), sede('NOR'), sede('FRO')];
// Con dirección: "Sin dirección" en las tres sedes se veía a medio hacer (UXB-17).
// Y con enlace corto para el alta: /alta/demo-centro (UXB-14).
for (const [b, addressLine, publicSlug] of [
  [CEN, 'Av. Juárez 118, Col. Centro, Ciudad de México', 'demo-centro'],
  [NOR, 'Calz. Vallejo 1420, Col. Industrial Vallejo, Ciudad de México', 'demo-norte'],
  [FRO, 'Av. Universidad 2045, Col. Copilco, Ciudad de México', 'demo-frontera'],
] as const) {
  await call('PATCH', `/branches/${b.id}`, { addressLine, publicSlug });
}

type Plan = { id: string; code: string; billingModel: string };
const plans = await call<Plan[]>('GET', '/plans');
const plan = (code: string) => plans.find((p) => p.code === code)!;

// ── Textos de consentimiento con redacción de ejemplo ───────────────────────

const TEXTOS: Record<string, { title: string; body: string }> = {
  PRIVACY_NOTICE: {
    title: 'Aviso de privacidad',
    body: [
      'Gimnasio Demo es responsable del tratamiento de tus datos personales.',
      '',
      'Usamos tu nombre, teléfono, correo y fecha de nacimiento para darte de alta, cobrar tu membresía, avisarte de cambios en el servicio y atenderte en recepción.',
      '',
      'No vendemos tus datos. Solo los compartimos con quien procesa tus pagos, y únicamente para cobrarte.',
      '',
      'Puedes pedir en recepción, en cualquier momento, acceder a tus datos, corregirlos, cancelarlos u oponerte a su uso.',
    ].join('\n'),
  },
  HOUSE_RULES: {
    title: 'Reglamento interno',
    body: [
      '1. La membresía es personal e intransferible.',
      '2. Usa toalla en los equipos y regresa el material a su lugar.',
      '3. El acceso a clases con cupo requiere reservación.',
      '4. Tres faltas a clases reservadas bloquean nuevas reservas por siete días.',
      '5. Los casilleros se vacían al cierre de cada día.',
    ].join('\n'),
  },
  HEALTH_DATA: {
    title: 'Datos de salud (opcional)',
    body: [
      'Si quieres, cuéntanos de alguna lesión, condición o medicamento que tu coach deba conocer para cuidarte en el entrenamiento.',
      '',
      'Es opcional: si no lo compartes, entrenas igual.',
      '',
      'Lo ven solo tu coach y la gerencia, se guarda cifrado y no se comparte con nadie más.',
      '',
      'Puedes pedir que se corrija o se borre en recepción cuando quieras.',
    ].join('\n'),
  },
  BIOMETRIC: {
    // El mismo texto que propone «Usar el modelo» en Textos de consentimiento
    // (gymflow-web/lib/modelos-consentimiento.ts): la plantilla vive cifrada en
    // el servidor del gimnasio, no «solo en el equipo de la sucursal».
    title: 'Consentimiento para entrar con tu rostro',
    body: [
      'CONSENTIMIENTO EXPRESO PARA EL USO DE DATOS BIOMÉTRICOS',
      '',
      `Autorizo a ${org.legalName} ("${org.tradeName}") a registrar mi rostro con el único fin de identificarme al entrar a la sucursal donde lo registro.`,
      '',
      '- Mi rostro se registra con la cámara de recepción. La foto no se guarda: solo una plantilla, que es una serie de números que sirve para reconocerme. La plantilla se guarda cifrada en el servidor del gimnasio, ligada a este consentimiento, y no se comparte con terceros.',
      '- Se usa únicamente en la Estación de acceso de esa sucursal: me paro frente a la cámara, hago el movimiento que me pide y, si me reconoce, la entrada se decide igual que en recepción (membresía, horario y pagos).',
      '- Es opcional: si no la autorizo, recepción me da acceso por otro medio sin ningún costo.',
      '- Puedo revocar este consentimiento cuando quiera en recepción; la plantilla se borra en el acto y queda constancia del borrado. Si dejo de ser socio, mi rostro deja de reconocerse.',
      '',
      'Este consentimiento es adicional al Aviso de privacidad, que conozco.',
    ].join('\n'),
  },
};

const VERSION = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
type Doc = { id: string; consentType: string; version: string; status: string };
const docsActuales = (await call<{ documents: Doc[] }>('GET', '/consent-documents')).documents;
for (const [tipo, t] of Object.entries(TEXTOS)) {
  if (docsActuales.some((d) => d.consentType === tipo && d.version === VERSION)) continue;
  // El aviso de privacidad sale del modelo del núcleo, completo: desde 1.10 no
  // se publica uno que no trate los siete puntos ni con corchetes sin llenar.
  const modelo = tipo === 'PRIVACY_NOTICE'
    ? modeloDeTexto('PRIVACY_NOTICE', { razonSocial: org.legalName, nombreComercial: org.tradeName, sucursales: ['Centro', 'Norte', 'Frontera'], mesesDeConservacion: 12 })
    : null;
  const cuerpo = modelo
    ? modelo.texto
      .replaceAll('[DOMICILIO COMPLETO]', 'Av. Juárez 100, Centro, 06000 Ciudad de México')
      .replaceAll('[CORREO DE PRIVACIDAD]', 'privacidad@gimnasiodemo.mx')
      .replaceAll('[AGREGA AQUÍ CUALQUIER OTRA TRANSFERENCIA, O BORRA ESTE CORCHETE.]', '')
      .replaceAll('[FECHA]', hoy.toLocaleDateString('es-MX', { dateStyle: 'long' }))
    : t.body;
  const creado = await call<{ id: string }>('POST', '/consent-documents', { consentType: tipo, version: VERSION, title: modelo?.titulo ?? t.title, bodyText: cuerpo });
  const publicado = await call<{ awaitingSignature?: boolean }>('POST', `/consent-documents/${creado.id}/publish`, {
    reason: 'Textos iniciales del gimnasio de pruebas',
    ...(tipo === 'PRIVACY_NOTICE' ? { checklist: LISTA_DEL_AVISO_DE_PRIVACIDAD.map((x) => x.clave) } : {}),
  });
  // El aviso de privacidad no se publica sin la firma de la dueña (D-25).
  if (publicado.awaitingSignature) {
    await call('POST', `/consent-documents/${creado.id}/sign`, { password: 'GymFlow.dev.2026' }, await login('owner@demo.mx'));
  }
}
const vigente = async (tipo: string) =>
  (await call<{ documents: Doc[] }>('GET', '/consent-documents')).documents.find((d) => d.consentType === tipo && d.status === 'PUBLISHED')!.version;
const vPriv = await vigente('PRIVACY_NOTICE');
const vReg = await vigente('HOUSE_RULES');
console.log(`Textos publicados (versión ${VERSION}).`);

// ── Cajas abiertas: una por sucursal ────────────────────────────────────────

const cajas = new Map<string, string>();
for (const b of [CEN, NOR, FRO]) {
  const { registers } = await call<{ registers: Array<{ id: string }> }>('GET', `/cash-registers?branchId=${b.id}`);
  const abiertas = await call<{ sessions: Array<{ id: string }> }>('GET', `/cash-sessions?branchId=${b.id}&status=OPEN`);
  const s = abiertas.sessions[0] ?? await call<{ id: string }>('POST', '/cash-sessions', { cashRegisterId: registers[0]!.id, openingFloatCents: '100000', shiftLabel: 'MORNING' });
  cajas.set(b.id, s.id);
}

// ── Socios, membresías y pagos ──────────────────────────────────────────────

const TOTAL = Number(process.env.DEMO_SOCIOS ?? 260);
const socios: Array<{ id: string; branchId: string; nombre: string }> = [];
let pagados = 0, deudores = 0;

for (let i = 0; i < TOTAL; i++) {
  const p = persona();
  const branch = ponderado([[CEN, 5], [NOR, 3], [FRO, 2]] as const);
  const alta = await app.inject({
    method: 'POST', url: '/members', headers: { cookie: owner },
    payload: {
      ...p,
      phoneE164: telefono(),
      email: `${quitarAcentos(p.firstName.split(' ')[0]!).toLowerCase()}.${quitarAcentos(p.lastName.split(' ')[0]!).toLowerCase()}${i}@correo.mx`,
      birthDate: iso(diasAtras(entre(18 * 365, 58 * 365))),
      homeBranchId: branch.id,
      consents: [
        { consentType: 'PRIVACY_NOTICE', documentVersion: vPriv, granted: true },
        { consentType: 'HOUSE_RULES', documentVersion: vReg, granted: true },
      ],
      force: true,
    },
  });
  if (alta.statusCode !== 201) { console.warn(`  alta omitida: ${alta.body.slice(0, 120)}`); continue; }
  const memberId = alta.json().id as string;
  socios.push({ id: memberId, branchId: branch.id, nombre: `${p.firstName} ${p.lastName}` });

  // Uno de cada diez debe. Para que se vea el ciclo completo, su periodo
  // mensual ya terminó sin pagar: los jobs diarios lo pasan a gracia y, si la
  // gracia también se agotó, a suspendido — igual que en la vida real.
  // Morosidad de un gimnasio sano: alrededor del 10 % (UXB-17).
  const debe = azar() < 0.10;
  const antig = debe
    ? entre(50, 900)
    : ponderado([[entre(0, 20), 2], [entre(21, 120), 3], [entre(121, 420), 4], [entre(421, 1400), 2]] as const);
  const plan_ = debe ? plan('MEN')
    : ponderado([[plan('MEN'), 7], [plan('MEN3'), 2], [plan('MULTI'), 1], [plan('ANU'), 1]] as const);

  // Al corriente: la membresía arranca al inicio de su periodo en curso.
  const inicioPeriodo = debe ? entre(31, 44)
    : plan_.code === 'ANU' ? Math.min(antig, entre(0, 300))
      : plan_.code === 'MEN3' ? Math.min(antig, entre(0, 85)) : Math.min(antig, entre(0, 29));
  if (!debe) {
    // Al corriente: se vende como en el mostrador —inscripción + periodo,
    // cobrados— y el cobro la activa.
    const metodo = ponderado([['CASH', 5], ['CARD_TERMINAL', 4], ['SPEI_TRANSFER', 2]] as const);
    await call('POST', `/members/${memberId}/memberships/sale`, {
      planId: plan_.id, branchId: branch.id, reason: 'Historial de ensayo', startDate: iso(diasAtras(inicioPeriodo)),
      payment: {
        method: metodo,
        ...(metodo !== 'SPEI_TRANSFER' ? { cashSessionId: cajas.get(branch.id) } : { externalRef: `SPEI${entre(100000, 999999)}` }),
      },
    });
    pagados++;
  } else {
    // Con adeudo: pagó su mes y el mes ya terminó. Es la AUTORRENOVACIÓN del
    // job diario la que emite la cuota siguiente, y como nadie la paga, la
    // mora y la suspensión salen solas — el mismo camino que en la vida real.
    await call('POST', `/members/${memberId}/memberships/sale`, {
      planId: plan_.id, branchId: branch.id, reason: 'Historial de ensayo', startDate: iso(diasAtras(inicioPeriodo)),
      payment: { method: 'SPEI_TRANSFER', externalRef: `SPEI${entre(100000, 999999)}` },
    });
    deudores++;
  }

  await db.member.update({ where: { id: memberId }, data: { joinedAt: diasAtras(antig) } });
  if ((i + 1) % 40 === 0) console.log(`  ${i + 1}/${TOTAL} socios`);
}
console.log(`Socios: ${socios.length} · al corriente ${pagados} · con adeudo ${deudores}`);

// ── Historia de cobros por día ──────────────────────────────────────────────
// La API fecha cada cobro el día en que se registra, así que la demo nacía con
// todo el dinero "hoy" y la vista de Movimientos no tenía nada que enseñar.
// Cada cobro se fecha el día en que empezó el periodo que pagó, como habría
// pasado en la vida real, a una hora de mostrador (7:00–21:00 de CDMX). El
// efectivo también: más abajo cada día recibe su propio turno de caja, ya
// cerrado, para que su corte cuadre (UI2-07: antes todo era "hoy").
const fechados = await db.$executeRaw`
  UPDATE "payments" p
     SET "businessDate" = x.ps, "receivedAt" = x.ps + interval '13 hours' + random() * interval '14 hours'
    FROM (SELECT a."paymentId", MIN(c."periodStart") AS ps
            FROM "payment_allocations" a JOIN "charges" c ON c."id" = a."chargeId"
           WHERE c."periodStart" IS NOT NULL
           GROUP BY a."paymentId") x
   WHERE x."paymentId" = p."id" AND p."organizationId" = ${org.id}::uuid
     AND p."method" IN ('SPEI_TRANSFER', 'CARD_TERMINAL', 'CASH') AND x.ps < CURRENT_DATE`;
console.log(`Cobros fechados en su día: ${fechados}`);

// ── Suspendidos de hace meses ───────────────────────────────────────────────
// Mientras está suspendida el job no la renueva, así que su periodo se queda
// en el mes en que dejó de pagar. Son los que muestran "Decidir adeudo":
// reanudar (se cobran los meses que no vino) u olvidar (se condona y arranca
// hoy). Llegar aquí por la API tomaría meses de calendario real: se fecha
// directo, igual que la antigüedad.
for (const meses of [3, 5]) {
  const p = persona();
  const alta = await app.inject({
    method: 'POST', url: '/members', headers: { cookie: owner },
    payload: {
      ...p, phoneE164: telefono(), homeBranchId: CEN.id, force: true,
      consents: [
        { consentType: 'PRIVACY_NOTICE', documentVersion: vPriv, granted: true },
        { consentType: 'HOUSE_RULES', documentVersion: vReg, granted: true },
      ],
    },
  });
  if (alta.statusCode !== 201) { console.warn(`  suspendido omitido: ${alta.body.slice(0, 120)}`); continue; }
  const memberId = alta.json().id as string;
  socios.push({ id: memberId, branchId: CEN.id, nombre: `${p.firstName} ${p.lastName}` });
  // Pagó su primer mes; el segundo ya no, y con él quedó suspendido.
  const pagado = diasAtras(30 * meses + 30);
  await call('POST', `/members/${memberId}/memberships/sale`, {
    planId: plan('MEN').id, branchId: CEN.id, reason: 'Historial de ensayo', startDate: iso(pagado),
    payment: { method: 'SPEI_TRANSFER', externalRef: `SPEI${entre(100000, 999999)}` },
  });
  const m = await db.membership.findFirstOrThrow({ where: { memberId } });
  const fin = new Date(Date.UTC(m.currentPeriodEnd.getUTCFullYear(), m.currentPeriodEnd.getUTCMonth() + 1, m.currentPeriodEnd.getUTCDate()));
  await db.membership.update({
    where: { id: m.id },
    data: { status: 'SUSPENDED', currentPeriodStart: m.currentPeriodEnd, currentPeriodEnd: fin },
  });
  await call('POST', `/memberships/${m.id}/period-charge`);
  await db.charge.updateMany({ where: { membershipId: m.id, status: 'OPEN' }, data: { status: 'OVERDUE' } });
  await db.member.update({ where: { id: memberId }, data: { joinedAt: pagado } });
  console.log(`  suspendido hace ${meses} meses: ${p.firstName} ${p.lastName}`);
}

// ── Ventas de mostrador de 90 días ──────────────────────────────────────────

type Product = { id: string; sku: string };
const productos = await call<Product[] | { products: Product[] }>('GET', '/products');
const lista = Array.isArray(productos) ? productos : productos.products;
let ventas = 0;
// Existencia para 90 días de ventas: con la del catálogo se agotaba a la
// mitad. Entra como compra, por la API, para que el kardex cuadre.
for (const b of [CEN, NOR, FRO]) {
  for (const prod of lista) {
    await app.inject({
      method: 'POST', url: '/inventory/movements', headers: { cookie: owner },
      payload: { branchId: b.id, productId: prod.id, movementType: 'PURCHASE', quantityDelta: 200, reason: 'Compra del trimestre' },
    });
  }
}
const VENTAS = Number(process.env.DEMO_VENTAS ?? 320);
for (let i = 0; i < VENTAS; i++) {
  const b = ponderado([[CEN, 5], [NOR, 3], [FRO, 2]] as const);
  const metodo = ponderado([['CASH', 6], ['CARD_TERMINAL', 4]] as const);
  const lineas = Array.from({ length: entre(1, 2) }, () => ({ productId: uno(lista).id, quantity: entre(1, 3) }));
  const unicas = [...new Map(lineas.map((l) => [l.productId, l])).values()];
  const r = await app.inject({
    method: 'POST', url: '/pos/sales', headers: { cookie: owner },
    payload: { branchId: b.id, method: metodo, lines: unicas, idempotencyKey: `demo-pos-${i}-${Date.now()}`, ...(metodo === 'CASH' ? { cashSessionId: cajas.get(b.id) } : {}) },
  });
  if (r.statusCode < 400) ventas++;
}
console.log(`Ventas de mostrador: ${ventas}`);

// Repartidas en los últimos 90 días; las de hoy se quedan hoy (unas diez).
await db.$executeRaw`
  UPDATE "pos_sales" s SET "businessDate" = d.dia, "soldAt" = d.dia + interval '13 hours' + random() * interval '14 hours'
    FROM (SELECT "id", (CURRENT_DATE - (1 + floor(random() * 89))::int) AS dia FROM "pos_sales"
           WHERE "organizationId" = ${org.id}::uuid AND random() > 0.03) d
   WHERE d."id" = s."id"`;

// ── Turnos de caja de cada día, ya cerrados ─────────────────────────────────
// Cada sucursal tiene su turno diario con su corte: fondo de $1,000 más el
// efectivo del día; la mayoría cuadra y algunos días falta o sobra poco. El
// turno de HOY sigue abierto. Como solo puede haber un turno abierto por caja,
// el de hoy se cierra un instante y se reabre al terminar.
const yo = await db.user.findFirstOrThrow({ where: { organizationId: org.id, email: 'recepcion@demo.mx' } });
const MOTIVOS_FALTA = ['Faltó cambio', 'Cambio mal dado en hora pico', 'Billete dudoso devuelto'];
const MOTIVOS_SOBRA = ['Propina sin registrar', 'Cobro de visita sin capturar'];
let cortes = 0;
for (const b of [CEN, NOR, FRO]) {
  const hoyId = cajas.get(b.id)!;
  const hoyTurno = await db.cashSession.findUniqueOrThrow({ where: { id: hoyId } });
  await db.$transaction(async (tx) => {
    await tx.cashSession.update({ where: { id: hoyId }, data: { status: 'CLOSED', countedCashCents: 0n, closedByUserId: yo.id, closedAt: new Date() } });
    for (let d = 90; d >= 1; d--) {
      const dia = new Date(`${iso(diasAtras(d))}T00:00:00.000Z`);
      const id = uuidv7();
      await tx.cashSession.create({
        data: {
          id, organizationId: org.id, branchId: b.id, cashRegisterId: hoyTurno.cashRegisterId, openedByUserId: yo.id,
          shiftLabel: 'MORNING', businessDate: dia, status: 'OPEN', openingFloatCents: 100_000n,
          openedAt: new Date(dia.getTime() + 13 * 3_600_000),
        },
      });
      const pagos = await tx.payment.updateMany({
        where: { organizationId: org.id, method: 'CASH', businessDate: dia, OR: [{ branchId: b.id }, { branchId: null, member: { homeBranchId: b.id } }] },
        data: { cashSessionId: id },
      });
      await tx.posSale.updateMany({ where: { organizationId: org.id, branchId: b.id, method: 'CASH', businessDate: dia }, data: { cashSessionId: id } });
      const [p, v] = await Promise.all([
        tx.payment.aggregate({ where: { cashSessionId: id }, _sum: { amountCents: true } }),
        tx.posSale.aggregate({ where: { cashSessionId: id, status: 'COMPLETED' }, _sum: { totalCents: true } }),
      ]);
      const esperado = 100_000n + (p._sum.amountCents ?? 0n) + (v._sum.totalCents ?? 0n);
      const r = azar();
      const diferencia = r < 0.86 ? 0n : r < 0.96 ? -BigInt(entre(1, 25) * 1000) : BigInt(entre(1, 8) * 1000);
      await tx.cashSession.update({
        where: { id },
        data: {
          status: 'CLOSED', expectedCashCents: esperado, countedCashCents: esperado + diferencia, firstCountedCashCents: esperado + diferencia,
          countAttempts: 1, varianceCents: diferencia,
          varianceReason: diferencia === 0n ? null : diferencia < 0n ? uno(MOTIVOS_FALTA) : uno(MOTIVOS_SOBRA),
          closedByUserId: yo.id, closedAt: new Date(dia.getTime() + 28 * 3_600_000),
        },
      });
      void pagos;
      cortes++;
    }
    await tx.cashSession.update({ where: { id: hoyId }, data: { status: 'OPEN', countedCashCents: null, closedByUserId: null, closedAt: null } });
  }, { timeout: 120_000 });
}
console.log(`Cortes de caja de 90 días: ${cortes}`);

// ── Altas digitales esperando revisión ──────────────────────────────────────

for (let i = 0; i < 5; i++) {
  const p = persona();
  const b = uno([CEN, CEN, NOR, FRO]);
  await app.inject({
    method: 'POST', url: `/intake/${b.id}`,
    payload: {
      ...p,
      phone: telefono().replace('+52', ''),
      email: `${quitarAcentos(p.firstName.split(' ')[0]!).toLowerCase()}${entre(10, 99)}@correo.mx`,
      birthDate: iso(diasAtras(entre(19 * 365, 45 * 365))),
      emergencyContactName: `${uno(NOMBRES_F)} ${uno(APELLIDOS)}`,
      emergencyContactPhone: telefono().replace('+52', ''),
      memberSince: i < 3 ? iso(diasAtras(entre(200, 1600))) : null,
      healthNotes: i === 1 ? 'Lesión de rodilla derecha en recuperación' : null,
      consents: [
        { consentType: 'PRIVACY_NOTICE', version: vPriv, granted: true },
        { consentType: 'HOUSE_RULES', version: vReg, granted: true },
      ],
    },
  });
}
// Un duplicado evidente de un socio existente: la bandeja tiene que poder
// enseñar cómo lo detecta.
const gemelo = socios[3]!;
const [pila, ...resto] = gemelo.nombre.split(' ');
await app.inject({
  method: 'POST', url: `/intake/${gemelo.branchId}`,
  payload: {
    firstName: pila, lastName: resto.slice(-2).join(' '), phone: null, email: null,
    consents: [
      { consentType: 'PRIVACY_NOTICE', version: vPriv, granted: true },
      { consentType: 'HOUSE_RULES', version: vReg, granted: true },
    ],
  },
});
console.log('Altas digitales: 6 en la bandeja');

// ── Biometría ───────────────────────────────────────────────────────────────

let enrolados = 0;
const modalidad = new Map<string, 'FACE' | 'FINGERPRINT'>();
const enrolar = async (s: { id: string; branchId: string }, modality: 'FACE' | 'FINGERPRINT', branchId = s.branchId) => {
  const r = await app.inject({
    method: 'POST', url: `/members/${s.id}/biometric-enrollments`, headers: { cookie: owner },
    payload: {
      modality, branchId,
      templateRef: `demo-${crypto.randomUUID()}`,
      algorithmVendor: modality === 'FACE' ? 'insightface/buffalo_sc' : 'lector-sucursal',
      algorithmVersion: null,
      reason: 'Enrolamiento en mostrador',
    },
  });
  if (r.statusCode === 201) { enrolados++; modalidad.set(s.id, modality); }
  return r.statusCode === 201 ? (r.json().id as string) : null;
};

for (const s of socios.slice(0, Math.floor(socios.length * 0.4))) {
  await enrolar(s, ponderado([['FACE', 7], ['FINGERPRINT', 3]] as const));
}
// Alguien que entrena en dos sedes, con rostro en ambas.
await enrolar(socios[0]!, 'FACE', socios[0]!.branchId === NOR.id ? CEN.id : NOR.id);

// Tres revocaciones con historia: una ya vencida sin borrar, una en plazo y
// una cumplida. La API fecha todo "ahora"; se retroceden aquí.
const revocar = async (s: { id: string; branchId: string }, hace: number, borrada: boolean) => {
  const id = await enrolar(s, 'FINGERPRINT');
  if (!id) return;
  await call('POST', `/biometric-enrollments/${id}/revoke`, { reason: 'El socio retiró su consentimiento' });
  await db.biometricEnrollment.update({
    where: { id },
    data: { enrolledAt: diasAtras(hace + 120), revokedAt: diasAtras(hace), ...(borrada ? { templateDeletedAt: diasAtras(hace - 3) } : {}) },
  });
};
const sinBio = socios.slice(Math.floor(socios.length * 0.4));
await revocar(sinBio[0]!, 41, false);
await revocar(sinBio[1]!, 9, false);
await revocar(sinBio[2]!, 60, true);
console.log(`Biometría: ${enrolados} enrolamientos (3 revocados con historia)`);

// ── Historia de asistencia ──────────────────────────────────────────────────
// Las visitas nacen de una decisión de acceso, y el torniquete todavía no está
// en campo. Se escriben directo —decisión concedida + asistencia— con fechas
// de los últimos 75 días, para que el portal y la retención tengan historia.
// Quien no tiene biometría entra por recepción (MANUAL), que es la vía alterna.
const { ACCESS_POLICY_VERSION } = await import('@gymflow/core');
const sociosActivos = await db.member.findMany({
  where: { organizationId: org.id, status: 'ACTIVE' },
  select: { id: true, homeBranchId: true, joinedAt: true },
});
const decisiones: Array<Record<string, unknown>> = [];
const asistencias: Array<Record<string, unknown>> = [];
for (const s of sociosActivos) {
  // Hábito por persona: la mayoría va 2–4 veces por semana; algunos se están
  // yendo (dejaron de venir hace semanas), que es lo que la retención detecta.
  const porSemana = ponderado([[1, 2], [2, 4], [3, 5], [4, 3], [5, 1]] as const);
  const dejoDeVenir = azar() < 0.12 ? entre(18, 45) : 0;
  const desde = Math.min(75, Math.floor((hoy.getTime() - s.joinedAt.getTime()) / 86_400_000));
  for (let d = desde; d >= dejoDeVenir; d--) {
    if (azar() > porSemana / 7) continue;
    const at = diasAtras(d);
    at.setHours(ponderado([[6, 3], [7, 4], [8, 2], [13, 1], [18, 4], [19, 5], [20, 3]] as const), entre(0, 59), 0, 0);
    if (at > hoy) continue;
    const id = uuidv7();
    const kind = modalidad.get(s.id) ?? 'MANUAL';
    const fecha = new Date(`${iso(at)}T00:00:00.000Z`);
    decisiones.push({
      id, organizationId: org.id, branchId: s.homeBranchId, memberId: s.id,
      outcome: 'GRANTED', credentialKind: kind, policyVersion: ACCESS_POLICY_VERSION,
      at, businessDate: fecha,
      ...(kind === 'FACE' ? { matchScore: 0.62 + azar() * 0.3, matchMargin: 0.1 + azar() * 0.3, livenessMode: 'ACTIVE', livenessPassed: true } : {}),
    });
    asistencias.push({ id: uuidv7(), organizationId: org.id, branchId: s.homeBranchId, memberId: s.id, accessDecisionId: id, at, businessDate: fecha });
  }
}
for (let i = 0; i < decisiones.length; i += 1000) {
  await db.accessDecision.createMany({ data: decisiones.slice(i, i + 1000) as never });
  await db.attendanceEvent.createMany({ data: asistencias.slice(i, i + 1000) as never });
}
console.log(`Asistencia: ${asistencias.length} visitas en los últimos 75 días`);

// ── Prospectos en seguimiento ───────────────────────────────────────────────

const FUENTES_P = ['Pasó por aquí', 'Instagram', 'Facebook', 'Recomendación', 'Google', 'WhatsApp'];
const NOTAS_P = ['Busca horario nocturno', 'Le interesa spinning', 'Viene con su pareja', 'Preguntó por el anual', 'Quiere probar una semana', null];
let prospectos = 0;
for (let i = 0; i < 14; i++) {
  const p = persona();
  const b = uno([CEN, CEN, NOR, FRO]);
  const r = await app.inject({
    method: 'POST', url: '/prospects', headers: { cookie: owner },
    payload: { branchId: b.id, firstName: p.firstName, lastName: p.lastName, phoneE164: telefono(), source: uno(FUENTES_P), ...(uno(NOTAS_P) ? { notes: uno(NOTAS_P.filter(Boolean)) } : {}) },
  });
  if (r.statusCode !== 201) continue;
  prospectos++;
  const estado = ponderado([['NEW', 4], ['CONTACTED', 4], ['VISITED', 3], ['TRIAL', 2], ['LOST', 1]] as const);
  // La etapa sale de los contactos (auditoría 8, bloque 2.4): se siembra el contacto que la produce.
  const id = r.json().id;
  if (estado === 'CONTACTED') await call('POST', `/prospects/${id}/follow-ups`, { channel: 'CALL', outcome: 'INTERESTED' });
  if (estado === 'VISITED') await call('POST', `/prospects/${id}/follow-ups`, { channel: 'VISIT', outcome: 'INTERESTED' });
  if (estado === 'TRIAL') await call('POST', `/prospects/${id}/follow-ups`, { channel: 'VISIT', outcome: 'TRIAL_VISIT' });
  if (estado === 'LOST') await call('POST', `/prospects/${id}/close`, { reasonCode: uno(['PRECIO', 'HORARIO', 'LE_QUEDA_LEJOS']) });
}
console.log(`Prospectos: ${prospectos} en seguimiento`);

// ── Rutinas: las arma el coach y las ve el socio en su teléfono ────────────

const coach = await login('coach@demo.mx');
type Ej = { id: string; name: string };
const catalogoEj = (await call<{ exercises: Ej[] }>('GET', '/exercises', undefined, coach)).exercises;
const ej = (nombre: string) => {
  const e = catalogoEj.find((x) => x.name === nombre);
  if (!e) throw new Error(`Ejercicio no encontrado en el catálogo: ${nombre}`);
  return e.id;
};
const it = (nombre: string, sets: number, reps: string, restSeconds = 60, notes: string | null = null) => ({ exerciseId: ej(nombre), sets, reps, restSeconds, notes });
const RUTINAS = [
  {
    name: 'Principiante · cuerpo completo', goal: 'GENERAL', level: 'PRINCIPIANTE',
    notes: 'Calienta 10 minutos en caminadora. Cuando completes todas las repeticiones con buena técnica, sube un poco el peso.',
    days: [
      { name: 'Día A', items: [it('Sentadilla goblet', 3, '12'), it('Press de banca con mancuernas', 3, '12'), it('Jalón al pecho', 3, '12'), it('Elevaciones laterales', 2, '15', 45), it('Plancha', 3, '30 s', 45)] },
      { name: 'Día B', items: [it('Prensa de piernas', 3, '12'), it('Remo sentado en polea', 3, '12'), it('Press de hombro con mancuernas', 3, '10'), it('Curl martillo', 2, '12', 45), it('Crunch', 3, '15', 45)] },
      { name: 'Día C', items: [it('Puente de glúteo', 3, '15'), it('Lagartijas', 3, 'al fallo', 90), it('Remo con mancuerna a una mano', 3, '10'), it('Extensión en polea con cuerda', 2, '12', 45), it('Dead bug', 3, '10', 45)] },
    ],
  },
  {
    name: 'Hipertrofia · torso / pierna', goal: 'HIPERTROFIA', level: 'INTERMEDIO',
    notes: 'Cuatro días por semana: torso, pierna, descanso, torso, pierna.',
    days: [
      { name: 'Torso A', items: [it('Press de banca con barra', 4, '6-8', 120), it('Remo con barra', 4, '8', 120), it('Press inclinado con mancuernas', 3, '10', 90), it('Jalón al pecho', 3, '10', 90), it('Elevaciones laterales', 3, '15', 45), it('Curl con barra', 3, '10', 60), it('Press francés', 3, '10', 60)] },
      { name: 'Pierna A', items: [it('Sentadilla con barra', 4, '6-8', 150), it('Peso muerto rumano', 3, '8', 120), it('Prensa de piernas', 3, '12', 90), it('Curl femoral acostado', 3, '12', 60), it('Elevación de talones de pie', 4, '15', 45)] },
      { name: 'Torso B', items: [it('Press militar con barra', 4, '6-8', 120), it('Dominadas', 4, 'al fallo', 120), it('Cruce de poleas', 3, '12', 60), it('Remo sentado en polea', 3, '10', 90), it('Face pull', 3, '15', 45), it('Curl martillo', 3, '12', 60), it('Extensión en polea con cuerda', 3, '12', 60)] },
      { name: 'Pierna B', items: [it('Sentadilla búlgara', 3, '10', 90, 'Por pierna'), it('Hip thrust con barra', 4, '10', 90), it('Extensión de cuádriceps', 3, '15', 60), it('Zancadas caminando', 3, '12', 60, 'Pasos por pierna'), it('Rueda abdominal', 3, '10', 60)] },
    ],
  },
  {
    name: 'Glúteo y pierna', goal: 'HIPERTROFIA', level: 'INTERMEDIO', notes: null,
    days: [
      { name: 'Glúteo', items: [it('Hip thrust con barra', 4, '10', 90), it('Peso muerto sumo', 3, '8', 120), it('Patada de glúteo en polea', 3, '15', 45, 'Por pierna'), it('Abducción en máquina', 3, '20', 45), it('Caminata lateral con liga', 3, '20 pasos', 45)] },
      { name: 'Pierna', items: [it('Sentadilla hack', 4, '10', 120), it('Sentadilla búlgara', 3, '10', 90), it('Curl femoral acostado', 3, '12', 60), it('Extensión de cuádriceps', 3, '15', 60)] },
      { name: 'Core', items: [it('Plancha', 3, '45 s', 45), it('Plancha lateral', 3, '30 s', 45, 'Por lado'), it('Elevación de piernas colgado', 3, '12', 60), it('Giro ruso', 3, '20', 45)] },
    ],
  },
] as const;
const rutinasCreadas: string[] = [];
for (const r of RUTINAS) rutinasCreadas.push((await call<{ id: string }>('POST', '/routines', r, coach)).id);
const conRutina = socios.filter(() => azar() < 0.35);
// El coach ve solo a sus socios (2026-10-09): la gerencia se los asigna primero.
const coachId = (await call<{ userId: string }>('GET', '/auth/me', undefined, coach)).userId;
for (const sc of conRutina) await call('PUT', `/members/${sc.id}/coach`, { coachUserId: coachId });
for (const sc of conRutina) {
  await call('POST', `/members/${sc.id}/routine`, { routineId: uno(rutinasCreadas), notes: azar() < 0.3 ? 'Empieza con poco peso la primera semana' : null }, coach);
}
console.log(`Rutinas: ${rutinasCreadas.length} creadas, asignadas a ${conRutina.length} socios (los del coach)`);

await app.close();
await closeDb();
console.log('\nListo. Corre los jobs diarios para que los adeudos pasen a vencidos.');
