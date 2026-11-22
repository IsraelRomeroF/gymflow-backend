import { uuidv7 } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

/**
 * CÓDIGOS DEL SISTEMA ANTERIOR (docs/09 §4.4). Se conservan todos y siguen
 * siendo buscables: el socio dice "soy el 331" durante meses. Viven con el
 * socio, no con la importación, porque son parte de su expediente.
 */
export class LegacyCodeRepository extends TenantRepository {
  // La FUENTE de un código (la sucursal del archivo normalizada, o GENERAL)
  // la calcula el núcleo: `fuenteDelArchivo` (antes había una copia aquí).

  /** ¿Quién tiene este código? Primero en la misma fuente; si no, en cualquiera de UNA sola persona. */
  async memberFor(code: string, source: string): Promise<string | null> {
    const exacta = await this.db.memberLegacyCode.findFirst({
      where: this.scope({ code: code.trim(), source }), select: { memberId: true },
    });
    if (exacta) return exacta.memberId;
    const otras = await this.db.memberLegacyCode.findMany({
      where: this.scope({ code: code.trim() }), select: { memberId: true }, take: 2,
    });
    // El mismo número en dos sucursales es de dos personas: no se adivina.
    return otras.length === 1 ? otras[0]!.memberId : null;
  }

  /**
   * Como `memberFor`, y además dice si el código es de ESA fuente (`exact`) o
   * de otra: con otra fuente, la importación comprueba el nombre antes de unir
   * (el mismo número en dos sucursales son dos personas).
   */
  async ownerOf(code: string, source: string): Promise<{ memberId: string; exact: boolean } | null> {
    const exacta = await this.db.memberLegacyCode.findFirst({
      where: this.scope({ code: code.trim(), source }), select: { memberId: true },
    });
    if (exacta) return { memberId: exacta.memberId, exact: true };
    const otras = await this.db.memberLegacyCode.findMany({
      where: this.scope({ code: code.trim() }), select: { memberId: true }, take: 2,
    });
    return otras.length === 1 ? { memberId: otras[0]!.memberId, exact: false } : null;
  }

  /** Idempotente: el mismo código de la misma fuente no se duplica. */
  async add(input: { memberId: string; code: string; source: string; importId: string | null }): Promise<void> {
    await this.db.memberLegacyCode.createMany({
      data: [{ id: uuidv7(), organizationId: this.organizationId, memberId: input.memberId, code: input.code.trim(), source: input.source, importId: input.importId }],
      skipDuplicates: true,
    });
  }

  async forMember(memberId: string): Promise<Array<{ code: string; source: string }>> {
    return this.db.memberLegacyCode.findMany({
      where: this.scope({ memberId }), select: { code: true, source: true }, orderBy: { createdAt: 'asc' },
    });
  }
}
