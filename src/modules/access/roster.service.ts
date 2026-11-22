import {
  ACCESS_POLICY_VERSION, conflict, notFound, signRoster, validation,
  type RosterEntry, type RosterPayload, type SignedRoster } from '@gymflow/core';
import { createPublicKey, createPrivateKey } from 'node:crypto';
import { BranchRepository } from '../organization/index.js';
import { MemberRepository } from '../members/index.js';
import { MembershipRepository, VisitPackRepository } from '../memberships/index.js';
import { PlanRepository } from '../catalog/index.js';
import { CredentialRepository } from './credential.repository.js';
import { AccessRepository } from './access.repository.js';
import { parseWindows } from './access.service.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';

/** Tope de socios por padrón. Superarlo es un error, no un recorte. */
const ROSTER_LIMIT = 5000;
import type { Env } from '../../platform/env.js';
import type { RequestContext } from '../../platform/context.js';

/**
 * Construcción y firma del padrón (§22, ADR-015).
 *
 * El padrón es lo que permite al gateway decidir con la nube apagada. Lleva,
 * por cada socio de la sucursal, el estado que la política necesita.
 *
 * Ya NO lleva secretos: hasta ADR-032 llevaba el del QR de cada socio en
 * claro, y `GET /access/roster` lo devolvía a cualquiera con
 * `access:monitor` —recepción incluida—. Sin QR, no hay secreto que filtrar.
 *
 * Va FIRMADO con Ed25519 porque el gateway está en una red que el gimnasio no
 * controla del todo: quien alcance ese equipo puede borrarle el padrón —y
 * entonces degrada y se nota— pero no puede falsificarlo.
 */
export class RosterService {
  /**
   * Genera el padrón de una sucursal y lo firma.
   *
   * La versión es MONÓTONA y se incrementa en cada generación: es lo que
   * impide que reproducir un padrón antiguo devuelva el acceso a alguien
   * expulsado.
   */
  async build(ctx: RequestContext, env: Env, branchId: string): Promise<SignedRoster> {
    const orgId = ctx.tenant.organizationId;

    const branch = await new BranchRepository(orgId).findById(branchId);
    if (!branch) throw notFound('Sucursal no encontrada');

    const version = await new BranchRepository(orgId).bumpRosterVersion(branchId);

    /**
     * Tope del padrón. **Es un acantilado silencioso y hay que verlo.**
     *
     * Antes cortaba en 5,000 sin decir nada: pasada esa cifra, parte del
     * padrón simplemente dejaba de llegar al gateway y esos socios se
     * quedaban fuera cuando caía el enlace, sin error en ningún sitio. Hoy
     * sobra —el gimnasio tiene ~1,850— pero un límite que no avisa es un
     * límite que se descubre el día que duele.
     */
    const { members } = await new MemberRepository(orgId).list({ branchId, limit: ROSTER_LIMIT + 1 });
    if (members.length > ROSTER_LIMIT) {
      throw conflict(
        `La sucursal tiene más de ${ROSTER_LIMIT} socios y el padrón no los cubre a todos. ` +
        'Hay que paginarlo antes de seguir: un padrón truncado deja gente fuera sin avisar.',
      );
    }
    const memberships = new MembershipRepository(orgId);
    const plans = new PlanRepository(orgId);
    const packs = new VisitPackRepository(orgId);

    const hoy = await new BusinessCalendar(orgId).today(branchId);

    // Cuatro consultas para todo el padrón, no cuatro por socio (fase 4): con
    // 1,850 socios eran ~7,400 viajes a la base cada vez que un gateway pedía el padrón.
    const ids = members.map((m) => m.id);
    const vivas = await memberships.findLiveForMembers(ids);
    const planes = await plans.findByIds([...vivas.values()].map((v) => v.planId));
    const paquetes = await packs.balancesForMembers(ids);

    const entries: RosterEntry[] = [];
    for (const m of members) {
      const membership = vivas.get(m.id) ?? null;
      const plan = membership ? planes.get(membership.planId) ?? null : null;

      const suyos = paquetes.get(m.id);
      const vivos = suyos?.packs ?? [];
      const usable = vivos.find((p) => p.status === 'ACTIVE');
      const saldo = usable ? suyos!.balanceOf.get(usable.id) ?? 0 : null;

      entries.push({
        memberId: m.id,
        pinHash: null,
        rfidCardId: null,
        archived: m.status === 'ARCHIVED',
        membershipStatus: membership?.status ?? null,
        homeBranchId: m.homeBranchId,
        branchAccessScope: toScope(plan?.branchAccessScope),
        allowedBranchIds: membership?.soldAtBranchId ? [membership.soldAtBranchId] : [],
        /**
         * Las ventanas horarias SÍ van al padrón.
         *
         * Iban en `null` mientras la nube sí las evaluaba: misma versión de
         * política, entradas distintas, decisiones distintas. Un socio de
         * plan matutino entraba a las 21:00 cada vez que caía el enlace, y
         * la bitácora lo registraba como concedido. El handshake de versión
         * es estructuralmente incapaz de detectarlo porque las versiones
         * coinciden — es el fallo silencioso que ADR-015 quería evitar.
         */
        accessTimeWindows: parseWindows(plan?.accessTimeWindows),
        visitBalance: saldo,
        // Con la fecha de NEGOCIO de la sucursal, no con el reloj del
        // proceso: un padrón generado a las 23:50 llevaba el dato equivocado
        // pasada la medianoche.
        visitPackExpired: usable?.expiresOn ? usable.expiresOn.getTime() < hoy.getTime() : false,
        visitPackStatus: usable?.status ?? vivos[0]?.status ?? null,
      });
    }

    const payload: RosterPayload = {
      organizationId: orgId,
      branchId,
      version: version.toString(),
      issuedAtMs: Date.now(),
      policyVersion: ACCESS_POLICY_VERSION,
      entries,
    };

    return signRoster(payload, this.privateKey(env));
  }

  /**
   * Revocaciones desde una marca de tiempo.
   *
   * Canal SEPARADO y más rápido que el padrón porque **gana el NO**: retirar
   * un acceso es urgente y reponerlo no. Un gateway aplica una revocación
   * aunque su padrón sea posterior.
   */
  async revocations(ctx: RequestContext, since: Date) {
    const orgId = ctx.tenant.organizationId;
    const creds = await new CredentialRepository(orgId).revokedSince(since);
    const archivados = await new MemberRepository(orgId).archivedSince(since);
    return [
      ...creds.map((c) => ({ memberId: c.memberId, issuedAtMs: c.at.getTime(), reason: c.reason })),
      ...archivados.map((m: { id: string; at: Date }) => ({
        memberId: m.id, issuedAtMs: m.at.getTime(), reason: 'Socio dado de baja',
      })),
    ].sort((a, b) => a.issuedAtMs - b.issuedAtMs);
  }

  /** Clave pública, para provisionar los gateways. */
  publicKey(env: Env): string {
    return createPublicKey(this.privateKey(env))
      .export({ type: 'spki', format: 'pem' }).toString();
  }

  private privateKey(env: Env): string {
    if (!env.ROSTER_SIGNING_KEY) {
      throw validation(
        'Falta ROSTER_SIGNING_KEY: un padrón sin firmar es un padrón falsificable',
      );
    }
    try {
      createPrivateKey(env.ROSTER_SIGNING_KEY);
    } catch {
      throw validation('ROSTER_SIGNING_KEY no es una clave Ed25519 en PEM');
    }
    return env.ROSTER_SIGNING_KEY;
  }
}

/** Par de claves nuevo, para el primer arranque. */

function toScope(raw: string | undefined): 'ALL_BRANCHES' | 'HOME_BRANCH' | 'LISTED_BRANCHES' {
  return raw === 'HOME_BRANCH' || raw === 'LISTED_BRANCHES' || raw === 'ALL_BRANCHES'
    ? raw
    : 'HOME_BRANCH';
}

export { AccessRepository };
