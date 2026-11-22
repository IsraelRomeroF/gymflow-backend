import { uuidv7, type CredentialKindValue } from '@gymflow/core';
import { PrismaCredentialKind } from '@gymflow/db';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

const K = PrismaCredentialKind;

export type CredentialRecord = {
  id: string;
  memberId: string;
  kind: CredentialKindValue;
  rfidCardId: string | null;
  lastUsedCounter: number | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  issuedAt: Date;
};

const SELECT = {
  id: true, memberId: true, kind: true, rfidCardId: true,
  lastUsedCounter: true, revokedAt: true, revokedReason: true, issuedAt: true,
} as const;

export class CredentialRepository extends TenantRepository {
  async listForMember(memberId: string): Promise<CredentialRecord[]> {
    const rows = await this.db.memberCredential.findMany({
      where: this.scope({ memberId }), select: SELECT, orderBy: { issuedAt: 'desc' },
    });
    return rows as CredentialRecord[];
  }

  async findById(id: string): Promise<CredentialRecord | null> {
    const row = await this.db.memberCredential.findFirst({ where: this.scope({ id }), select: SELECT });
    return row as CredentialRecord | null;
  }

  async issue(input: {
    memberId: string;
    kind: CredentialKindValue;
    secretEncrypted?: string | null;
    pinHash?: string | null;
    rfidCardId?: string | null;
  }): Promise<CredentialRecord> {
    const row = await this.db.memberCredential.create({
      data: {
        id: uuidv7(),
        organizationId: this.organizationId,
        memberId: input.memberId,
        kind: K[input.kind as keyof typeof K],
        secretEncrypted: input.secretEncrypted ?? null,
        pinHash: input.pinHash ?? null,
        rfidCardId: input.rfidCardId ?? null,
      },
      select: SELECT,
    });
    return row as CredentialRecord;
  }

  /** Revocar es idempotente: dos clics no producen dos revocaciones. */
  async revoke(id: string, reason: string): Promise<CredentialRecord | null> {
    const res = await this.db.memberCredential.updateMany({
      where: this.scope({ id, revokedAt: null }),
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return res.count === 0 ? null : this.findById(id);
  }

  /** Revocaciones recientes: el canal rápido donde GANA EL NO. */
  async revokedSince(since: Date): Promise<Array<{ memberId: string; at: Date; reason: string }>> {
    const rows = await this.db.memberCredential.findMany({
      where: this.scope({ revokedAt: { gte: since } }),
      select: { memberId: true, revokedAt: true, revokedReason: true },
    });
    return rows.map((r) => ({
      memberId: r.memberId,
      at: r.revokedAt!,
      reason: r.revokedReason ?? 'revocada',
    }));
  }
}
