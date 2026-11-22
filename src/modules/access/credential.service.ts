import {
  conflict, isValidPinFormat, notFound, validation,
  type CredentialKindValue,
} from '@gymflow/core';
import { createHash } from 'node:crypto';
import { AuditService } from '../../platform/audit/audit.service.js';
import { MemberRepository } from '../members/index.js';
import { CredentialRepository, type CredentialRecord } from './credential.repository.js';
import type { Env } from '../../platform/env.js';
import type { RequestContext } from '../../platform/context.js';

export type IssuedCredential = {
  id: string;
  kind: CredentialKindValue;
  rfidCardId: string | null;
};

export class CredentialService {
  private readonly audit = new AuditService();

  async issue(ctx: RequestContext, env: Env, input: {
    memberId: string;
    kind: CredentialKindValue;
    rfidCardId?: string | undefined;
    pin?: string | undefined;
  }): Promise<IssuedCredential> {
    const orgId = ctx.tenant.organizationId;

    const member = await new MemberRepository(orgId).findById(input.memberId);
    if (!member) throw notFound('Socio no encontrado');

    const repo = new CredentialRepository(orgId);
    const vivas = (await repo.listForMember(input.memberId)).filter((c) => c.revokedAt === null);
    if (vivas.some((c) => c.kind === input.kind)) {
      throw conflict(
        `El socio ya tiene una credencial ${input.kind} vigente. Revócala antes de emitir otra`,
      );
    }

    let pinHash: string | null = null;

    // El QR ya no se emite (ADR-032). Se rechaza aquí además de en la ruta:
    // un servicio que aceptara QR seguiría fabricando secretos que nada usa.
    if (input.kind === 'QR') throw validation('El QR se retiró: el acceso es por rostro o huella');
    if (input.kind === 'PIN') {
      if (!input.pin || !isValidPinFormat(input.pin)) {
        throw validation(
          'El PIN son seis dígitos y no puede ser una secuencia ni un dígito repetido',
        );
      }
      pinHash = createHash('sha256').update(input.pin).digest('hex');
    }
    if (input.kind === 'RFID' && !input.rfidCardId) {
      throw validation('Una credencial RFID necesita el identificador de la tarjeta');
    }

    const cred = await repo.issue({
      memberId: input.memberId,
      kind: input.kind,
      pinHash,
      rfidCardId: input.rfidCardId ?? null,
    });

    await this.audit.record(ctx, {
      action: 'access.credential.issue',
      resourceType: 'member_credential',
      resourceId: cred.id,
      afterState: { kind: input.kind, memberId: input.memberId },
    });

    return { id: cred.id, kind: cred.kind, rfidCardId: cred.rfidCardId };
  }

  /**
   * Revoca. Llega al torniquete por el canal de revocaciones, no esperando al
   * siguiente padrón completo: retirar un acceso es urgente.
   */
  async revoke(ctx: RequestContext, input: {
    credentialId: string; reason: string;
  }): Promise<CredentialRecord> {
    const orgId = ctx.tenant.organizationId;
    const repo = new CredentialRepository(orgId);

    const existente = await repo.findById(input.credentialId);
    if (!existente) throw notFound('Credencial no encontrada');

    const revocada = await repo.revoke(input.credentialId, input.reason);
    if (!revocada) throw conflict('La credencial ya estaba revocada');

    await this.audit.record(ctx, {
      action: 'access.credential.revoke',
      resourceType: 'member_credential',
      resourceId: input.credentialId,
      beforeState: { kind: existente.kind },
      afterState: { revoked: true },
      reason: input.reason,
    });

    return revocada;
  }
}
