import { hash } from '@node-rs/argon2';
import { ALL_SECTIONS_UNLOCKED, normalizedNameKey, uuidv7, type RoleKey } from '@gymflow/core';
import { MODULES } from '@gymflow/core';
import { getDb } from '../src/platform/db/client.js';
import { ModuleStateRepository } from '../src/platform/modules/module-state.repository.js';
import { forgetModules } from '../src/platform/modules/module-state.js';
import { PASSWORD } from './helpers.js';

/**
 * EL GIMNASIO DEL REGISTRO DE RUTAS (bloque 1.17b).
 *
 * Un tercer gimnasio, aparte del «Gimnasio Demo» y de «Otro Gimnasio», que
 * solo usan las pruebas generadas desde el registro de rutas
 * (`rutas-registro.test.ts`). Tiene dos sedes y UN recurso de cada clase en
 * la segunda («la otra sede»), para preguntar tres cosas de cada ruta:
 *
 *  - aislamiento: alguien del Gimnasio Demo pide un recurso de este gimnasio;
 *  - alcance de sede: alguien de este gimnasio que solo trabaja en la primera
 *    sede pide un recurso de la segunda;
 *  - permiso: alguien de este gimnasio sin el permiso de la ruta la pide.
 *
 * Por qué un gimnasio aparte: las pruebas de dinero, tablero y jobs cuentan
 * lo que hay en el Gimnasio Demo; un cargo o un turno abierto de más ahí las
 * movería. Aquí nadie más mira.
 *
 * NO SE ACUMULA: se crea una vez por base y se reutiliza (los pagos y cargos
 * no se pueden borrar ni con el rol dueño, así que crear uno por corrida
 * llenaría la base). Los ids quedan en `organizations.settings`. Si cambia
 * lo que se siembra, se sube `VERSION` y nace un gimnasio nuevo; el viejo se
 * queda (declarado: un gimnasio por versión y por base).
 */
// v2 (2026-11-21): se agregaron `extras` y `mes`. Las bases que corrieron la suite a media
// tarde tienen un «Registro de Rutas v1» sin ellos: se queda ahí, sin usar.
const VERSION = 2;
const MARCA = `Registro de Rutas v${VERSION}`;

export type RecursoClase =
  | 'branch' | 'user' | 'member' | 'membership' | 'charge' | 'payment' | 'plan' | 'visitPack'
  | 'credential' | 'biometricEnrollment' | 'consent' | 'consentDocument'
  | 'cashRegister' | 'cashSession' | 'product' | 'posSale' | 'expense'
  | 'classType' | 'classTemplate' | 'classSchedule' | 'classBooking'
  | 'intake' | 'memberImport' | 'memberImportRow' | 'prospect'
  | 'approvalRequest' | 'privacyRequest' | 'routine' | 'accessGateway' | 'accessDecision'
  | 'paymentAttempt' | 'paymentMethod';

export type GimnasioDeRutas = {
  organizationId: string;
  /** La sede donde trabajan las cuentas de alcance corto. */
  sedeA: string;
  /** «La otra sede»: donde viven los recursos. */
  sedeB: string;
  /** Un recurso de cada clase, todos de la sede B. */
  ids: Record<RecursoClase, string>;
  /** Más cosas de la sede B que no tienen ruta propia (un seguimiento, un rostro revocado sin borrar): tampoco deben verse desde la sede A. */
  extras: string[];
  /** El mes (AAAA-MM) del gasto sembrado. */
  mes: string;
  /** Cuentas con alcance en todo el gimnasio, una por puesto. */
  porPuesto: Record<Exclude<RoleKey, 'SUPERADMIN'>, string>;
  /** Cuentas que solo trabajan en la sede A, una por puesto. */
  soloSedeA: Record<Exclude<RoleKey, 'SUPERADMIN'>, string>;
};

const PUESTOS = ['OWNER', 'MANAGER', 'RECEPTION', 'COACH'] as const;

type Db = Pick<ReturnType<typeof getDb>, 'role' | 'user' | 'roleAssignment'>;

async function cuenta(db: Db, organizationId: string, roleKey: string, branchId: string | null, email: string): Promise<string> {
  const role = await db.role.findFirstOrThrow({ where: { organizationId: null, key: roleKey } });
  const id = uuidv7();
  await db.user.create({
    data: {
      id, organizationId, email, fullName: `${roleKey} de rutas`,
      passwordHash: await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      // Con todas las secciones liberadas: lo que se prueba es el permiso del
      // puesto, no la llave (esa tiene sus pruebas en `llave-datos` y `unlock`).
      unlockedSections: [...ALL_SECTIONS_UNLOCKED],
    },
  });
  await db.roleAssignment.create({ data: { id: uuidv7(), organizationId, userId: id, roleId: role.id, branchId } });
  return id;
}

/** Todo lo opcional encendido: lo que se pregunta es el permiso, no si el módulo se usa. */
async function encenderTodo(organizationId: string): Promise<void> {
  const estado = new ModuleStateRepository(organizationId);
  const hoy = await estado.state();
  for (const m of MODULES) if (m.kind === 'optional' && hoy[m.key] !== true) await estado.set(m.key, true, null, null);
  forgetModules(organizationId);
}

export async function gimnasioDeRutas(): Promise<GimnasioDeRutas> {
  const g = await sembrar();
  await encenderTodo(g.organizationId);
  return g;
}

async function sembrar(): Promise<GimnasioDeRutas> {
  const ya = await getDb().organization.findFirst({ where: { tradeName: MARCA } });
  const guardado = (ya?.settings as { registroDeRutas?: GimnasioDeRutas } | null)?.registroDeRutas;
  if (guardado) return guardado;
  // Todo o nada: una siembra a medias dejaría un gimnasio que no se puede completar ni repetir.
  return getDb().$transaction((tx) => sembrarCon(tx as unknown as ReturnType<typeof getDb>), { timeout: 120_000, maxWait: 20_000 });
}

async function sembrarCon(db: ReturnType<typeof getDb>): Promise<GimnasioDeRutas> {
  const o = uuidv7();
  await db.organization.create({ data: { id: o, legalName: `${MARCA} S.A.`, tradeName: MARCA } });
  const sufijo = o.replace(/-/g, '').slice(-6);
  const hoy = new Date(new Date().toISOString().slice(0, 10));
  const en = (dias: number) => new Date(hoy.getTime() + dias * 86_400_000);

  // Los códigos de sede son únicos entre sedes activas de TODA la base por su
  // prefijo de socio: dos letras fijas más una por versión.
  const letra = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[VERSION % 26]!;
  const sedeA = uuidv7(); const sedeB = uuidv7();
  await db.branch.create({ data: { id: sedeA, organizationId: o, code: `Q${letra}A`, name: 'Sede A de rutas' } });
  await db.branch.create({ data: { id: sedeB, organizationId: o, code: `Q${letra}B`, name: 'Sede B de rutas' } });

  const correo = (puesto: string, alcance: string) => `rutas.${puesto.toLowerCase()}.${alcance}.v${VERSION}@rutas.mx`;
  const porPuesto = {} as GimnasioDeRutas['porPuesto'];
  const soloSedeA = {} as GimnasioDeRutas['soloSedeA'];
  let owner = '';
  for (const p of PUESTOS) {
    const id = await cuenta(db, o, p, null, correo(p, 'todo'));
    if (p === 'OWNER') owner = id;
    porPuesto[p] = correo(p, 'todo');
    await cuenta(db, o, p, sedeA, correo(p, 'sedea'));
    soloSedeA[p] = correo(p, 'sedea');
  }
  const userB = await cuenta(db, o, 'RECEPTION', sedeB, correo('RECEPTION', 'sedeb'));

  const ids = {} as Record<RecursoClase, string>;
  const nuevo = (clase: RecursoClase) => (ids[clase] = uuidv7());
  ids.branch = sedeB;
  ids.user = userB;

  await db.plan.create({ data: { id: nuevo('plan'), organizationId: o, code: 'RUTAS', name: 'Mensual de rutas', billingModel: 'RECURRING', durationUnit: 'MONTH', durationValue: 1, priceCents: 50_000n } });
  await db.planBranchAvailability.createMany({ data: [sedeA, sedeB].map((branchId) => ({ planId: ids.plan, branchId, organizationId: o })) });

  await db.member.create({ data: { id: nuevo('member'), organizationId: o, memberCode: `Q${letra}B-00001`, firstName: 'Socia', lastName: 'De Rutas', nameKey: normalizedNameKey('Socia De Rutas'), homeBranchId: sedeB, joinedAt: hoy } });
  const m = ids.member;
  await db.membership.create({ data: { id: nuevo('membership'), organizationId: o, memberId: m, planId: ids.plan, soldAtBranchId: sedeB, status: 'ACTIVE', startDate: hoy, currentPeriodStart: hoy, currentPeriodEnd: en(3650), billingAnchorDay: 1 } });
  await db.charge.create({ data: { id: nuevo('charge'), organizationId: o, memberId: m, branchId: sedeB, chargeType: 'MANUAL_ADJUSTMENT', concept: 'Cargo de rutas', subtotalCents: 10_000n, amountCents: 10_000n, dueDate: en(3650), issuedAt: hoy } });
  await db.payment.create({ data: { id: nuevo('payment'), organizationId: o, memberId: m, branchId: sedeB, method: 'SPEI_TRANSFER', status: 'SUCCEEDED', amountCents: 5_000n, unappliedCents: 5_000n, businessDate: hoy } });
  await db.visitPack.create({ data: { id: nuevo('visitPack'), organizationId: o, memberId: m, visitsPurchased: 10, purchasedOn: hoy } });
  await db.memberCredential.create({ data: { id: nuevo('credential'), organizationId: o, memberId: m, kind: 'RFID', rfidCardId: `rutas-${sufijo}` } });
  await db.memberConsent.create({ data: { id: nuevo('consent'), organizationId: o, memberId: m, consentType: 'BIOMETRIC', documentVersion: 'v1.0', granted: true, grantedAt: hoy } });
  await db.biometricEnrollment.create({ data: { id: nuevo('biometricEnrollment'), organizationId: o, memberId: m, modality: 'FACE', branchId: sedeB, templateRef: `rutas:${sufijo}`, algorithmVendor: 'prueba', consentId: ids.consent, enrolledByUserId: owner } });
  await db.consentDocument.create({ data: { id: nuevo('consentDocument'), organizationId: o, consentType: 'MARKETING', version: 'v-rutas', title: 'Texto de rutas', bodyText: 'Texto de prueba del registro de rutas' } });

  await db.cashRegister.create({ data: { id: nuevo('cashRegister'), organizationId: o, branchId: sedeB, code: 'R1', name: 'Caja de rutas' } });
  await db.cashSession.create({ data: { id: nuevo('cashSession'), organizationId: o, branchId: sedeB, cashRegisterId: ids.cashRegister, openedByUserId: owner, businessDate: hoy, openingFloatCents: 0n } });
  await db.product.create({ data: { id: nuevo('product'), organizationId: o, sku: 'RUTAS-1', name: 'Producto de rutas', priceCents: 2_500n } });
  await db.posSale.create({ data: { id: nuevo('posSale'), organizationId: o, branchId: sedeB, cashSessionId: ids.cashSession, totalCents: 2_500n, method: 'CASH', soldByUserId: owner, businessDate: hoy } });
  await db.operatingExpense.create({ data: { id: nuevo('expense'), organizationId: o, branchId: sedeB, category: 'OTHER', description: 'Gasto de rutas', amountCents: 1_000n, periodMonth: new Date(`${hoy.toISOString().slice(0, 7)}-01`), createdByUserId: owner } });

  await db.classType.create({ data: { id: nuevo('classType'), organizationId: o, name: 'Clase de rutas' } });
  await db.classTemplate.create({ data: { id: nuevo('classTemplate'), organizationId: o, branchId: sedeB, classTypeId: ids.classType, effectiveFrom: hoy } });
  await db.classSchedule.create({ data: { id: nuevo('classSchedule'), organizationId: o, branchId: sedeB, classTypeId: ids.classType, occurrenceKey: `rutas:${sufijo}`, startsAt: en(3650), endsAt: new Date(en(3650).getTime() + 3_600_000), businessDate: en(3650), capacity: 10 } });
  await db.classBooking.create({ data: { id: nuevo('classBooking'), organizationId: o, branchId: sedeB, classScheduleId: ids.classSchedule, memberId: m } });

  await db.memberIntake.create({ data: { id: nuevo('intake'), organizationId: o, branchId: sedeB, firstName: 'Alta', lastName: 'De Rutas', nameKey: normalizedNameKey('Alta De Rutas'), acceptedConsents: [] } });
  await db.memberImport.create({ data: { id: nuevo('memberImport'), organizationId: o, branchId: sedeB, fileName: 'rutas.csv', cutoffDate: hoy, totalRows: 1, createdByUserId: owner } });
  await db.memberImportRow.create({ data: { id: nuevo('memberImportRow'), organizationId: o, importId: ids.memberImport, rowNumber: 1, raw: {}, firstName: 'Fila', lastName: 'De Rutas', kind: 'NEW', decision: 'CREATE' } });
  await db.prospect.create({ data: { id: nuevo('prospect'), organizationId: o, branchId: sedeB, firstName: 'Prospecto', lastName: 'De Rutas', nameKey: normalizedNameKey('Prospecto De Rutas') } });

  await db.approvalRequest.create({ data: { id: nuevo('approvalRequest'), organizationId: o, requestedByUserId: userB, permission: 'payments:refund', branchId: sedeB, resourceId: ids.payment, summary: 'Firma de rutas', expiresAt: en(3650) } });
  await db.privacyRequest.create({ data: { id: nuevo('privacyRequest'), organizationId: o, memberId: m, kind: 'ACCESS', channel: 'EMAIL', dueAt: en(3650) } });
  await db.workoutTemplate.create({ data: { id: nuevo('routine'), organizationId: o, name: 'Rutina de rutas', dayNames: ['Día 1'], createdByUserId: owner } });
  await db.accessGateway.create({ data: { id: nuevo('accessGateway'), organizationId: o, branchId: sedeB, code: 'GW-R', name: 'Torniquete de rutas' } });
  await db.accessDecision.create({ data: { id: nuevo('accessDecision'), organizationId: o, branchId: sedeB, memberId: m, outcome: 'DENIED', denialReason: 'NO_ACTIVE_MEMBERSHIP', credentialKind: 'QR', policyVersion: 'rutas', businessDate: hoy } });
  await db.paymentMethod.create({ data: { id: nuevo('paymentMethod'), organizationId: o, memberId: m, provider: 'sandbox', providerTokenRef: `tok_rutas_${sufijo}` } });
  await db.paymentAttempt.create({ data: { id: nuevo('paymentAttempt'), organizationId: o, memberId: m, attemptNumber: 1, idempotencyKey: `rutas_${sufijo}` } });

  // Para que las lecturas por sede tengan algo que NO enseñar: un seguimiento, un rostro
  // revocado con la plantilla sin borrar y un texto biométrico más nuevo que el que firmó.
  const extras = [uuidv7(), uuidv7()];
  await db.followUp.create({ data: { id: extras[0]!, organizationId: o, branchId: sedeB, memberId: m, channel: 'CALL', outcome: 'ANSWERED', createdByUserId: owner } });
  await db.biometricEnrollment.create({ data: { id: extras[1]!, organizationId: o, memberId: m, modality: 'FINGERPRINT', branchId: sedeB, templateRef: `rutas-revocado:${sufijo}`, algorithmVendor: 'prueba', consentId: ids.consent, enrolledByUserId: owner, revokedAt: new Date(), revokedReason: 'Prueba del registro de rutas' } });
  await db.consentDocument.create({ data: { id: uuidv7(), organizationId: o, consentType: 'BIOMETRIC', version: 'v2-rutas', status: 'PUBLISHED', publishedAt: new Date(), title: 'Biométrico de rutas', bodyText: 'Texto biométrico de prueba del registro de rutas' } });

  const gimnasio: GimnasioDeRutas = { organizationId: o, sedeA, sedeB, ids, extras, mes: hoy.toISOString().slice(0, 7), porPuesto, soloSedeA };
  await db.organization.update({ where: { id: o }, data: { settings: { registroDeRutas: gimnasio } } });
  return gimnasio;
}
