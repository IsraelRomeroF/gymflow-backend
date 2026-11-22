import { looksLikeFolio, normalizedNameKey, normalizeEmail, normalizePhoneMx, uuidv7 } from '@gymflow/core';
import { PrismaMemberIntakeStatus } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { cifrarSensible, descifrarSensible } from '../../platform/sensitive.js';
import { Prisma } from '@gymflow/db';
import { armarCursor, cortarPagina, type PartesDelCursor } from '@gymflow/core/contracts';

const S = PrismaMemberIntakeStatus;

/** Marca de una alta cuyos datos personales ya se borraron. */
const ELIMINADO = '[eliminado]';
/** ¿Ya se borraron sus datos personales? La lista lo dice en vez de pintar «[eliminado] [eliminado]» (9-14). */
export const datosBorrados = (r: { firstName: string }): boolean => r.firstName === ELIMINADO;
const DATOS_BORRADOS = {
  firstName: ELIMINADO, lastName: ELIMINADO, nameKey: '', phoneE164: null, email: null, birthDate: null,
  emergencyContactName: null, emergencyContactPhone: null, healthNotes: null, ip: null, userAgent: null,
  // Lo corregido por recepción también son datos personales.
  corrections: Prisma.DbNull, correctedAt: null, correctedByUserId: null,
};

export type AcceptedConsentRow = {
  consentType: string;
  version: string;
  granted: boolean;
  documentId: string;
};

export type IntakeRecord = {
  id: string;
  branchId: string;
  status: 'SUBMITTED' | 'APPROVED' | 'REJECTED';
  firstName: string;
  lastName: string;
  phoneE164: string | null;
  email: string | null;
  birthDate: Date | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  memberSince: Date | null;
  healthNotes: string | null;
  acceptedConsents: AcceptedConsentRow[];
  ip: string | null;
  userAgent: string | null;
  submittedAt: Date;
  memberId: string | null;
  rejectionReason: string | null;
  /** Quién la aprobó o rechazó y cuándo; nulos mientras está por revisar o si caducó sola (9-14). */
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
  /**
   * Lo que recepción corrigió o completó y guardó sin aprobar (9-21): solo los
   * campos cambiados, como texto (`AAAA-MM-DD` las fechas); `null` = borró el dato.
   */
  corrections: Record<string, string | null> | null;
  correctedAt: Date | null;
  correctedByUserId: string | null;
};

/** Los datos del borrador que el socio puede volver a mandar. */
export type DatosDelBorrador = {
  firstName: string; lastName: string;
  phoneE164: string | null; email: string | null; birthDate: Date | null;
  emergencyContactName: string | null; emergencyContactPhone: string | null;
  memberSince: Date | null; healthNotes: string | null;
  acceptedConsents: readonly AcceptedConsentRow[];
  ip: string | null; userAgent: string | null;
};

const SELECT = {
  id: true, branchId: true, status: true, firstName: true, lastName: true,
  phoneE164: true, email: true, birthDate: true,
  emergencyContactName: true, emergencyContactPhone: true,
  memberSince: true, healthNotes: true, acceptedConsents: true,
  ip: true, userAgent: true, submittedAt: true, memberId: true, rejectionReason: true,
  reviewedAt: true, reviewedByUserId: true,
  corrections: true, correctedAt: true, correctedByUserId: true,
} as const;

const hydrate = (row: unknown): IntakeRecord => {
  const r = row as IntakeRecord & { acceptedConsents: unknown; corrections: unknown };
  return {
    ...r, healthNotes: descifrarSensible(r.healthNotes), acceptedConsents: (r.acceptedConsents as AcceptedConsentRow[]) ?? [],
    corrections: r.corrections && typeof r.corrections === 'object' ? r.corrections as Record<string, string | null> : null,
  };
};

export class IntakeRepository extends TenantRepository {
  async create(input: DatosDelBorrador & { branchId: string }): Promise<IntakeRecord> {
    const row = await this.db.memberIntake.create({
      data: {
        id: uuidv7(),
        organizationId: this.organizationId,
        branchId: input.branchId,
        firstName: input.firstName,
        lastName: input.lastName,
        nameKey: normalizedNameKey(`${input.firstName} ${input.lastName}`),
        phoneE164: input.phoneE164,
        email: input.email,
        birthDate: input.birthDate,
        emergencyContactName: input.emergencyContactName,
        emergencyContactPhone: input.emergencyContactPhone,
        memberSince: input.memberSince,
        healthNotes: cifrarSensible(input.healthNotes),
        acceptedConsents: input.acceptedConsents as Prisma.InputJsonValue,
        ip: input.ip,
        userAgent: input.userAgent,
      },
      select: SELECT,
    });
    return hydrate(row);
  }

  /**
   * El borrador SIN REVISAR de la misma persona en esa sede (9-18): mismo
   * celular (o, sin celular, mismo correo) Y mismo nombre. Quien «no está
   * seguro de si se envió» y manda otra vez actualiza ese; con otro nombre
   * (la hija con el celular de la mamá) nace otro.
   */
  async findPendingOfSamePerson(branchId: string, d: { firstName: string; lastName: string; phoneE164: string | null; email: string | null }): Promise<string | null> {
    const phone = normalizePhoneMx(d.phoneE164);
    const correo = normalizeEmail(d.email);
    if (!phone && !correo) return null;
    const row = await this.db.memberIntake.findFirst({
      where: this.scope({
        branchId, status: S.SUBMITTED, nameKey: normalizedNameKey(`${d.firstName} ${d.lastName}`),
        ...(phone ? { phoneE164: phone } : { email: { equals: correo!, mode: 'insensitive' as const } }),
      }),
      select: { id: true }, orderBy: { submittedAt: 'desc' },
    });
    return row?.id ?? null;
  }

  /**
   * El reenvío sustituye al borrador: lo último que la persona escribió y
   * firmó es lo que vale, con su hora. Lo que recepción había corregido
   * encima se descarta: corregía un envío que ya no es el vigente.
   */
  async resubmit(id: string, input: DatosDelBorrador): Promise<IntakeRecord | null> {
    const { count } = await this.db.memberIntake.updateMany({
      where: this.scope({ id, status: S.SUBMITTED }),
      data: {
        firstName: input.firstName, lastName: input.lastName, nameKey: normalizedNameKey(`${input.firstName} ${input.lastName}`),
        phoneE164: input.phoneE164, email: input.email, birthDate: input.birthDate,
        emergencyContactName: input.emergencyContactName, emergencyContactPhone: input.emergencyContactPhone,
        memberSince: input.memberSince, healthNotes: cifrarSensible(input.healthNotes),
        acceptedConsents: input.acceptedConsents as Prisma.InputJsonValue,
        ip: input.ip, userAgent: input.userAgent, submittedAt: new Date(),
        corrections: Prisma.DbNull, correctedAt: null, correctedByUserId: null,
      },
    });
    return count > 0 ? this.findById(id) : null;
  }

  // `branchIds` null = toda la organización; si no, solo esas sucursales.
  /**
   * Una página de la bandeja o del historial (9-14). La bandeja se atiende en
   * orden de llegada; el historial se consulta por lo reciente. Antes eran 50
   * (o 100) sin aviso: con 120 por revisar, la lista enseñaba 50.
   */
  async page(
    status: 'SUBMITTED' | 'APPROVED' | 'REJECTED', limit: number, cursor: PartesDelCursor | null,
    branchIds: readonly string[] | null = null,
    /** `q`: nombre, celular o el folio que dicta el socio (9-06). */
    opts: { q?: string | undefined } = {},
  ): Promise<{ items: IntakeRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const sube = status === 'SUBMITTED';
    const filtro = this.scope({ status: S[status], ...(branchIds ? { branchId: { in: [...branchIds] } } : {}), ...(await this.buscar(opts.q)) });
    const desde = cursor ? new Date(cursor.orden) : null;
    const despues = cursor && desde
      ? (sube
        ? { OR: [{ submittedAt: { gt: desde } }, { submittedAt: desde, id: { gt: cursor.id } }] }
        : { OR: [{ submittedAt: { lt: desde } }, { submittedAt: desde, id: { lt: cursor.id } }] })
      : null;
    const [filas, total] = await Promise.all([
      this.db.memberIntake.findMany({
        where: despues ? { AND: [filtro, despues] } : filtro,
        select: SELECT,
        orderBy: sube ? [{ submittedAt: 'asc' }, { id: 'asc' }] : [{ submittedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.db.memberIntake.count({ where: filtro }),
    ]);
    return { ...cortarPagina(filas.map(hydrate), limit, (u) => armarCursor(u.submittedAt.toISOString(), u.id)), total };
  }

  /** El buscador de la bandeja: nombre (palabra por palabra), celular (3 dígitos o más) o folio (los últimos 6 del id). */
  private async buscar(q: string | undefined): Promise<Prisma.MemberIntakeWhereInput> {
    const texto = q?.trim() ?? '';
    if (texto.length < 2) return {};
    const o: Prisma.MemberIntakeWhereInput[] = [];
    if (looksLikeFolio(texto)) {
      // El id es UUID: «termina en» no existe en Prisma para esa columna.
      const ids = await this.db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM member_intakes
         WHERE "organizationId" = ${this.organizationId}::uuid AND replace(id::text, '-', '') LIKE ${`%${texto.toLowerCase()}`}
         LIMIT 50`;
      if (ids.length > 0) o.push({ id: { in: ids.map((r) => r.id) } });
    }
    const digitos = texto.replace(/\D/g, '');
    // Solo si lo escrito parece un celular: de un folio como «1AF836» no se sacan sus dígitos
    // para buscar teléfonos (traía de más a quien tuviera «1836» en su número).
    if (digitos.length >= 3 && /^[\d\s()+.-]+$/.test(texto)) o.push({ phoneE164: { contains: digitos } });
    const palabras = normalizedNameKey(texto).split(' ').filter((t) => t.length >= 2);
    if (palabras.length > 0) o.push({ AND: palabras.map((t) => ({ nameKey: { contains: t } })) });
    return o.length > 0 ? { OR: o } : { id: { in: [] } };
  }

  /** Nombres de quienes revisaron: el historial dice quién, no un identificador. */
  async staffNames(ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
    const unicos = [...new Set(ids.filter((x): x is string => !!x))];
    if (unicos.length === 0) return new Map();
    const us = await this.db.user.findMany({ where: { id: { in: unicos }, organizationId: this.organizationId }, select: { id: true, fullName: true } });
    return new Map(us.map((u) => [u.id, u.fullName]));
  }

  async pendingCount(branchIds: readonly string[] | null = null): Promise<number> {
    return this.db.memberIntake.count({
      where: this.scope({ status: S.SUBMITTED, ...(branchIds ? { branchId: { in: [...branchIds] } } : {}) }),
    });
  }

  /**
   * RETENCIÓN (SEC-08). Una alta ya revisada cumplió su propósito: si se
   * aprobó, los datos viven en la ficha del socio; si se rechazó, no hay por
   * qué conservarlos. Se BORRAN los datos personales y queda el registro
   * vacío (fechas, estado, sede) para las estadísticas.
   */
  async scrubReviewedBefore(antes: Date): Promise<number> {
    const { count } = await this.db.memberIntake.updateMany({
      where: this.scope({ status: { not: S.SUBMITTED }, reviewedAt: { lt: antes }, firstName: { not: ELIMINADO } }),
      data: DATOS_BORRADOS,
    });
    return count;
  }

  /** Las altas digitales que dieron lugar a un socio que se anonimiza. */
  async scrubForMember(memberId: string): Promise<number> {
    const { count } = await this.db.memberIntake.updateMany({
      where: this.scope({ memberId }), data: DATOS_BORRADOS,
    });
    return count;
  }

  /** Altas que nadie revisó en meses: se cierran como rechazadas y se borran. */
  async expireUnreviewedBefore(antes: Date): Promise<number> {
    const { count } = await this.db.memberIntake.updateMany({
      where: this.scope({ status: S.SUBMITTED, submittedAt: { lt: antes } }),
      data: { ...DATOS_BORRADOS, status: S.REJECTED, reviewedAt: new Date(), rejectionReason: 'Caducó sin revisar' },
    });
    return count;
  }

  async findById(id: string): Promise<IntakeRecord | null> {
    const row = await this.db.memberIntake.findFirst({ where: this.scope({ id }), select: SELECT });
    return row ? hydrate(row) : null;
  }

  /**
   * TOMAR el alta para decidirla (9-20): bloquea su fila hasta que la unidad
   * de trabajo confirme y la devuelve como está EN ESE MOMENTO. Dos personas
   * aprobando a la vez pasaban las dos la lectura de estado y la segunda
   * creaba otra ficha antes de enterarse; ahora la segunda espera aquí y,
   * cuando le toca, ya la encuentra revisada. Solo dentro de `enUnaTransaccion`.
   */
  async claim(id: string): Promise<IntakeRecord | null> {
    const filas = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM member_intakes WHERE id = ${id}::uuid AND "organizationId" = ${this.organizationId}::uuid FOR UPDATE`;
    return filas.length > 0 ? this.findById(id) : null;
  }

  /** Guardar sin aprobar (9-21): `null` descarta lo guardado. Solo mientras está por revisar. */
  async saveCorrections(id: string, corrections: Record<string, string | null> | null, userId: string | null): Promise<boolean> {
    const hay = corrections !== null && Object.keys(corrections).length > 0;
    const { count } = await this.db.memberIntake.updateMany({
      where: this.scope({ id, status: S.SUBMITTED }),
      data: hay
        ? { corrections: corrections as Prisma.InputJsonValue, correctedAt: new Date(), correctedByUserId: userId }
        : { corrections: Prisma.DbNull, correctedAt: null, correctedByUserId: null },
    });
    return count > 0;
  }

  /**
   * Para las insignias de la bandeja (9-04), de una vez para toda la página:
   * a quién pertenece cada celular entre los socios (con su nombre, para
   * distinguir «posible duplicado» de «comparte celular») y qué celulares o
   * correos son de un interesado abierto. Solo lectura de tablas ajenas.
   */
  async contactosConocidos(phones: readonly string[], emails: readonly string[]): Promise<{
    socios: Array<{ phoneE164: string | null; email: string | null; nameKey: string }>;
    interesados: Array<{ phoneE164: string | null; email: string | null; nameKey: string }>;
  }> {
    if (phones.length === 0 && emails.length === 0) return { socios: [], interesados: [] };
    const o = [...(phones.length ? [{ phoneE164: { in: [...phones] } }] : []), ...(emails.length ? [{ email: { in: [...emails] } }] : [])];
    const select = { phoneE164: true, email: true, nameKey: true } as const;
    const [socios, interesados] = await Promise.all([
      this.db.member.findMany({ where: this.scope({ anonymizedAt: null, OR: o }), select, take: 500 }),
      this.db.prospect.findMany({ where: this.scope({ status: { notIn: ['CONVERTED' as const, 'LOST' as const] }, OR: o }), select, take: 500 }),
    ]);
    return { socios, interesados };
  }

  /** Los socios de los posibles duplicados, en UNA consulta (antes, una por coincidencia; 9-15). Solo lectura. */
  async sociosPorId(ids: readonly string[]): Promise<Map<string, { fullName: string; memberCode: string; phoneE164: string | null; status: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.member.findMany({
      where: this.scope({ id: { in: [...new Set(ids)] } }),
      select: { id: true, firstName: true, lastName: true, memberCode: true, phoneE164: true, status: true },
    });
    return new Map(rows.map((r) => [r.id, { fullName: `${r.firstName} ${r.lastName}`, memberCode: r.memberCode, phoneE164: r.phoneE164, status: r.status }]));
  }

  /** Aprobar es un `updateMany` con guarda de estado: aprobar dos veces no
   *  crea dos socios, porque el segundo intento no encuentra nada que cambiar. */
  async approve(id: string, memberId: string, userId: string | null): Promise<boolean> {
    const { count } = await this.db.memberIntake.updateMany({
      where: this.scope({ id, status: S.SUBMITTED }),
      data: { status: S.APPROVED, memberId, reviewedAt: new Date(), reviewedByUserId: userId },
    });
    return count > 0;
  }

  async reject(id: string, userId: string | null, reason: string): Promise<boolean> {
    const { count } = await this.db.memberIntake.updateMany({
      where: this.scope({ id, status: S.SUBMITTED }),
      data: { status: S.REJECTED, rejectionReason: reason, reviewedAt: new Date(), reviewedByUserId: userId },
    });
    return count > 0;
  }
}
