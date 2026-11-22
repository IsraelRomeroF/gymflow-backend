import { DEFAULT_PROSPECT_SOURCES, normalizedNameKey, normalizeEmail, normalizePhoneMx, uuidv7 } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import type { Prisma, PrismaProspectStatus } from '@gymflow/db';
import { armarCursor, cortarPagina, type PartesDelCursor } from '@gymflow/core/contracts';

export type ProspectRecord = {
  id: string;
  firstName: string;
  lastName: string;
  phoneE164: string | null;
  email: string | null;
  source: string | null;
  status: PrismaProspectStatus;
  branchId: string;
  assignedToUserId: string | null;
  convertedMemberId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Bandeja (bloque 2.4): último contacto, próximo paso y desde qué día toca. */
  lastContactAt: Date | null;
  nextStepOn: Date | null;
  dueOn: Date | null;
  referredByMemberId: string | null;
  referredByName: string | null;
  lostReasonCode: string | null;
  lostReason: string | null;
  closedAt: Date | null;
};

const SELECT = {
  id: true, firstName: true, lastName: true, phoneE164: true, email: true,
  source: true, status: true, branchId: true, assignedToUserId: true,
  convertedMemberId: true, createdAt: true, notes: true, updatedAt: true,
  lastContactAt: true, nextStepOn: true, dueOn: true, referredByMemberId: true, referredByName: true,
  lostReasonCode: true, lostReason: true, closedAt: true,
} as const;

/** Ya no están en seguimiento: se inscribió o se perdió. */
const CERRADOS: PrismaProspectStatus[] = ['CONVERTED', 'LOST'];
const ABIERTO: { status: { notIn: PrismaProspectStatus[] } } = { status: { notIn: CERRADOS } };

/** Los grupos de la bandeja y «Cerrados»: qué se pide con `?view=`. */
export type VistaDeInteresados = 'today' | 'uncontacted' | 'waiting' | 'closed';

/** El buscador de la lista: con tres dígitos o más busca el teléfono; con «@», el correo; y siempre el nombre, palabra por palabra. */
function buscar(q: string | undefined): Prisma.ProspectWhereInput {
  const texto = q?.trim() ?? '';
  if (texto.length < 2) return {};
  const digitos = texto.replace(/\D/g, '');
  const palabras = normalizedNameKey(texto).split(' ').filter((t) => t.length >= 2);
  const o: Prisma.ProspectWhereInput[] = [];
  if (digitos.length >= 3) o.push({ phoneE164: { contains: digitos } });
  if (texto.includes('@')) o.push({ email: { contains: texto.toLowerCase(), mode: 'insensitive' } });
  if (palabras.length > 0) o.push({ AND: palabras.map((t) => ({ nameKey: { contains: t } })) });
  // Nada buscable (solo signos): no devuelve todo como si hubiera coincidido.
  return o.length > 0 ? { OR: o } : { id: { in: [] } };
}

export type ProspectSummary = {
  id: string; firstName: string; lastName: string;
  status: string; branchId: string; createdAt: Date;
};

/** El filtro de cada grupo de la bandeja. `hoy`: el día del gimnasio. */
function deVista(vista: VistaDeInteresados, hoy: Date): Prisma.ProspectWhereInput {
  if (vista === 'closed') return { status: { in: [...CERRADOS] } };
  if (vista === 'uncontacted') return { ...ABIERTO, dueOn: null };
  if (vista === 'today') return { ...ABIERTO, dueOn: { lte: hoy } };
  return { ...ABIERTO, dueOn: { gt: hoy } };
}

export class ProspectRepository extends TenantRepository {
  /** Para la pantalla de Módulos: prospectos que siguen en seguimiento. */
  async openCount(): Promise<number> {
    return this.db.prospect.count({ where: this.scope(ABIERTO) });
  }

  /**
   * Una página de interesados (10-01, 10-16).
   *
   * Con `view`, un grupo de la bandeja, en el orden en que se atiende: «Te
   * toca hoy» y «Esperando» por la fecha en que tocan (lo más atrasado
   * arriba); «Sin contactar», del más viejo al más nuevo. Antes la API
   * mandaba del más reciente al más viejo y la pantalla reordenaba lo ya
   * cargado: con más de 50, uno que tocaba hoy podía quedar en la segunda
   * página. Sin `view` (y en «Cerrados»), del más reciente al más viejo.
   *
   * `counts` cuenta los cinco grupos con la misma sede y el mismo buscador.
   */
  async page(opts: {
    branchId?: string | undefined; branchIds?: readonly string[] | null | undefined;
    status?: string | undefined; open?: boolean | undefined; view?: VistaDeInteresados | undefined; q?: string | undefined;
    limit: number; cursor: PartesDelCursor | null; today: Date;
  }): Promise<{
    items: ProspectRecord[]; total: number; nextCursor: string | null; hasMore: boolean;
    counts: { open: number; closed: number; today: number; uncontacted: number; waiting: number };
  }> {
    // Sede y buscador valen para la lista y para los contadores.
    const base = this.scope({
      ...(opts.branchId ? { branchId: opts.branchId } : opts.branchIds ? { branchId: { in: [...opts.branchIds] } } : {}),
      ...buscar(opts.q),
    });
    const filtro: Prisma.ProspectWhereInput = {
      ...base,
      ...(opts.view ? deVista(opts.view, opts.today)
        : opts.status ? { status: opts.status as PrismaProspectStatus }
        : opts.open === true ? ABIERTO
        : opts.open === false ? { status: { in: [...CERRADOS] } } : {}),
    };

    // Cada orden con su cursor: la fecha en que toca, o la de registro.
    const porFechaEnQueToca = opts.view === 'today' || opts.view === 'waiting';
    const sube = porFechaEnQueToca || opts.view === 'uncontacted';
    const campo = porFechaEnQueToca ? 'dueOn' : 'createdAt';
    const desde = opts.cursor ? new Date(opts.cursor.orden) : null;
    const despues: Prisma.ProspectWhereInput | null = opts.cursor && desde
      ? { OR: [{ [campo]: sube ? { gt: desde } : { lt: desde } }, { [campo]: desde, id: sube ? { gt: opts.cursor.id } : { lt: opts.cursor.id } }] }
      : null;
    const orden = sube ? 'asc' : 'desc';

    const [filas, total, cerrados, hoy, sinContactar, esperando] = await Promise.all([
      this.db.prospect.findMany({
        where: despues ? { AND: [filtro, despues] } : filtro,
        select: SELECT,
        orderBy: [{ [campo]: orden }, { id: orden }],
        take: opts.limit + 1,
      }),
      this.db.prospect.count({ where: filtro }),
      this.db.prospect.count({ where: { ...base, ...deVista('closed', opts.today) } }),
      this.db.prospect.count({ where: { ...base, ...deVista('today', opts.today) } }),
      this.db.prospect.count({ where: { ...base, ...deVista('uncontacted', opts.today) } }),
      this.db.prospect.count({ where: { ...base, ...deVista('waiting', opts.today) } }),
    ]);
    return {
      ...cortarPagina(filas, opts.limit, (u) => armarCursor((porFechaEnQueToca ? u.dueOn! : u.createdAt).toISOString(), u.id)),
      total,
      counts: { open: hoy + sinContactar + esperando, closed: cerrados, today: hoy, uncontacted: sinContactar, waiting: esperando },
    };
  }

  /**
   * El pendiente del Inicio (10-08): cuántos tocan hoy, cuántos nadie ha
   * contactado y desde cuándo espera el más antiguo de todos ellos.
   */
  async pending(branchIds: readonly string[] | null, today: Date): Promise<{ today: number; uncontacted: number; oldest: Date | null }> {
    const base = this.scope(branchIds ? { branchId: { in: [...branchIds] } } : {});
    const [hoy, sinContactar, masViejo] = await Promise.all([
      this.db.prospect.count({ where: { ...base, ...deVista('today', today) } }),
      this.db.prospect.count({ where: { ...base, ...deVista('uncontacted', today) } }),
      this.db.prospect.findFirst({
        where: { ...base, ...ABIERTO, OR: [{ dueOn: null }, { dueOn: { lte: today } }] },
        select: { createdAt: true, lastContactAt: true }, orderBy: { updatedAt: 'asc' },
      }),
    ]);
    return { today: hoy, uncontacted: sinContactar, oldest: masViejo ? masViejo.lastContactAt ?? masViejo.createdAt : null };
  }

  async create(input: {
    branchId: string; firstName: string; lastName: string;
    phoneE164?: string | null | undefined; email?: string | null | undefined;
    source?: string | null | undefined; assignedToUserId?: string | null | undefined;
    notes?: string | null | undefined;
    /** «¿Qué sigue?» al registrarlo: con fecha cae en «Esperando» (o en «Te toca hoy»); sin ella, en «Sin contactar». */
    nextStepOn?: Date | null | undefined;
    referredByMemberId?: string | null | undefined; referredByName?: string | null | undefined;
  }): Promise<ProspectSummary> {
    return this.db.prospect.create({
      data: {
        id: uuidv7(),
        organizationId: this.organizationId,
        branchId: input.branchId,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        nameKey: normalizedNameKey(`${input.firstName} ${input.lastName}`),
        phoneE164: normalizePhoneMx(input.phoneE164),
        email: normalizeEmail(input.email),
        source: input.source ?? null,
        assignedToUserId: input.assignedToUserId ?? null,
        notes: input.notes ?? null,
        nextStepOn: input.nextStepOn ?? null,
        dueOn: input.nextStepOn ?? null,
        referredByMemberId: input.referredByMemberId ?? null,
        referredByName: input.referredByName?.trim() || null,
      },
      select: { id: true, firstName: true, lastName: true, status: true, branchId: true, createdAt: true },
    });
  }

  /**
   * Al convertir se liga al socio: así la conversión se mide, no se estima.
   * Vale también para uno cerrado como perdido que acabó inscribiéndose.
   */
  async markConverted(id: string, memberId: string): Promise<boolean> {
    const { count } = await this.db.prospect.updateMany({
      where: this.scope({ id, convertedMemberId: null }),
      data: {
        status: 'CONVERTED', convertedMemberId: memberId, convertedAt: new Date(), closedAt: new Date(),
        nextStepOn: null, dueOn: null, lostReasonCode: null, lostReason: null,
      },
    });
    return count > 0;
  }

  async findById(id: string): Promise<ProspectRecord | null> {
    return this.db.prospect.findFirst({ where: this.scope({ id }), select: SELECT });
  }

  /**
   * Los interesados ABIERTOS de todo el gimnasio con ese celular o ese correo
   * (10-07, R4): para no registrar dos veces a la misma persona y para
   * convertirla cuando se da de alta por otra puerta. Quién es la misma
   * persona lo decide el nombre, no el celular (mamá e hija lo comparten).
   */
  async findOpenByContact(phoneE164: string | null | undefined, email: string | null | undefined): Promise<Array<ProspectRecord & { nameKey: string }>> {
    const phone = normalizePhoneMx(phoneE164);
    const correo = normalizeEmail(email);
    if (!phone && !correo) return [];
    return this.db.prospect.findMany({
      where: this.scope({
        ...ABIERTO,
        OR: [...(phone ? [{ phoneE164: phone }] : []), ...(correo ? [{ email: { equals: correo, mode: 'insensitive' as const } }] : [])],
      }),
      select: { ...SELECT, nameKey: true }, orderBy: { createdAt: 'desc' }, take: 20,
    });
  }

  /** ARCO (PS-08): el prospecto que se convirtió en este socio también deja de decir quién era. */
  async anonymizeConverted(memberId: string): Promise<number> {
    const { count } = await this.db.prospect.updateMany({
      where: this.scope({ convertedMemberId: memberId }),
      data: { firstName: 'Prospecto', lastName: 'anonimizado', phoneE164: null, email: null, notes: null, referredByName: null, updatedAt: new Date() },
    });
    return count;
  }

  /**
   * Corregir lo capturado (nombre, contacto, fuente, nota): es la captura de
   * recepción, no la ficha de un socio. La etapa NO se cambia por aquí.
   */
  async update(id: string, patch: {
    firstName?: string; lastName?: string; phoneE164?: string | null; email?: string | null;
    source?: string | null; notes?: string | null; referredByMemberId?: string | null; referredByName?: string | null;
  }): Promise<boolean> {
    const actual = patch.firstName !== undefined || patch.lastName !== undefined
      ? await this.db.prospect.findFirst({ where: this.scope({ id }), select: { firstName: true, lastName: true } }) : null;
    const { count } = await this.db.prospect.updateMany({
      where: this.scope({ id, convertedMemberId: null }),
      data: {
        ...patch,
        ...(patch.firstName !== undefined ? { firstName: patch.firstName.trim() } : {}),
        ...(patch.lastName !== undefined ? { lastName: patch.lastName.trim() } : {}),
        ...(patch.phoneE164 !== undefined ? { phoneE164: normalizePhoneMx(patch.phoneE164) } : {}),
        ...(patch.email !== undefined ? { email: normalizeEmail(patch.email) } : {}),
        ...(actual ? { nameKey: normalizedNameKey(`${patch.firstName ?? actual.firstName} ${patch.lastName ?? actual.lastName}`) } : {}),
      },
    });
    return count > 0;
  }

  /** Tras un contacto: la etapa derivada, cuándo fue y desde cuándo vuelve a tocar. Solo si sigue abierto. */
  async afterContact(id: string, d: { status: 'NEW' | 'CONTACTED' | 'VISITED' | 'TRIAL'; lastContactAt: Date; nextStepOn: Date | null; dueOn: Date | null }): Promise<boolean> {
    const { count } = await this.db.prospect.updateMany({ where: this.scope({ id, ...ABIERTO }), data: d });
    return count > 0;
  }

  /** Cerrar sin inscripción, con su motivo. Solo uno abierto: cerrar dos veces no pisa el primer motivo. */
  async close(id: string, d: { reasonCode: string; reason: string; userId: string | null; lastContactAt?: Date }): Promise<boolean> {
    const { count } = await this.db.prospect.updateMany({
      where: this.scope({ id, ...ABIERTO }),
      data: {
        status: 'LOST', lostReasonCode: d.reasonCode, lostReason: d.reason, closedAt: new Date(), closedByUserId: d.userId,
        nextStepOn: null, dueOn: null, ...(d.lastContactAt ? { lastContactAt: d.lastContactAt } : {}),
      },
    });
    return count > 0;
  }

  /** Reabrir: vuelve con la etapa que le dan sus contactos (10-09) y toca desde `dueOn`. El motivo del cierre se queda en la bitácora. */
  async reopen(id: string, d: { status: 'NEW' | 'CONTACTED' | 'VISITED' | 'TRIAL'; dueOn: Date | null }): Promise<boolean> {
    const { count } = await this.db.prospect.updateMany({
      where: this.scope({ id, status: 'LOST' as const }),
      data: { status: d.status, lostReasonCode: null, lostReason: null, closedAt: null, closedByUserId: null, nextStepOn: null, dueOn: d.dueOn },
    });
    return count > 0;
  }

  // ── «¿Cómo se enteró?» ──────────────────────────────────────────────────

  /** La lista de la gerencia; sin filas, la de fábrica. */
  async sources(): Promise<{ sources: string[]; defaults: boolean }> {
    const filas = await this.db.prospectSource.findMany({ where: this.scope({}), select: { name: true }, orderBy: [{ position: 'asc' }, { name: 'asc' }] });
    return filas.length > 0 ? { sources: filas.map((f) => f.name), defaults: false } : { sources: [...DEFAULT_PROSPECT_SOURCES], defaults: true };
  }

  /** Sustituye la lista completa, en el orden dado. Los interesados ya registrados conservan la fuente que tenían (es texto). */
  async setSources(nombres: readonly string[]): Promise<void> {
    await this.db.$transaction([
      this.db.prospectSource.deleteMany({ where: this.scope({}) }),
      this.db.prospectSource.createMany({
        data: nombres.map((name, position) => ({ id: uuidv7(), organizationId: this.organizationId, name, position })),
      }),
    ]);
  }
}
