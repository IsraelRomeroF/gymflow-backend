import { APPROVAL_FAILURE_LADDER, APPROVAL_PANEL_ACTIVE_MS, isApprovalRequestStatus, monthOfMonthlyCloseResourceId, uuidv7, type ApprovalReach, type ApprovalRequestStatus } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/** A qué quedó atada una firma: quién la dio, la sede, el recurso y el importe. */
export type ApprovalGrantRecord = {
  id: string;
  approverUserId: string;
  branchId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  amountCents: bigint | null;
};

/**
 * Firmas de un solo uso (`approval_grants`).
 *
 * Usa el cliente de la unidad de trabajo en curso: si la operación que
 * consumió la firma se deshace, la firma vuelve a estar disponible en vez de
 * quedar gastada sin que nada se haya hecho (EST-02).
 */
export class ApprovalGrantRepository extends TenantRepository {
  async create(input: {
    approverUserId: string; requestedByUserId: string; permission: string; tokenHash: string;
    branchId: string | null; resourceType: string | null; resourceId: string | null;
    amountCents: bigint | null; expiresAt: Date;
  }): Promise<{ id: string }> {
    const id = uuidv7();
    await this.db.approvalGrant.create({ data: { id, organizationId: this.organizationId, ...input } });
    return { id };
  }

  /**
   * Consumo atómico: un solo uso aunque lleguen dos peticiones a la vez.
   * Devuelve null si no existe, expiró, ya se usó o es de otra persona u
   * otro permiso.
   */
  async consume(tokenHash: string, requestedByUserId: string, permission: string): Promise<ApprovalGrantRecord | null> {
    const { count } = await this.db.approvalGrant.updateMany({
      where: this.scope({ tokenHash, requestedByUserId, permission, usedAt: null, expiresAt: { gt: new Date() } }),
      data: { usedAt: new Date() },
    });
    if (count === 0) return null;
    return this.db.approvalGrant.findFirstOrThrow({
      where: this.scope({ tokenHash }),
      select: { id: true, approverUserId: true, branchId: true, resourceType: true, resourceId: true, amountCents: true },
    });
  }

  /** Si la firma sigue sirviendo: ni usada ni vencida (29-03). */
  /**
   * Devuelve una firma consumida cuya operación NO se registró: vuelve a
   * quedar lista mientras no venza. Sin esto la bandeja decía «la operación
   * se registró con esa firma» de un retiro que la caja rechazó (2.14, D1).
   */
  async release(id: string): Promise<void> {
    await this.db.approvalGrant.updateMany({ where: this.scope({ id, usedAt: { not: null }, expiresAt: { gt: new Date() } }), data: { usedAt: null } });
  }

  state(id: string): Promise<{ usedAt: Date | null; expiresAt: Date } | null> {
    return this.db.approvalGrant.findFirst({ where: this.scope({ id }), select: { usedAt: true, expiresAt: true } });
  }

  /** ¿Alguien firmó ESTA operación después de `desde`? Un «sí» posterior deja sin efecto el «no» (D-03). */
  async signedSince(permission: string, resourceId: string, desde: Date): Promise<boolean> {
    const f = await this.db.approvalGrant.findFirst({ where: this.scope({ permission, resourceId, createdAt: { gt: desde } }), select: { id: true } });
    return f !== null;
  }
}

export type Solicitud = {
  id: string; permission: string; branchId: string | null; resourceType: string | null; resourceId: string | null;
  amountCents: bigint | null; summary: string; reason: string | null; status: ApprovalRequestStatus; requestedByUserId: string; approverUserId: string | null;
  decidedAt: Date | null; rejectReason: string | null; expiresAt: Date; createdAt: Date;
  /** La firma que emitió al aprobarse (29-03); null si no se aprobó o es anterior a este campo. */
  grantId: string | null;
  /** A cuántos teléfonos salió el aviso al pedirla (29-05). */
  notifiedCount: number;
  /** La primera vez que la bandeja de alguien que puede firmarla la mostró (29-05). */
  seenAt: Date | null;
  /** D-03: la solicitud rechazada de la misma operación a la que esta responde, y la respuesta. */
  previousRequestId: string | null;
  reply: string | null;
  /** D-03: quien firma preguntó en vez de rechazar; la solicitud sigue pendiente. */
  question: string | null; questionAt: Date | null; questionByUserId: string | null;
  answer: string | null; answeredAt: Date | null;
};

/** El «no» de una operación: quién, cuándo y por qué. */
export type RechazoPrevio = { id: string; decidedAt: Date; approverUserId: string | null; rejectReason: string | null };

const SELECT = {
  id: true, permission: true, branchId: true, resourceType: true, resourceId: true, amountCents: true, summary: true, reason: true,
  status: true, requestedByUserId: true, approverUserId: true, decidedAt: true, rejectReason: true, expiresAt: true, createdAt: true,
  grantId: true, notifiedCount: true, seenAt: true,
  previousRequestId: true, reply: true, question: true, questionAt: true, questionByUserId: true, answer: true, answeredAt: true,
} as const;

/** La base solo admite los cinco estados (CHECK); aquí se dice con el tipo cerrado del núcleo. */
function fila<T extends { status: string }>(r: T): Omit<T, 'status'> & { status: ApprovalRequestStatus } {
  if (!isApprovalRequestStatus(r.status)) throw new Error(`Estado de solicitud desconocido: ${r.status}`);
  return { ...r, status: r.status };
}

const nombreDelMes = (mes: string) => new Date(`${mes}-15T12:00:00Z`).toLocaleDateString('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Solicitudes de firma a distancia (`approval_requests`). */
export class ApprovalRequestRepository extends TenantRepository {
  async create(input: {
    requestedByUserId: string; permission: string; branchId: string | null; resourceType: string | null; resourceId: string | null;
    amountCents: bigint | null; summary: string; reason: string | null; expiresAt: Date;
    previousRequestId?: string | null; reply?: string | null;
  }): Promise<Solicitud> {
    return fila(await this.db.approvalRequest.create({
      data: { id: uuidv7(), organizationId: this.organizationId, ...input },
      select: SELECT,
    }));
  }

  async find(id: string): Promise<Solicitud | null> {
    const r = await this.db.approvalRequest.findFirst({ where: this.scope({ id }), select: SELECT });
    return r ? fila(r) : null;
  }

  /** Las que siguen pendientes y vigentes, salvo las que pidió esta persona. */
  async pendingNotRequestedBy(userId: string): Promise<Solicitud[]> {
    const rows = await this.db.approvalRequest.findMany({
      where: this.scope({ status: 'PENDING', expiresAt: { gt: new Date() }, requestedByUserId: { not: userId } }),
      select: SELECT, orderBy: { createdAt: 'asc' }, take: 50,
    });
    return rows.map(fila);
  }

  /**
   * «Resueltas hoy» (20-05): las que dejaron de estar pendientes desde `desde`,
   * la más reciente primero. Una vencida no tiene decisión: cuenta su
   * vencimiento. Con `pedidasPor`, solo las de esa persona.
   */
  async resolvedSince(desde: Date, opts: { pedidasPor?: string | undefined; limit?: number } = {}): Promise<Solicitud[]> {
    const rows = await this.db.approvalRequest.findMany({
      where: this.scope({
        ...(opts.pedidasPor ? { requestedByUserId: opts.pedidasPor } : {}),
        OR: [
          { status: { in: ['APPROVED', 'REJECTED', 'CANCELED'] }, decidedAt: { gte: desde } },
          { status: 'EXPIRED', expiresAt: { gte: desde } },
        ],
      }),
      select: SELECT, orderBy: { createdAt: 'desc' }, take: opts.limit ?? 100,
    });
    return rows.map(fila);
  }

  /**
   * EL «NO» VIGENTE DE UNA OPERACIÓN (D-03): el último rechazo del mismo
   * permiso sobre el mismo registro desde `desde`, lo haya pedido quien lo
   * haya pedido. Si después de ese «no» la operación se autorizó a distancia,
   * ya no está vigente (la firma en el mostrador la mira quien llama).
   */
  async lastRejection(permission: string, resourceId: string, desde: Date): Promise<RechazoPrevio | null> {
    const r = await this.db.approvalRequest.findFirst({
      where: this.scope({ permission, resourceId, status: 'REJECTED', decidedAt: { gte: desde } }),
      select: { id: true, decidedAt: true, approverUserId: true, rejectReason: true }, orderBy: { decidedAt: 'desc' },
    });
    if (!r?.decidedAt) return null;
    const despues = await this.db.approvalRequest.findFirst({
      where: this.scope({ permission, resourceId, status: 'APPROVED', decidedAt: { gt: r.decidedAt } }), select: { id: true },
    });
    return despues ? null : { id: r.id, decidedAt: r.decidedAt, approverUserId: r.approverUserId, rejectReason: r.rejectReason };
  }

  /**
   * Cuántas veces se pidió la operación desde `desde` (D-03: 3 por hora) y
   * cuándo fue la más antigua de esas, para decir a qué hora se puede volver
   * a pedir. Las autorizadas no cuentan: esa operación ya se hizo o se pudo
   * hacer, y la siguiente del mismo registro es otra. `hasta`: solo las
   * creadas hasta ese instante (para decir «2.ª vez» de una ya existente).
   */
  async requestedSince(permission: string, resourceId: string, desde: Date, hasta?: Date): Promise<{ n: number; primera: Date | null }> {
    const filas = await this.db.approvalRequest.findMany({
      where: this.scope({ permission, resourceId, status: { not: 'APPROVED' }, createdAt: { gt: desde, ...(hasta ? { lte: hasta } : {}) } }),
      select: { createdAt: true }, orderBy: { createdAt: 'asc' }, take: 50,
    });
    return { n: filas.length, primera: filas[0]?.createdAt ?? null };
  }

  /** Los rechazos a los que responden estas solicitudes, por id. */
  async rejectionsById(ids: readonly string[]): Promise<Map<string, RechazoPrevio>> {
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return new Map();
    const filas = await this.db.approvalRequest.findMany({
      where: this.scope({ id: { in: unicos }, status: 'REJECTED' }), select: { id: true, decidedAt: true, approverUserId: true, rejectReason: true },
    });
    return new Map(filas.flatMap((f) => (f.decidedAt ? [[f.id, { id: f.id, decidedAt: f.decidedAt, approverUserId: f.approverUserId, rejectReason: f.rejectReason }] as const] : [])));
  }

  /**
   * «PREGUNTAR» en vez de rechazar (D-03): la solicitud sigue pendiente, con
   * la pregunta puesta y su reloj de nuevo completo. Solo si sigue pendiente y
   * no tiene otra pregunta sin contestar. Preguntar es haberla visto.
   */
  async ask(id: string, data: { question: string; byUserId: string; expiresAt: Date }, ahora = new Date()): Promise<boolean> {
    const { count } = await this.db.approvalRequest.updateMany({
      where: this.scope({ id, status: 'PENDING', expiresAt: { gt: ahora }, OR: [{ question: null }, { answer: { not: null } }] }),
      data: { question: data.question, questionAt: ahora, questionByUserId: data.byUserId, answer: null, answeredAt: null, expiresAt: data.expiresAt },
    });
    if (count > 0) await this.markSeen([id], ahora);
    return count > 0;
  }

  /** Quien pidió contesta la pregunta: el reloj vuelve a empezar para que quien firma alcance a leerla. */
  async answer(id: string, data: { answer: string; expiresAt: Date }, ahora = new Date()): Promise<boolean> {
    const { count } = await this.db.approvalRequest.updateMany({
      where: this.scope({ id, status: 'PENDING', expiresAt: { gt: ahora }, question: { not: null }, answer: null }),
      data: { answer: data.answer, answeredAt: ahora, expiresAt: data.expiresAt },
    });
    return count > 0;
  }

  /** El aviso salió a `n` teléfonos (29-05). Con 0 no se escribe nada: «no salió» es el valor de origen. */
  async markNotified(id: string, n: number): Promise<void> {
    if (n <= 0) return;
    await this.db.approvalRequest.updateMany({ where: this.scope({ id }), data: { notifiedCount: n, deliveredAt: new Date() } });
  }

  /** La bandeja de alguien que puede firmarlas las mostró: se anota la PRIMERA vez (29-05). */
  async markSeen(ids: readonly string[], ahora = new Date()): Promise<void> {
    if (ids.length === 0) return;
    await this.db.approvalRequest.updateMany({ where: this.scope({ id: { in: [...ids] }, seenAt: null }), data: { seenAt: ahora } });
  }

  /** Las que vencieron sin que nadie las volviera a leer: se cierran y se asientan (29-04). */
  async pendingExpired(limit = 50): Promise<Solicitud[]> {
    const rows = await this.db.approvalRequest.findMany({
      where: this.scope({ status: 'PENDING', expiresAt: { lte: new Date() } }),
      select: SELECT, orderBy: { expiresAt: 'asc' }, take: limit,
    });
    return rows.map(fila);
  }

  /**
   * Cierra una solicitud SOLO si sigue pendiente. Devuelve false si alguien
   * más la contestó antes.
   */
  async decide(id: string, data: {
    status: 'APPROVED' | 'REJECTED' | 'CANCELED' | 'EXPIRED';
    approverUserId?: string; rejectReason?: string; deliveryToken?: string | null; grantId?: string;
  }): Promise<boolean> {
    const { status, ...resto } = data;
    const { count } = await this.db.approvalRequest.updateMany({
      where: this.scope({ id, status: 'PENDING' }),
      data: { status, ...resto, ...(status === 'EXPIRED' ? {} : { decidedAt: new Date() }) },
    });
    return count > 0;
  }

  /**
   * Las aprobadas antes de que la solicitud recordara su firma (sin `grantId`)
   * entregan el token UNA vez, como antes: se lee y se borra en una sola
   * sentencia para que dos lecturas a la vez no lo reciban las dos.
   */
  async takeDeliveryToken(id: string): Promise<string | null> {
    const filas = await this.db.$queryRaw<Array<{ token: string | null }>>`
      WITH previo AS (
        SELECT "deliveryToken" AS token FROM "approval_requests"
         WHERE "id" = ${id}::uuid AND "organizationId" = ${this.organizationId}::uuid AND "deliveryToken" IS NOT NULL
         FOR UPDATE
      )
      UPDATE "approval_requests" r SET "deliveryToken" = NULL FROM previo
       WHERE r."id" = ${id}::uuid
      RETURNING previo.token`;
    return filas[0]?.token ?? null;
  }

  /** El token cifrado, sin borrarlo: se vuelve a entregar mientras la firma no se use (29-03). */
  async peekDeliveryToken(id: string): Promise<string | null> {
    const r = await this.db.approvalRequest.findFirst({ where: this.scope({ id }), select: { deliveryToken: true } });
    return r?.deliveryToken ?? null;
  }

  /** La firma ya se usó o venció: el token deja de guardarse. */
  async clearDeliveryToken(id: string): Promise<void> {
    await this.db.approvalRequest.updateMany({ where: this.scope({ id, deliveryToken: { not: null } }), data: { deliveryToken: null } });
  }

  /**
   * La condonación puede ser de un cargo o del adeudo de una membresía: si
   * quien pide no dijo cuál, se averigua por el id (29-01).
   */
  async waiverResourceType(resourceId: string): Promise<'Membership' | 'Charge' | null> {
    const [membresia, cargo] = await Promise.all([
      this.db.membership.findFirst({ where: this.scope({ id: resourceId }), select: { id: true } }),
      this.db.charge.findFirst({ where: this.scope({ id: resourceId }), select: { id: true } }),
    ]);
    return membresia ? 'Membership' : cargo ? 'Charge' : null;
  }

  /**
   * De QUÉ se trata cada solicitud, leído de la base y no del texto que
   * escribe quien pide (UXG-05): el socio y el folio del pago, el concepto
   * del cargo, la caja, el paquete, el mes que se cierra. Quien firma decide
   * con datos que el solicitante no puede maquillar.
   */
  async context(sols: ReadonlyArray<Pick<Solicitud, 'id' | 'resourceType' | 'resourceId'>>): Promise<Map<string, string>> {
    const ids = (tipo: string) => sols.filter((s) => s.resourceType === tipo && s.resourceId).map((s) => s.resourceId!);
    const socio = { select: { firstName: true, lastName: true, memberCode: true } } as const;
    // Sin ids de ese tipo no se consulta: Prisma mandaba igual un `WHERE 1=0`
    // por cada tabla, y la bandeja vacía costaba diez consultas (OPT3-09).
    const si = <T>(lista: string[], consulta: (ids: string[]) => Promise<T[]>): Promise<T[]> => (lista.length === 0 ? Promise.resolve([]) : consulta(lista));
    const [pagos, cargos, socios, membresias, turnos, paquetes] = await Promise.all([
      si(ids('Payment'), (xs) => this.db.payment.findMany({ where: this.scope({ id: { in: xs } }), select: { id: true, folio: true, method: true, member: socio } })),
      si(ids('Charge'), (xs) => this.db.charge.findMany({ where: this.scope({ id: { in: xs } }), select: { id: true, concept: true, member: socio } })),
      si(ids('Member'), (xs) => this.db.member.findMany({ where: this.scope({ id: { in: xs } }), select: { id: true, firstName: true, lastName: true, memberCode: true } })),
      si(ids('Membership'), (xs) => this.db.membership.findMany({ where: this.scope({ id: { in: xs } }), select: { id: true, member: socio } })),
      si(ids('CashSession'), (xs) => this.db.cashSession.findMany({ where: this.scope({ id: { in: xs } }), select: { id: true, cashRegister: { select: { name: true } } } })),
      si(ids('VisitPack'), (xs) => this.db.visitPack.findMany({ where: this.scope({ id: { in: xs } }), select: { id: true, member: socio } })),
    ]);
    const quien = (m: { firstName: string; lastName: string; memberCode: string }) => `${m.firstName} ${m.lastName} (${m.memberCode})`;
    // El cierre de mes no es una fila hasta que se cierra: el mes viaja en su id (20-01).
    const cierres = ids('MonthlyClose').flatMap((id) => {
      const mes = monthOfMonthlyCloseResourceId(id);
      return mes ? [[id, `Cierre de ${nombreDelMes(mes)}`] as const] : [];
    });
    const porRecurso = new Map<string, string>([
      ...pagos.map((p) => [p.id, `Pago de ${quien(p.member)}${p.folio ? ` · folio ${p.folio}` : ''}`] as const),
      ...cargos.map((c) => [c.id, `${c.concept} · ${quien(c.member)}`] as const),
      ...socios.map((m) => [m.id, `Socio ${quien(m)}`] as const),
      ...membresias.map((m) => [m.id, `Membresía de ${quien(m.member)}`] as const),
      ...turnos.map((t) => [t.id, `Turno de ${t.cashRegister.name}`] as const),
      ...paquetes.map((p) => [p.id, `Paquete de visitas de ${quien(p.member)}`] as const),
      ...cierres,
    ]);
    return new Map(sols.filter((s) => s.resourceId && porRecurso.has(s.resourceId)).map((s) => [s.id, porRecurso.get(s.resourceId!)!]));
  }
}

/**
 * CÓMO SE VA A ENTERAR QUIEN FIRMA (29-05, bloque 2.10). Solo lee, de dos
 * tablas de la identidad: si tiene vivo el aviso en su teléfono
 * (`push_subscriptions`) y si usó el panel hace poco (`sessions.lastSeenAt`).
 */
export class ApprovalReachRepository extends TenantRepository {
  /** Las firmas ya emitidas: si se usaron o vencieron (para «Resueltas hoy»). */
  async grantStates(ids: readonly string[]): Promise<Map<string, { usedAt: Date | null; expiresAt: Date }>> {
    if (ids.length === 0) return new Map();
    const filas = await this.db.approvalGrant.findMany({ where: this.scope({ id: { in: [...ids] } }), select: { id: true, usedAt: true, expiresAt: true } });
    return new Map(filas.map((f) => [f.id, { usedAt: f.usedAt, expiresAt: f.expiresAt }]));
  }

  /**
   * `conAvisos`: el servidor tiene llaves para mandar avisos; sin ellas una
   * suscripción guardada no sirve de nada y no cuenta.
   */
  async reachOf(userIds: readonly string[], conAvisos: boolean, ahora = new Date()): Promise<Map<string, ApprovalReach>> {
    if (userIds.length === 0) return new Map();
    const ids = [...userIds];
    const [avisos, sesiones] = await Promise.all([
      conAvisos
        ? this.db.pushSubscription.findMany({ where: this.scope({ userId: { in: ids }, failedAt: null }), select: { userId: true }, distinct: ['userId'] })
        : Promise.resolve([]),
      this.db.session.findMany({
        where: this.scope({ userId: { in: ids }, revokedAt: null, expiresAt: { gt: ahora }, lastSeenAt: { gte: new Date(ahora.getTime() - APPROVAL_PANEL_ACTIVE_MS) } }),
        select: { userId: true }, distinct: ['userId'],
      }),
    ]);
    const conPush = new Set(avisos.map((a) => a.userId));
    const enPanel = new Set(sesiones.map((x) => x.userId));
    return new Map(ids.map((id) => [id, conPush.has(id) ? 'push' : enPanel.has(id) ? 'panel' : 'none'] as const));
  }
}

/**
 * ESCALERA DE FALLOS DE LA FIRMA (`approval_signer_locks`, 24-11, D24-04).
 *
 * Contador PROPIO de la segunda firma: no suma a `users.failedLogins`, así
 * que equivocarse al firmar —o que alguien pruebe la contraseña de la dueña
 * en el mostrador— ya no bloquea la entrada de nadie. Solo pausa sus firmas.
 */
export class ApprovalSignerLockRepository extends TenantRepository {
  /** Hasta cuándo están en pausa las firmas de esta persona; null si no lo están. */
  async pausedUntil(userId: string): Promise<Date | null> {
    const r = await this.db.approvalSignerLock.findFirst({
      where: this.scope({ userId, pausedUntil: { gt: new Date() } }), select: { pausedUntil: true },
    });
    return r?.pausedUntil ?? null;
  }

  /** Las pausas vigentes de varias personas: para decirlo en el diálogo antes de teclear. */
  async pausesFor(userIds: readonly string[]): Promise<Map<string, Date>> {
    if (userIds.length === 0) return new Map();
    const filas = await this.db.approvalSignerLock.findMany({
      where: this.scope({ userId: { in: [...userIds] }, pausedUntil: { gt: new Date() } }), select: { userId: true, pausedUntil: true },
    });
    return new Map(filas.flatMap((f) => (f.pausedUntil ? [[f.userId, f.pausedUntil] as const] : [])));
  }

  /**
   * Suma un fallo en una sola sentencia (dos fallos a la vez cuentan dos). La
   * ventana corre desde el primer fallo: pasados sus 10 minutos, se empieza
   * de nuevo. Al llegar al tope, la pausa arranca y el contador vuelve a cero.
   */
  async registerFailure(userId: string, ahora = new Date()): Promise<{ failedCount: number; pausedUntil: Date | null }> {
    const corte = new Date(ahora.getTime() - APPROVAL_FAILURE_LADDER.windowMs);
    const filas = await this.db.$queryRaw<Array<{ failedCount: number }>>`
      INSERT INTO "approval_signer_locks" AS l ("userId", "organizationId", "failedCount", "windowStartedAt", "updatedAt")
      VALUES (${userId}::uuid, ${this.organizationId}::uuid, 1, ${ahora}, ${ahora})
      ON CONFLICT ("userId") DO UPDATE SET
        "failedCount" = CASE WHEN l."windowStartedAt" IS NULL OR l."windowStartedAt" <= ${corte} THEN 1 ELSE l."failedCount" + 1 END,
        "windowStartedAt" = CASE WHEN l."windowStartedAt" IS NULL OR l."windowStartedAt" <= ${corte} THEN ${ahora} ELSE l."windowStartedAt" END,
        "updatedAt" = ${ahora}
      WHERE l."organizationId" = ${this.organizationId}::uuid
      RETURNING l."failedCount"`;
    const failedCount = Number(filas[0]?.failedCount ?? 0);
    if (failedCount < APPROVAL_FAILURE_LADDER.pauseAt) return { failedCount, pausedUntil: null };
    const pausedUntil = new Date(ahora.getTime() + APPROVAL_FAILURE_LADDER.pauseMs);
    await this.db.approvalSignerLock.updateMany({
      where: this.scope({ userId }),
      data: { pausedUntil, failedCount: 0, windowStartedAt: null, updatedAt: ahora },
    });
    return { failedCount, pausedUntil };
  }

  /** Firmó bien: la cuenta de fallos vuelve a cero (la pausa vigente, si la hay, no se toca). */
  async clear(userId: string): Promise<void> {
    await this.db.approvalSignerLock.updateMany({
      where: this.scope({ userId, failedCount: { gt: 0 } }),
      data: { failedCount: 0, windowStartedAt: null, updatedAt: new Date() },
    });
  }
}
