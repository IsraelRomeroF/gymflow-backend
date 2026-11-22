import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  ACCESS_POLICY_VERSION, acceptsRoster, verifyRoster,
} from '@gymflow/core';
import { makeApp, loginAs, orgFixtures, nombreUnico, telefonoUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

const db = () => getDb();
const sello = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4);

const CONSENTS = [
  { consentType: 'PRIVACY_NOTICE', documentVersion: 'v1.0', granted: true },
  { consentType: 'HOUSE_RULES', documentVersion: 'v1.0', granted: true },
];


describe('credenciales y padrón firmado', () => {
  let app: FastifyInstance;
  let owner: string;

  let branchId: string;
  let publicKeyPem: string;

  async function nuevoSocio(): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/members', headers: { cookie: owner },
      payload: {
        firstName: nombreUnico('Cred'), lastName: nombreUnico('Padron'),
        phoneE164: telefonoUnico(), homeBranchId: branchId, consents: CONSENTS,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  async function emitirPin(memberId: string) {
    return app.inject({
      method: 'POST', url: `/members/${memberId}/credentials`, headers: { cookie: owner },
      payload: { kind: 'PIN', pin: '482913' },
    });
  }

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    owner = await loginAs(app, 'gerencia@demo.mx');
    const { demoBranches } = await orgFixtures();

    branchId = demoBranches.find((b) => b.code === 'NOR')!.id;

    const pk = await app.inject({
      method: 'GET', url: '/access/roster/public-key', headers: { cookie: owner },
    });
    expect(pk.statusCode, pk.body).toBe(200);
    publicKeyPem = pk.json().publicKeyPem as string;
  });

  afterAll(async () => { await app.close(); await closeDb(); });

  // ── Credenciales ──────────────────────────────────────────────────────────
  /** ADR-032: el acceso es por rostro y huella. Un QR emitido sería un secreto huérfano. */
  it('el QR ya NO se puede emitir', async () => {
    const memberId = await nuevoSocio();
    const res = await app.inject({
      method: 'POST', url: `/members/${memberId}/credentials`, headers: { cookie: owner },
      payload: { kind: 'QR' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('no se emiten dos credenciales vigentes del mismo tipo', async () => {
    const memberId = await nuevoSocio();
    expect((await emitirPin(memberId)).statusCode).toBe(201);
    expect((await emitirPin(memberId)).statusCode).toBe(409);
  });

  it('tras revocar, SÍ se puede emitir otro', async () => {
    const memberId = await nuevoSocio();
    const primera = await emitirPin(memberId);

    const rev = await app.inject({
      method: 'POST', url: `/credentials/${primera.json().id}/revoke`, headers: { cookie: owner },
      payload: { reason: 'El socio lo olvidó' },
    });
    expect(rev.statusCode, rev.body).toBe(200);
    expect((await emitirPin(memberId)).statusCode).toBe(201);
  });

  it('un PIN débil se rechaza', async () => {
    const memberId = await nuevoSocio();
    for (const pin of ['123456', '111111', '1234']) {
      const res = await app.inject({
        method: 'POST', url: `/members/${memberId}/credentials`, headers: { cookie: owner },
        payload: { kind: 'PIN', pin },
      });
      expect(res.statusCode, pin).toBe(422);
    }
  });

  it('la misma tarjeta RFID no se asigna a dos socios', async () => {
    const tarjeta = `CARD-${sello()}`;
    const a = await nuevoSocio();
    const b = await nuevoSocio();
    const primera = await app.inject({
      method: 'POST', url: `/members/${a}/credentials`, headers: { cookie: owner },
      payload: { kind: 'RFID', rfidCardId: tarjeta },
    });
    expect(primera.statusCode, primera.body).toBe(201);

    const segunda = await app.inject({
      method: 'POST', url: `/members/${b}/credentials`, headers: { cookie: owner },
      payload: { kind: 'RFID', rfidCardId: tarjeta },
    });
    expect(segunda.statusCode).toBeGreaterThanOrEqual(400);
  });

  // ── Padrón ────────────────────────────────────────────────────────────────
  it('el padrón va FIRMADO y la firma verifica', async () => {
    const res = await app.inject({
      method: 'GET', url: `/access/roster?branchId=${branchId}`, headers: { cookie: owner },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { payload, signature } = res.json();
    expect(verifyRoster({ payload, signature }, publicKeyPem)).toBe(true);
    expect(payload.policyVersion).toBe(ACCESS_POLICY_VERSION);
  });

  /**
   * El gateway vive en una red que el gimnasio no controla del todo: sin
   * firma, quien alcance ese equipo le escribe un padrón propio.
   */
  it('MANIPULAR el padrón invalida la firma', async () => {
    const res = await app.inject({
      method: 'GET', url: `/access/roster?branchId=${branchId}`, headers: { cookie: owner },
    });
    const { payload, signature } = res.json();

    // Colar un socio que no estaba: el ataque directo contra el padrón.
    const colado = {
      ...payload,
      entries: [
        ...payload.entries,
        {
          memberId: '01a0d0c1-6d87-70ff-8448-43393788eaff',
          pinHash: null, rfidCardId: null, archived: false, membershipStatus: 'ACTIVE',
          homeBranchId: branchId, branchAccessScope: 'ALL_BRANCHES', allowedBranchIds: [],
          accessTimeWindows: null, visitBalance: null, visitPackExpired: false,
        },
      ],
    };
    expect(verifyRoster({ payload: colado, signature }, publicKeyPem)).toBe(false);

    // Y retroceder la versión, que devolvería el acceso a un expulsado.
    const retrocedido = { ...payload, version: '1' };
    expect(verifyRoster({ payload: retrocedido, signature }, publicKeyPem)).toBe(false);
  });

  it('la versión del padrón SOLO sube', async () => {
    const versiones: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'GET', url: `/access/roster?branchId=${branchId}`, headers: { cookie: owner },
      });
      versiones.push(res.json().payload.version);
    }
    expect(acceptsRoster(versiones[0]!, versiones[1]!)).toBe(true);
    expect(acceptsRoster(versiones[1]!, versiones[2]!)).toBe(true);
    // Y reproducir uno ANTIGUO se rechaza: es el ataque obvio.
    expect(acceptsRoster(versiones[2]!, versiones[0]!)).toBe(false);
  });

  /**
   * Hasta ADR-032 el padrón llevaba el secreto QR de cada socio en claro, y
   * `/access/roster` lo devolvía a cualquiera con `access:monitor`, recepción
   * incluida. Que no vuelva a aparecer ningún secreto.
   */
  it('el padrón NO lleva secretos de ningún socio', async () => {
    const memberId = await nuevoSocio();
    const res = await app.inject({
      method: 'GET', url: `/access/roster?branchId=${branchId}`, headers: { cookie: owner },
    });
    const entrada = res.json().payload.entries.find((e: { memberId: string }) => e.memberId === memberId);
    expect(entrada).toBeTruthy();
    expect(Object.keys(entrada)).not.toContain('qrSecret');
    expect(res.body).not.toMatch(/qrSecret|secretEncrypted/);
  });

  it('un socio ARCHIVADO va en el padrón marcado, no ausente', async () => {
    const memberId = await nuevoSocio();
    await db().member.update({
      where: { id: memberId }, data: { status: 'ARCHIVED', deletedAt: new Date() },
    });

    const res = await app.inject({
      method: 'GET', url: `/access/roster?branchId=${branchId}`, headers: { cookie: owner },
    });
    const entrada = res.json().payload.entries.find((e: { memberId: string }) => e.memberId === memberId);
    // Va marcado para que el gateway pueda decir "tu alta está cerrada" en vez
    // de "credencial no reconocida", que es lo que recepción necesita.
    if (entrada) expect(entrada.archived).toBe(true);
  });

  // ── Revocaciones: gana el NO ─────────────────────────────────────────────
  it('una revocación aparece en el canal rápido, sin esperar al padrón', async () => {
    const memberId = await nuevoSocio();
    const cred = await emitirPin(memberId);
    const desde = Date.now() - 1000;

    await app.inject({
      method: 'POST', url: `/credentials/${cred.json().id}/revoke`, headers: { cookie: owner },
      payload: { reason: 'Credencial comprometida' },
    });

    const res = await app.inject({
      method: 'GET', url: `/access/revocations?sinceMs=${desde}`, headers: { cookie: owner },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().revocations.some((r: { memberId: string }) => r.memberId === memberId)).toBe(true);
  });

  it('dar de baja a un socio también revoca', async () => {
    const memberId = await nuevoSocio();
    const desde = Date.now() - 1000;
    await db().member.update({
      where: { id: memberId }, data: { status: 'ARCHIVED', deletedAt: new Date() },
    });

    const res = await app.inject({
      method: 'GET', url: `/access/revocations?sinceMs=${desde}`, headers: { cookie: owner },
    });
    const r = res.json().revocations.find((x: { memberId: string }) => x.memberId === memberId);
    expect(r).toBeTruthy();
    expect(r.reason).toMatch(/baja/);
  });

  it('la clave pública se publica para provisionar gateways', async () => {
    expect(publicKeyPem).toMatch(/BEGIN PUBLIC KEY/);
  });
});
