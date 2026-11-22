import { TenantRepository } from '../../platform/db/tenant-repository.js';

/** Un tramo de la historia: de `desde` (inclusive) a `hasta` (exclusive). `null` = sin límite por ese lado. */
export type Tramo = { desde: Date | null; hasta: Date | null };

export type VisitaDelDia = {
  /** Día de negocio de la sede. */
  dia: string; branchId: string; outcome: 'GRANTED' | 'DENIED';
  /** La primera del día (entró) o la última (no pasó). */
  at: Date; veces: number; credentialKind: string; denialReason: string | null;
};
export type ContactoDeHistoria = {
  id: string; at: Date; channel: string; outcome: string; note: string | null; nextStepOn: Date | null;
  createdByUserId: string; branchId: string | null;
};
export type AvisoDeHistoria = { id: string; at: Date; title: string; body: string };

const TOPE = 400;
const entre = (t: Tramo) => (t.desde || t.hasta ? { ...(t.desde ? { gte: t.desde } : {}), ...(t.hasta ? { lt: t.hasta } : {}) } : undefined);

/**
 * LO QUE LA HISTORIA DEL SOCIO LEE Y NO ESTÁ EN LA BITÁCORA (bloque 2.2; 3-11).
 *
 * Solo lectura, y solo para armar la línea de tiempo de la ficha: sus pasos
 * por la puerta (la bitácora solo asienta las excepciones), los contactos con
 * su nota («regresa el lunes»: el asiento no guarda la nota) y los avisos que
 * recibió en su portal. Lee tablas de otros módulos (`access_decisions`,
 * `follow_ups`) como lo hace la bitácora para saber de quién es cada asiento:
 * `members` no puede importar a `access` ni a `follow-ups`, que dependen de él.
 */
export class MemberHistoryRepository extends TenantRepository {
  /** Sus pasos por la puerta del tramo, un renglón por día, sede y resultado. */
  async visitas(memberId: string, tramo: Tramo): Promise<VisitaDelDia[]> {
    const at = entre(tramo);
    const filas = await this.db.accessDecision.findMany({
      where: this.scope({ memberId, ...(at ? { at } : {}) }),
      select: { at: true, businessDate: true, branchId: true, outcome: true, credentialKind: true, denialReason: true },
      orderBy: { at: 'desc' },
      take: TOPE * 5,
    });
    const porDia = new Map<string, VisitaDelDia>();
    for (const f of filas) {
      const dia = f.businessDate.toISOString().slice(0, 10);
      const llave = `${dia}|${f.branchId}|${f.outcome}`;
      const v = porDia.get(llave);
      if (!v) {
        porDia.set(llave, { dia, branchId: f.branchId, outcome: f.outcome as 'GRANTED' | 'DENIED', at: f.at, veces: 1, credentialKind: f.credentialKind, denialReason: f.denialReason });
      } else {
        v.veces += 1;
        // Vienen de la más reciente a la más vieja: de una entrada se dice la primera del día.
        if (f.outcome === 'GRANTED') { v.at = f.at; v.credentialKind = f.credentialKind; }
      }
    }
    return [...porDia.values()].slice(0, TOPE);
  }

  /** Los contactos registrados con el socio en el tramo, con su nota. */
  async contactos(memberId: string, tramo: Tramo): Promise<ContactoDeHistoria[]> {
    const createdAt = entre(tramo);
    const filas = await this.db.followUp.findMany({
      where: this.scope({ memberId, ...(createdAt ? { createdAt } : {}) }),
      select: { id: true, createdAt: true, channel: true, outcome: true, note: true, nextStepOn: true, createdByUserId: true, branchId: true },
      orderBy: { createdAt: 'desc' },
      take: TOPE,
    });
    return filas.map((f) => ({ id: f.id, at: f.createdAt, channel: f.channel, outcome: f.outcome, note: f.note, nextStepOn: f.nextStepOn, createdByUserId: f.createdByUserId, branchId: f.branchId }));
  }

  /** Los avisos que recibió en su portal en el tramo (los ya leídos se purgan con el tiempo). */
  async avisos(memberId: string, tramo: Tramo): Promise<AvisoDeHistoria[]> {
    const createdAt = entre(tramo);
    const filas = await this.db.memberNotice.findMany({
      where: this.scope({ memberId, ...(createdAt ? { createdAt } : {}) }),
      select: { id: true, createdAt: true, title: true, body: true },
      orderBy: { createdAt: 'desc' },
      take: TOPE,
    });
    return filas.map((f) => ({ id: f.id, at: f.createdAt, title: f.title, body: f.body }));
  }

  /** Nombres del personal, por id. */
  async staffNames(ids: readonly string[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return new Map();
    const us = await this.db.user.findMany({ where: { id: { in: unicos }, organizationId: this.organizationId }, select: { id: true, fullName: true } });
    return new Map(us.map((u) => [u.id, u.fullName]));
  }
}
