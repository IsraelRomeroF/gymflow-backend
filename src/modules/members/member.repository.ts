import {
  formatMemberCode, memberCodePrefix, normalizedNameKey, nameTokens, normalizeEmail, normalizePhoneMx,
  uuidv7, type IdentityCandidate, conflict } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import { cifrarSensible, descifrarSensible } from '../../platform/sensitive.js';
import { PrismaMemberStatus } from '@gymflow/db';

export type MemberRecord = {
  id: string;
  memberCode: string;
  firstName: string;
  lastName: string;
  phoneE164: string | null;
  email: string | null;
  birthDate: Date | null;
  status: string;
  homeBranchId: string | null;
  joinedAt: Date;
  balanceCentsCached: bigint;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  anonymizedAt?: Date | null;
};

export type CreateMemberInput = {
  firstName: string;
  lastName: string;
  phoneE164?: string | null;
  email?: string | null;
  birthDate?: Date | null;
  curp?: string | null;
  homeBranchId?: string | null;
  notes?: string | null;
  createdByUserId: string;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  /** Solo con consentimiento HEALTH_DATA: lo decide quien llama. */
  healthNotes?: string | null;
  /**
   * Antigüedad declarada (ADR-029). Si no viene, es hoy. Nunca en el futuro:
   * un "socio desde el mes que entra" no significa nada. Del mostrador llega
   * por `antiguedadDeclarada` (2-01): un día de calendario a las 18:00Z.
   */
  joinedAt?: Date | null;
  /**
   * El responsable del celular que comparte o su tutor (bloque 3.4, D-09 y
   * D-10), ya validado por `prepararResponsable` (`responsible.ts`).
   */
  responsibleColumns?: {
    responsibleKind: string | null; responsibleMemberId: string | null; responsibleName: string | null;
    responsiblePhoneE164: string | null; guardianSignedAt?: Date | null;
  } | undefined;
};

const SELECT = {
  id: true, memberCode: true, firstName: true, lastName: true,
  phoneE164: true, email: true, birthDate: true, status: true,
  homeBranchId: true, joinedAt: true, balanceCentsCached: true,
  emergencyContactName: true, emergencyContactPhone: true, anonymizedAt: true,
} as const;

export class MemberRepository extends TenantRepository {
  /** Nombre y código de muchos socios en UNA consulta (también dados de baja). */
  async namesByIds(ids: readonly string[]): Promise<Map<string, { fullName: string; memberCode: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.member.findMany({
      where: this.scope({ id: { in: [...new Set(ids)] } }),
      select: { id: true, firstName: true, lastName: true, memberCode: true },
    });
    return new Map(rows.map((m) => [m.id, { fullName: `${m.firstName} ${m.lastName}`, memberCode: m.memberCode }]));
  }

  /**
   * Búsqueda de recepción. Un solo campo resuelve nombre, código y teléfono,
   * porque el recepcionista no debe elegir "buscar por" con una cola detrás.
   *
   * La similitud por trigramas es lo que hace que "Martinz" encuentre a
   * "Martínez": el índice GIN la resuelve sin recorrer la tabla.
   */
  async search(query: string, limit = 20): Promise<Array<MemberRecord & { similarity: number }>> {
    const raw = query.trim();
    if (raw.length < 2) return [];

    const nameKey = normalizedNameKey(raw);
    const phone = normalizePhoneMx(raw);
    const digits = raw.replace(/\D/g, '');

    return this.db.$queryRaw<Array<MemberRecord & { similarity: number }>>`
      SELECT id, "memberCode", "firstName", "lastName", "phoneE164", email,
             "birthDate", status::text, "homeBranchId", "joinedAt", "balanceCentsCached",
             GREATEST(
               similarity("nameKey", ${nameKey}),
               -- word_similarity compara la consulta contra la MEJOR parte del
               -- nombre: sin esto, buscar un apellido suelto contra el nombre
               -- completo da una similitud baja y no encuentra nada.
               word_similarity(${nameKey}, "nameKey"),
               similarity("memberCode", ${raw.toUpperCase()}),
               CASE WHEN ${phone}::text IS NOT NULL AND "phoneE164" = ${phone} THEN 1.0 ELSE 0 END,
               CASE WHEN ${digits} <> '' AND "phoneE164" LIKE '%' || ${digits} THEN 0.95
                    WHEN length(${digits}) >= 4 AND "phoneE164" LIKE '%' || ${digits} || '%' THEN 0.9 ELSE 0 END,
               CASE WHEN EXISTS (SELECT 1 FROM member_legacy_codes lc
                                  WHERE lc."organizationId" = ${this.organizationId}::uuid AND lc."memberId" = members.id
                                    AND upper(lc.code) = ${raw.toUpperCase()}) THEN 1.0 ELSE 0 END
             )::float8 AS similarity
      FROM members
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "anonymizedAt" IS NULL
        AND (
          "nameKey" % ${nameKey}
          OR ${nameKey} <% "nameKey"
          OR "memberCode" ILIKE ${raw + '%'}
          OR (${phone}::text IS NOT NULL AND "phoneE164" = ${phone})
          -- Por dígitos: los últimos 4 que dicta la gente o el inicio del número ("55 31…").
          OR (${digits} <> '' AND length(${digits}) >= 4 AND "phoneE164" LIKE '%' || ${digits} || '%')
          -- El código del sistema anterior ("soy el 331") encuentra a su socio.
          OR EXISTS (SELECT 1 FROM member_legacy_codes lc
                      WHERE lc."organizationId" = ${this.organizationId}::uuid AND lc."memberId" = members.id
                        AND upper(lc.code) = ${raw.toUpperCase()})
        )
      ORDER BY similarity DESC, "lastName" ASC
      LIMIT ${limit}`;
  }

  /**
   * Busca INCLUYENDO archivados.
   *
   * El control de acceso necesita distinguir "credencial desconocida" de
   * "socio dado de baja": recepción no puede decir lo mismo en los dos casos.
   * `findById` filtra los archivados a propósito, así que hace falta esta
   * puerta explícita en vez de relajar aquella.
   */
  /**
   * Los socios de un coach (2026-10-09): los que tienen a ese coach asignado
   * en su ficha y, si no tienen coach asignado, aquellos a quienes él les
   * asignó la rutina vigente.
   */
  async assignedTo(coachUserId: string): Promise<string[]> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT m.id FROM members m
      WHERE m."organizationId" = ${this.organizationId}::uuid AND m."deletedAt" IS NULL AND m."anonymizedAt" IS NULL
        AND (m."coachUserId" = ${coachUserId}::uuid
          OR (m."coachUserId" IS NULL AND EXISTS (
            SELECT 1 FROM workout_assignments wa
            WHERE wa."organizationId" = m."organizationId" AND wa."memberId" = m.id AND wa."endedAt" IS NULL AND wa."assignedByUserId" = ${coachUserId}::uuid)))`;
    return rows.map((r) => r.id);
  }

  /** Asigna (o quita, con null) el coach del socio. */
  async setCoach(memberId: string, coachUserId: string | null): Promise<boolean> {
    const { count } = await this.db.member.updateMany({ where: this.scope({ id: memberId, deletedAt: null }), data: { coachUserId } });
    return count === 1;
  }

  /** Cuántos socios tienen a esta persona como coach en su ficha (bloque 2.6, 12-07). */
  async countCoachedBy(coachUserId: string): Promise<number> {
    return this.db.member.count({ where: this.scope({ coachUserId, deletedAt: null }) });
  }

  /** Al dar de baja a un coach: sus socios pasan a otro (o a nadie, con null). Devuelve cuántos. */
  async handOverCoach(fromUserId: string, toUserId: string | null): Promise<number> {
    const { count } = await this.db.member.updateMany({ where: this.scope({ coachUserId: fromUserId }), data: { coachUserId: toUserId } });
    return count;
  }

  async coachOf(memberId: string): Promise<string | null> {
    const m = await this.db.member.findFirst({ where: this.scope({ id: memberId }), select: { coachUserId: true } });
    return m?.coachUserId ?? null;
  }

  async findByIdIncludingArchived(id: string): Promise<MemberRecord | null> {
    const row = await this.db.member.findFirst({ where: this.scope({ id }), select: SELECT });
    return row as MemberRecord | null;
  }

  async findById(id: string): Promise<MemberRecord | null> {
    return this.db.member.findFirst({ where: this.scope({ id, deletedAt: null }), select: SELECT });
  }

  /**
   * Padrón paginado por cursor (apellido, nombre, id) y filtrado EN LA BASE.
   *
   * Antes se traían 200 y "solo con adeudo" filtraba en el navegador: con
   * más socios, la lista decía que nadie debía aunque sí (OPT-01).
   */
  async list(opts: {
    status?: string | undefined; branchId?: string | undefined; withDebt?: boolean | undefined;
    /** Solo socios de casa en estas sedes (`undefined` = todas). */
    branchIds?: readonly string[] | undefined;
    /** Solo estos socios (los de un coach); `undefined` = todos. */
    ids?: readonly string[] | undefined;
    q?: string | undefined; limit?: number | undefined;
    after?: { lastName: string; firstName: string; id: string } | undefined;
  } = {}): Promise<{ members: MemberRecord[]; total: number }> {
    const texto = opts.q?.trim() ?? '';
    const tokens = nameTokens(texto);
    const digitos = texto.replace(/\D/g, '');
    const where = this.scope({
      deletedAt: null,
      ...(opts.status ? { status: opts.status as PrismaMemberStatus } : {}),
      ...(opts.branchId ? { homeBranchId: opts.branchId } : opts.branchIds ? { homeBranchId: { in: [...opts.branchIds] } } : {}),
      ...(opts.withDebt ? { balanceCentsCached: { gt: 0n } } : {}),
      ...(opts.ids ? { id: { in: [...opts.ids] } } : {}),
      ...(texto ? {
        OR: [
          ...(tokens.length ? [{ AND: tokens.map((t) => ({ nameKey: { contains: t } })) }] : []),
          { memberCode: { contains: texto, mode: 'insensitive' as const } },
          ...(digitos.length >= 4 ? [{ phoneE164: { contains: digitos } }] : []),
        ],
      } : {}),
    });
    const a = opts.after;
    const [members, total] = await Promise.all([
      this.db.member.findMany({
        where: a ? {
          AND: [where, {
            OR: [
              { lastName: { gt: a.lastName } },
              { lastName: a.lastName, firstName: { gt: a.firstName } },
              { lastName: a.lastName, firstName: a.firstName, id: { gt: a.id } },
            ],
          }],
        } : where,
        select: SELECT,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        take: opts.limit ?? 50,
      }),
      this.db.member.count({ where }),
    ]);
    return { members, total };
  }

  /**
   * Candidatos para deduplicación en el alta.
   *
   * Se prefiltra en la base con los índices (teléfono, correo, trigram) y el
   * scoring fino lo hace el dominio: así la regla de fusión es la misma aquí
   * y en la migración de BDKGYM, y se puede probar sin base de datos.
   */
  async findDuplicateCandidates(input: {
    firstName: string; lastName: string;
    phoneE164?: string | null | undefined;
    email?: string | null | undefined;
    curp?: string | null | undefined;
  }): Promise<IdentityCandidate[]> {
    const nameKey = normalizedNameKey(`${input.firstName} ${input.lastName}`);
    const phone = normalizePhoneMx(input.phoneE164);
    const email = normalizeEmail(input.email);

    // También los dados de baja (PS-04): quien vuelve se reactiva con su
    // historia, no se da de alta otra vez. Los anonimizados ya no son nadie.
    // Las señales fuertes (celular, correo, CURP) van primero: con muchos
    // homónimos dados de baja, el tope de 25 no debe dejar fuera al que
    // comparte el teléfono.
    const rows = await this.db.$queryRaw<Array<{
      id: string; firstName: string; lastName: string;
      phoneE164: string | null; email: string | null; curp: string | null; birthDate: Date | null;
    }>>`
      SELECT id, "firstName", "lastName", "phoneE164", email, curp, "birthDate"
      FROM members
      WHERE "organizationId" = ${this.organizationId}::uuid
        AND "anonymizedAt" IS NULL
        AND (
          "nameKey" % ${nameKey}
          OR (${phone}::text IS NOT NULL AND "phoneE164" = ${phone})
          OR (${email}::text IS NOT NULL AND lower(email) = ${email})
          OR (${input.curp ?? null}::text IS NOT NULL AND curp = ${input.curp ?? null})
        )
      ORDER BY
        (${phone}::text IS NOT NULL AND "phoneE164" = ${phone}) DESC,
        (${email}::text IS NOT NULL AND lower(email) = ${email}) DESC,
        (${input.curp ?? null}::text IS NOT NULL AND curp = ${input.curp ?? null}) DESC,
        ("deletedAt" IS NULL) DESC,
        similarity("nameKey", ${nameKey}) DESC
      LIMIT 25`;

    return rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      phoneE164: r.phoneE164,
      email: r.email,
      curp: r.curp,
      birthDate: r.birthDate ? r.birthDate.toISOString().slice(0, 10) : null,
    }));
  }

  /**
   * Alta del socio. El código legible se reserva con un bloqueo de fila sobre
   * el contador: dos altas simultáneas en la misma sucursal no pueden recibir
   * el mismo número.
   */
  /**
   * Alta del socio, tolerante a que el contador de códigos esté por detrás
   * del padrón real. Ocurre siempre que alguien hace una carga masiva y
   * olvida ajustar el contador — y la migración de BDKGYM es exactamente
   * eso. En vez de fallar, el contador se adelanta hasta encontrar hueco.
   */
  async create(input: CreateMemberInput, branchCodeForNumbering: string): Promise<MemberRecord> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.insertWithCode(input, branchCodeForNumbering);
      } catch (error) {
        if (attempt === 4 || !isMemberCodeCollision(error)) throw error;
      }
    }
    throw new Error('No se pudo asignar un código de socio libre');
  }

  private async insertWithCode(input: CreateMemberInput, branchCodeForNumbering: string): Promise<MemberRecord> {
    const homeBranchId = input.homeBranchId ?? null;
    return this.db.$transaction(async (tx) => {
      let sequence = 1;
      if (homeBranchId) {
        /**
         * El contador va por PREFIJO, no por sucursal.
         *
         * El código es `PREFIJO-NNNNN` y su unicidad es `(organización,
         * código)`. Con el contador por sucursal, dos sedes que comparten las
         * tres primeras letras emitían ambas `POL-00001`, y archivar una sede
         * para reutilizar su prefijo reiniciaba el contador contra códigos ya
         * emitidos. El contador vive en el mismo espacio que la unicidad.
         *
         * Arranca en el máximo ya emitido para que una carga masiva previa no
         * provoque colisiones. Solo se consideran los códigos con el formato
         * propio (`PREFIJO-NNNNN`, hasta 6 dígitos): los códigos LEGADOS de
         * BDKGYM tendrán formatos arbitrarios, y uno solo con muchos dígitos
         * dispararía el contador a un número absurdo del que no se vuelve.
         */
        const prefix = memberCodePrefix(branchCodeForNumbering);
        const pattern = `^${prefix}-[0-9]{1,6}$`;
        const locked = await tx.$queryRaw<Array<{ lastSequence: number }>>`
          INSERT INTO member_code_counters ("organizationId", "prefix", "lastSequence", "updatedAt")
          VALUES (
            ${this.organizationId}::uuid,
            ${prefix},
            COALESCE((
              SELECT MAX(split_part("memberCode", '-', 2)::int)
              FROM members
              WHERE "organizationId" = ${this.organizationId}::uuid
                AND "memberCode" ~ ${pattern}
            ), 0) + 1,
            now()
          )
          ON CONFLICT ("organizationId", "prefix")
          DO UPDATE SET "lastSequence" = member_code_counters."lastSequence" + 1, "updatedAt" = now()
          RETURNING "lastSequence"`;
        sequence = locked[0]!.lastSequence;
      } else {
        const count = await tx.member.count({ where: { organizationId: this.organizationId } });
        sequence = count + 1;
      }

      const member = await tx.member.create({
        data: {
          id: uuidv7(),
          organizationId: this.organizationId,
          memberCode: formatMemberCode(branchCodeForNumbering, sequence),
          homeBranchId,
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          nameKey: normalizedNameKey(`${input.firstName} ${input.lastName}`),
          phoneE164: normalizePhoneMx(input.phoneE164),
          email: normalizeEmail(input.email),
          birthDate: input.birthDate ?? null,
          curp: input.curp?.toUpperCase() ?? null,
          notes: input.notes ?? null,
          emergencyContactName: input.emergencyContactName?.trim() || null,
          emergencyContactPhone: normalizePhoneMx(input.emergencyContactPhone ?? null),
          healthNotes: cifrarSensible(input.healthNotes),
          joinedAt: input.joinedAt && input.joinedAt.getTime() < Date.now() ? input.joinedAt : new Date(),
          createdByUserId: input.createdByUserId,
          ...(input.responsibleColumns ?? {}),
        },
        select: SELECT,
      });
      return member;
    });
  }

  async update(id: string, patch: Partial<CreateMemberInput>): Promise<MemberRecord | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const firstName = patch.firstName?.trim() ?? existing.firstName;
    const lastName = patch.lastName?.trim() ?? existing.lastName;

    // Acotado a la organización (antes actualizaba por id a secas).
    const { count } = await this.db.member.updateMany({
      where: this.scope({ id, deletedAt: null }),
      data: {
        firstName,
        lastName,
        nameKey: normalizedNameKey(`${firstName} ${lastName}`),
        ...(patch.phoneE164 !== undefined ? { phoneE164: normalizePhoneMx(patch.phoneE164) } : {}),
        ...(patch.email !== undefined ? { email: normalizeEmail(patch.email) } : {}),
        ...(patch.birthDate !== undefined ? { birthDate: patch.birthDate } : {}),
        ...(patch.homeBranchId !== undefined ? { homeBranchId: patch.homeBranchId } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.emergencyContactName !== undefined ? { emergencyContactName: patch.emergencyContactName } : {}),
        ...(patch.emergencyContactPhone !== undefined ? { emergencyContactPhone: normalizePhoneMx(patch.emergencyContactPhone) } : {}),
        // Corrección de antigüedad (2-01): la valida y la asienta con motivo quien llama.
        ...(patch.joinedAt ? { joinedAt: patch.joinedAt } : {}),
        // La nota de salud (2.4, 9-03): llega al vincular un alta digital y se borra al retirar su consentimiento.
        // Antes `update` la ignoraba: quien llamaba con `healthNotes` creía haberla escrito o borrado.
        ...(patch.healthNotes !== undefined ? { healthNotes: cifrarSensible(patch.healthNotes) } : {}),
      },
    });
    return count === 0 ? null : this.findById(id);
  }

  /** Baja LÓGICA: hay claves foráneas históricas (docs/05 §1.4). */
  /**
   * Saldo CACHEADO (ADR-005). Es caché de listado, no fuente de verdad: las
   * pantallas de decisión financiera leen el derivado real, y un job diario
   * reconcilia esta columna contra él.
   */
  /**
   * Fusión de una fila importada con un socio existente (docs/09 §4.4): solo
   * COMPLETA lo que falta, nunca pisa un dato que el gimnasio ya capturó, y
   * conserva la antigüedad más vieja. Devuelve qué campos completó.
   */
  async fillFromImport(id: string, f: {
    phoneE164: string | null; email: string | null; birthDate: Date | null; curp: string | null; joinedAt: Date | null;
  }): Promise<string[]> {
    const m = await this.db.member.findFirst({
      where: this.scope({ id, deletedAt: null }),
      select: { phoneE164: true, email: true, birthDate: true, curp: true, joinedAt: true },
    });
    if (!m) return [];
    const data: Record<string, unknown> = {};
    if (!m.phoneE164 && f.phoneE164 && !(await this.isPhoneTaken(f.phoneE164))) data.phoneE164 = f.phoneE164;
    if (!m.email && f.email) data.email = f.email;
    if (!m.birthDate && f.birthDate) data.birthDate = f.birthDate;
    if (!m.curp && f.curp) data.curp = f.curp;
    if (f.joinedAt && f.joinedAt < m.joinedAt) data.joinedAt = f.joinedAt;
    if (Object.keys(data).length === 0) return [];
    await this.db.member.updateMany({ where: this.scope({ id }), data });
    return Object.keys(data);
  }

  /**
   * ¿Otro socio vivo ya tiene este celular? Desde D-09 (bloque 3.4) dos socios
   * pueden compartirlo anotando al responsable (`responsible.ts`); la
   * importación sigue usando esta pregunta para no compartir a ciegas.
   */
  async isPhoneTaken(phoneE164: string): Promise<boolean> {
    return (await this.db.member.count({ where: this.scope({ phoneE164, deletedAt: null }) })) > 0;
  }

  async setCachedBalance(memberId: string, balanceCents: bigint): Promise<void> {
    await this.db.member.updateMany({
      where: this.scope({ id: memberId }),
      data: { balanceCentsCached: balanceCents, balanceComputedAt: new Date() },
    });
  }

  /**
   * Socios dados de baja desde una fecha.
   *
   * Alimenta el canal de REVOCACIONES del padrón: una baja tiene que llegar al
   * torniquete en segundos, sin esperar a la siguiente generación completa.
   */
  async archivedSince(since: Date): Promise<Array<{ id: string; at: Date }>> {
    const rows = await this.db.member.findMany({
      where: this.scope({ deletedAt: { gte: since } }),
      select: { id: true, deletedAt: true },
    });
    return rows.map((r) => ({ id: r.id, at: r.deletedAt! }));
  }

  /**
   * Dar de baja. En la MISMA transacción se cierran sus sesiones del portal y
   * se revocan sus credenciales (SEC-11): antes un socio dado de baja seguía
   * entrando a su portal hasta que la sesión caducara, 30 días después.
   *
   * El motivo va a la bitácora, no a `notes`: sobrescribirlas borraba lo que
   * recepción había anotado del socio (OPT-12).
   */
  async archive(id: string, userId: string, reason: string): Promise<boolean> {
    void userId; void reason;
    return this.db.$transaction(async (tx) => {
      const ahora = new Date();
      const { count } = await tx.member.updateMany({
        where: this.scope({ id, deletedAt: null }),
        data: { status: 'ARCHIVED', deletedAt: ahora, updatedAt: ahora },
      });
      if (count === 0) return false;
      await tx.memberSession.updateMany({
        where: { organizationId: this.organizationId, memberId: id, revokedAt: null },
        data: { revokedAt: ahora, revokedReason: 'member_archived' },
      });
      await tx.memberCredential.updateMany({
        where: { organizationId: this.organizationId, memberId: id, revokedAt: null },
        data: { revokedAt: ahora },
      });
      return true;
    });
  }

  /** Exsocios dados de baja antes de una fecha y aún con nombre: candidatos a anonimizar (PS-08). */
  async archivedBefore(before: Date, limit = 100): Promise<Array<{ id: string; firstName: string; lastName: string; memberCode: string; deletedAt: Date; homeBranchId: string | null }>> {
    const rows = await this.db.member.findMany({
      where: this.scope({ deletedAt: { lt: before }, anonymizedAt: null }),
      select: { id: true, firstName: true, lastName: true, memberCode: true, deletedAt: true, homeBranchId: true },
      orderBy: { deletedAt: 'asc' }, take: limit,
    });
    return rows.map((r) => ({ ...r, deletedAt: r.deletedAt! }));
  }

  /**
   * Volver a dar de alta a un exsocio (PS-04): recupera su código, su historia
   * y sus consentimientos; queda INACTIVE hasta que se le venda algo. Solo
   * sobre un dado de baja que no fue anonimizado.
   */
  async reactivate(id: string): Promise<boolean> {
    const ahora = new Date();
    try {
      const { count } = await this.db.member.updateMany({
        where: this.scope({ id, deletedAt: { not: null }, anonymizedAt: null }),
        data: { status: 'INACTIVE', deletedAt: null, updatedAt: ahora },
      });
      return count > 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('members_org_phone_active_key')) throw conflict('Su celular ya lo tiene otro socio activo: corrige ese teléfono antes de reactivarlo');
      if (msg.includes('members_org_code_active_key')) throw conflict('Su código de socio ya lo usa otra ficha activa');
      throw error;
    }
  }

  /**
   * ANONIMIZAR (ARCO, cancelación). Se borra a la PERSONA y se conserva el
   * movimiento: cargos, pagos y asistencias siguen ligados al id y al código
   * de socio, que ya no dicen quién es. Solo sobre un socio dado de baja y
   * una sola vez.
   */
  async anonymize(id: string): Promise<boolean> {
    const { count } = await this.db.member.updateMany({
      where: this.scope({ id, deletedAt: { not: null }, anonymizedAt: null }),
      data: {
        firstName: 'Socio', lastName: 'anonimizado', nameKey: '',
        phoneE164: null, email: null, birthDate: null, curp: null, photoObjectKey: null, notes: null,
        emergencyContactName: null, emergencyContactPhone: null, healthNotes: null,
        // El responsable o tutor es una persona con nombre y teléfono (bloque 3.4).
        responsibleKind: null, responsibleMemberId: null, responsibleName: null, responsiblePhoneE164: null, guardianSignedAt: null,
        anonymizedAt: new Date(), updatedAt: new Date(),
      },
    });
    return count > 0;
  }

  /** Notas de salud. Dato sensible: solo la ruta con `members:health:read`. */
  async healthNotes(id: string): Promise<string | null | undefined> {
    const row = await this.db.member.findFirst({ where: this.scope({ id, deletedAt: null }), select: { healthNotes: true } });
    return row ? descifrarSensible(row.healthNotes) : undefined;
  }
}

/** Colisión del código legible: el contador va por detrás del padrón. */
function isMemberCodeCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('members_org_code_active_key');
}
