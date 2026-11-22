import { FOLLOW_UP_CHANNELS, FOLLOW_UP_OUTCOMES, uuidv7 } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/** Las listas viven en el núcleo (`retention.ts`): la API, el panel y el contrato dicen lo mismo. */
export const CANALES = FOLLOW_UP_CHANNELS;
export const RESULTADOS = FOLLOW_UP_OUTCOMES;

export type FollowUpRecord = {
  id: string; prospectId: string | null; memberId: string | null;
  /** En la base son texto; solo se escriben los valores del núcleo (la ruta los valida). */
  channel: string; outcome: string; note: string | null; nextStepOn: Date | null;
  createdByUserId: string; createdAt: Date;
  /** Quién hizo el contacto, para que la gerencia vea el trabajo de recepción. */
  createdByName?: string | null;
};

const SELECT = {
  id: true, prospectId: true, memberId: true, channel: true, outcome: true,
  note: true, nextStepOn: true, createdByUserId: true, createdAt: true,
} as const;

/**
 * SEGUIMIENTO (UX7): "le llamé", "le escribí", con resultado y próximo paso,
 * de un prospecto o de un socio en riesgo. Solo se agrega: la base no da
 * UPDATE ni DELETE a la aplicación.
 */
export class FollowUpRepository extends TenantRepository {
  async create(input: {
    prospectId?: string | null; memberId?: string | null; branchId?: string | null;
    channel: string; outcome: string; note?: string | null; nextStepOn?: Date | null; createdByUserId: string;
  }): Promise<FollowUpRecord> {
    const f = await this.db.followUp.create({
      data: {
        id: uuidv7(), organizationId: this.organizationId,
        prospectId: input.prospectId ?? null, memberId: input.memberId ?? null, branchId: input.branchId ?? null,
        channel: input.channel, outcome: input.outcome, note: input.note?.trim() || null,
        nextStepOn: input.nextStepOn ?? null, createdByUserId: input.createdByUserId,
      },
      select: SELECT,
    });
    return { ...f, createdByName: (await this.nombres([f.createdByUserId])).get(f.createdByUserId) ?? null };
  }

  /**
   * El último contacto y cuántos van, por sujeto: lo que pinta cada fila.
   *
   * `memberBranchIds` (solo socios) acota a los socios cuya sede de casa HOY
   * está en esa lista (15-13): recepción de Centro no lee los contactos de un
   * socio de Norte aunque conozca su id. Se mira la sede del socio y no la
   * del contacto: si el socio cambió de sede, manda dónde está ahora.
   */
  async latest(
    kind: 'prospect' | 'member', ids: readonly string[],
    opts: { memberBranchIds?: readonly string[] | null } = {},
  ): Promise<Map<string, { last: FollowUpRecord; count: number }>> {
    const out = new Map<string, { last: FollowUpRecord; count: number }>();
    if (ids.length === 0) return out;
    const campo = kind === 'prospect' ? 'prospectId' : 'memberId';
    const sedes = kind === 'member' ? opts.memberBranchIds ?? null : null;
    if (sedes !== null && sedes.length === 0) return out;
    const filas = await this.db.followUp.findMany({
      where: this.scope({
        [campo]: { in: [...ids] },
        ...(sedes !== null ? { member: { homeBranchId: { in: [...sedes] } } } : {}),
      }),
      select: SELECT, orderBy: { createdAt: 'desc' }, take: 2000,
    });
    const nombres = await this.nombres(filas.map((f) => f.createdByUserId));
    for (const f0 of filas) {
      const f = { ...f0, createdByName: nombres.get(f0.createdByUserId) ?? null };
      const k = (f[campo] ?? '') as string;
      const ya = out.get(k);
      if (ya) ya.count += 1; else out.set(k, { last: f, count: 1 });
    }
    return out;
  }

  /** Canal y resultado de TODOS los contactos de un interesado: de ahí se deriva su etapa (`deriveStage`). */
  async stagesOf(prospectId: string): Promise<Array<{ channel: string; outcome: string }>> {
    return this.db.followUp.findMany({ where: this.scope({ prospectId }), select: { channel: true, outcome: true }, take: 2000 });
  }

  async listFor(kind: 'prospect' | 'member', id: string): Promise<FollowUpRecord[]> {
    const filas = await this.db.followUp.findMany({
      where: this.scope(kind === 'prospect' ? { prospectId: id } : { memberId: id }),
      select: SELECT, orderBy: { createdAt: 'desc' }, take: 50,
    });
    const nombres = await this.nombres(filas.map((f) => f.createdByUserId));
    return filas.map((f) => ({ ...f, createdByName: nombres.get(f.createdByUserId) ?? null }));
  }

  /** Solo lectura del nombre del personal (la tabla es de identidad). */
  private async nombres(ids: readonly string[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return new Map();
    const us = await this.db.user.findMany({ where: { id: { in: unicos }, organizationId: this.organizationId }, select: { id: true, fullName: true } });
    return new Map(us.map((u) => [u.id, u.fullName]));
  }
}
