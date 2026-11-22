import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, loginAs, orgFixtures, nombreUnico } from './helpers.js';
import { closeDb, getDb } from '../src/platform/db/client.js';

const CONSENTS = [
  { consentType: 'PRIVACY_NOTICE', documentVersion: 'v1.0', granted: true },
  { consentType: 'HOUSE_RULES', documentVersion: 'v1.0', granted: true },
];

describe('búsqueda de recepción', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    cookie = await loginAs(app, 'recepcion@demo.mx');
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  it('hay volumen representativo para que la medición signifique algo', async () => {
    const db = getDb();
    const { demo } = await orgFixtures();
    const total = await db.member.count({ where: { organizationId: demo.id } });
    expect(total, 'corre `pnpm --filter @gymflow/db seed:volume`').toBeGreaterThanOrEqual(1500);
  });

  describe('padrón', () => {
    type Pagina = { members: Array<{ id: string; firstName: string; lastName: string; balanceCents: string; memberCode: string }>; total: number; nextCursor: string | null };
    const pagina = async (qs: string) => {
      const r = await app.inject({ method: 'GET', url: `/members?${qs}`, headers: { cookie } });
      expect(r.statusCode, r.body).toBe(200);
      return r.json() as Pagina;
    };

    it('se recorre completo por cursor, sin repetir ni saltar a nadie', async () => {
      const vistos = new Set<string>();
      let p = await pagina('status=ACTIVE&limit=100');
      const total = p.total;
      expect(total).toBeGreaterThan(200); // Antes se cortaba en 200 sin avisar.
      for (;;) {
        for (const m of p.members) { expect(vistos.has(m.id)).toBe(false); vistos.add(m.id); }
        if (!p.nextCursor) break;
        p = await pagina(`status=ACTIVE&limit=100&cursor=${p.nextCursor}`);
      }
      expect(vistos.size).toBe(total);
    });

    it('"solo con adeudo" se filtra en la base: todos deben, solo de sus sedes, y el total cuadra', async () => {
      const { demo } = await orgFixtures();
      const p = await pagina('status=ACTIVE&withDebt=true&limit=100');
      // Recepción ve el saldo de su sede, no la cartera de las demás (SEC2-06).
      expect(p.members.every((m) => m.balanceCents !== null && BigInt(m.balanceCents) > 0n)).toBe(true);
      const sedes = (await getDb().roleAssignment.findMany({
        where: { user: { email: 'recepcion@demo.mx' }, revokedAt: null }, select: { branchId: true },
      })).map((a) => a.branchId!).filter(Boolean);
      const esperado = await getDb().member.count({
        where: { organizationId: demo.id, deletedAt: null, status: 'ACTIVE', balanceCentsCached: { gt: 0n }, homeBranchId: { in: sedes } },
      });
      expect(p.total).toBe(esperado);
    });

    it('filtra por nombre sin acentos y por código', async () => {
      const cualquiera = (await pagina('status=ACTIVE&limit=1')).members[0]!;
      const porCodigo = await pagina(`q=${encodeURIComponent(cualquiera.memberCode)}`);
      expect(porCodigo.members.map((m) => m.id)).toContain(cualquiera.id);
      // Nombre y apellido juntos, sin acentos y en mayúsculas: lo encuentra igual.
      const sinAcento = `${cualquiera.firstName} ${cualquiera.lastName}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
      const porNombre = await pagina(`q=${encodeURIComponent(sinAcento)}&limit=100`);
      expect(porNombre.members.map((m) => m.id)).toContain(cualquiera.id);
    });

    it('un cursor alterado se rechaza', async () => {
      const r = await app.inject({ method: 'GET', url: '/members?cursor=basura', headers: { cookie } });
      expect(r.statusCode).toBe(422);
    });
  });

  it('encuentra por nombre exacto', async () => {
    const db = getDb();
    const { demo } = await orgFixtures();
    // `deletedAt: null` a propósito: la búsqueda excluye archivados, así que
    // tomar un socio cualquiera hacía fallar la prueba por el fixture y no por
    // un defecto. Con 14 mil archivados, `findFirst` casi siempre da uno.
    const target = (await db.member.findFirst({
      where: { organizationId: demo.id, deletedAt: null },
      // El más antiguo: uno del sembrado, no uno que otra prueba acaba de
      // crear con un nombre generado (eso volvía la prueba aleatoria).
      orderBy: { createdAt: 'asc' },
      select: { firstName: true, lastName: true },
    }))!;
    const q = `${target.firstName.split(' ')[0]} ${target.lastName.split(' ')[0]}`;
    const res = await app.inject({ method: 'GET', url: `/members/search?q=${encodeURIComponent(q)}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().results.length).toBeGreaterThan(0);
  });

  it('ENCUENTRA PESE A ERRORES DE CAPTURA (Martinz -> Martínez)', async () => {
    const res = await app.inject({ method: 'GET', url: '/members/search?q=Martinz', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r: { lastName: string }) => r.lastName.includes('Martínez'))).toBe(true);
  });

  it('encuentra sin acentos', async () => {
    const res = await app.inject({ method: 'GET', url: '/members/search?q=Hernandez', headers: { cookie } });
    expect(res.json().results.length).toBeGreaterThan(0);
  });

  it('encuentra por código de socio', async () => {
    const db = getDb();
    const { demo } = await orgFixtures();
    const target = (await db.member.findFirst({
      where: { organizationId: demo.id, deletedAt: null },
      select: { memberCode: true },
    }))!;
    const res = await app.inject({ method: 'GET', url: `/members/search?q=${target.memberCode}`, headers: { cookie } });
    expect(res.json().results[0].memberCode).toBe(target.memberCode);
  });

  it('encuentra por los últimos dígitos del teléfono', async () => {
    const db = getDb();
    const { demo } = await orgFixtures();
    const target = (await db.member.findFirst({
      where: { organizationId: demo.id, phoneE164: { not: null }, deletedAt: null },
      select: { phoneE164: true, id: true },
    }))!;
    // 8 dígitos: con el sembrado de volumen, 6 coinciden con más de los 20 que muestra la búsqueda.
    const last6 = target.phoneE164!.slice(-8);
    const res = await app.inject({ method: 'GET', url: `/members/search?q=${last6}`, headers: { cookie } });
    expect(res.json().results.some((r: { id: string }) => r.id === target.id)).toBe(true);
  });

  it('CRITERIO DE ACEPTACIÓN: la búsqueda tarda menos de 1 s con volumen real', async () => {
    const consultas = ['Martinz', 'Hernandez Garcia', 'Jose Luis', 'Gonzalez', 'Rodrigez'];
    const tiempos: number[] = [];
    for (const q of consultas) {
      const res = await app.inject({ method: 'GET', url: `/members/search?q=${encodeURIComponent(q)}`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      tiempos.push(res.json().elapsedMs);
    }
    const peor = Math.max(...tiempos);
    console.log(`    búsqueda: peor caso ${peor} ms sobre ${tiempos.length} consultas`);
    expect(peor).toBeLessThan(1000);
  });

  it('ignora consultas de menos de 2 caracteres', async () => {
    const res = await app.inject({ method: 'GET', url: '/members/search?q=a', headers: { cookie } });
    expect(res.statusCode).toBe(422);
  });
});

describe('alta de socio con deduplicación', () => {
  let app: FastifyInstance;
  let cookie: string;
  let branchId: string;
  const creados: string[] = [];

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    cookie = await loginAs(app, 'recepcion@demo.mx');
    const branches = await app.inject({ method: 'GET', url: '/branches', headers: { cookie } });
    branchId = branches.json().find((b: { code: string }) => b.code === 'CEN').id;
  });
  afterAll(async () => {
    const db = getDb();
    // Limpieza por BORRADO LÓGICO: la evidencia de consentimiento tiene una
    // clave foránea contra el socio y no se puede borrar, así que el socio
    // tampoco. Es la política de docs/05 §1.4 funcionando.
    if (creados.length) {
      await db.member.updateMany({
        where: { id: { in: creados } },
        data: { deletedAt: new Date(), status: 'ARCHIVED' },
      });
    }
    await app.close();
    await closeDb();
  });

  // Sufijo con LETRAS: la normalización de nombres descarta los dígitos
  // (correcto para nombres), así que un sufijo numérico daría la misma clave
  // a todos y los haría parecer duplicados entre sí.
  let n = 0;
  const sufijo = () => {
    n += 1;
    const base = Date.now().toString(36).toUpperCase().replace(/[^A-Z]/g, '') || 'X';
    return `${base}${'ABCDEFGHIJ'[n % 10]}${n}`.replace(/[^A-Za-z]/g, '');
  };
  const nuevo = (extra: Record<string, unknown> = {}) => ({
    firstName: 'Xochitl',
    lastName: `Tepetate${sufijo()}`,
    phoneE164: `55${String(Date.now() + n).slice(-8)}`,
    homeBranchId: branchId,
    consents: CONSENTS,
    ...extra,
  });

  it('RECHAZA el alta sin los consentimientos obligatorios', async () => {
    const res = await app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: { ...nuevo(), consents: [{ consentType: 'MARKETING', documentVersion: 'v1', granted: true }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain('PRIVACY_NOTICE');
  });

  it('crea el socio con código legible y consentimientos sellados', async () => {
    const payload = nuevo();
    const res = await app.inject({ method: 'POST', url: '/members', headers: { cookie }, payload });
    expect(res.statusCode).toBe(201);
    const member = res.json();
    creados.push(member.id);
    expect(member.memberCode).toMatch(/^CEN-\d{5}$/);
    // El dinero sale como string, nunca como number (ADR-005).
    expect(typeof member.balanceCents).toBe('string');

    const consents = await app.inject({ method: 'GET', url: `/members/${member.id}/consents`, headers: { cookie: await loginAs(app, 'gerencia@demo.mx') } });
    expect(consents.statusCode).toBe(200);
    const list = consents.json();
    expect(list).toHaveLength(2);
    expect(list[0].evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('DETECTA el duplicado y NO crea: devuelve 409 para que decida una persona', async () => {
    const base = nuevo();
    const first = await app.inject({ method: 'POST', url: '/members', headers: { cookie }, payload: base });
    expect(first.statusCode).toBe(201);
    creados.push(first.json().id);

    const dup = await app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: { ...base, firstName: 'Xóchitl' }, // mismo teléfono y nombre equivalente
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('DUPLICATES_FOUND');
    expect(dup.json().candidates[0].action).toBe('AUTO_MERGE');
  });

  it('con `force` sí crea, y el forzado queda AUDITADO', async () => {
    const base = nuevo();
    const first = await app.inject({ method: 'POST', url: '/members', headers: { cookie }, payload: base });
    creados.push(first.json().id);

    const forced = await app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: { ...base, phoneE164: `55${String(Date.now() + 1).slice(-8)}`, force: true },
    });
    expect(forced.statusCode).toBe(201);
    creados.push(forced.json().id);

    const ownerCookie = await loginAs(app, 'gerencia@demo.mx');
    const audit = await app.inject({ method: 'GET', url: '/audit?limit=20&resourceType=Member', headers: { cookie: ownerCookie } });
    const entry = audit.json().entries.find((e: { resourceId: string }) => e.resourceId === forced.json().id);
    expect(entry.afterState.forcedDespiteDuplicates).toBe(true);
  });

  it('un socio con consentimientos NO se puede borrar en duro', async () => {
    const db = getDb();
    const payload = nuevo();
    const res = await app.inject({ method: 'POST', url: '/members', headers: { cookie }, payload });
    const id = res.json().id;
    creados.push(id);

    // La evidencia de cumplimiento protege también al registro del socio:
    // la baja es SIEMPRE lógica.
    await expect(db.member.delete({ where: { id } })).rejects.toThrow();

    const archived = await app.inject({
      method: 'POST', url: `/members/${id}/archive`,
      headers: { cookie: await loginAs(app, 'gerencia@demo.mx') },
      payload: { reason: 'Prueba de baja lógica' },
    });
    expect(archived.statusCode).toBe(200);
  });

  it('un CÓDIGO LEGADO con otro formato no dispara el contador', async () => {
    const db = getDb();
    const { demo } = await orgFixtures();
    // Así se verán los códigos que llegan de BDKGYM: formato arbitrario.
    // Si el contador los interpretara, saltaría a un número absurdo del que
    // no se vuelve, y todos los códigos nuevos saldrían deformados.
    const legado = await db.member.create({
      data: {
        id: (await import('@gymflow/core')).uuidv7(),
        organizationId: demo.id,
        memberCode: 'BDK-1998-000777',
        homeBranchId: branchId,
        firstName: 'Legado', lastName: 'BDKGYM',
        nameKey: 'BDKGYM LEGADO', joinedAt: new Date(),
      },
    });
    creados.push(legado.id);

    const res = await app.inject({ method: 'POST', url: '/members', headers: { cookie }, payload: nuevo() });
    expect(res.statusCode).toBe(201);
    creados.push(res.json().id);
    // Sigue con el formato propio y una secuencia razonable.
    expect(res.json().memberCode).toMatch(/^CEN-\d{5,6}$/);
  });

  it('check-duplicates informa sin crear nada', async () => {
    const res = await app.inject({
      method: 'POST', url: '/members/check-duplicates', headers: { cookie },
      payload: { firstName: 'Jose', lastName: 'Hernandez Garcia' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('blocking');
  });
});

describe('inmutabilidad del consentimiento', () => {
  let app: FastifyInstance;
  afterAll(async () => { await app?.close(); await closeDb(); });
  beforeAll(async () => { app = await makeApp(); await app.ready(); });

  it('la base RECHAZA reescribir la evidencia aceptada', async () => {
    const db = getDb();
    const consent = await db.memberConsent.findFirst();
    expect(consent, 'se requiere al menos un consentimiento').toBeTruthy();
    await expect(
      db.memberConsent.update({ where: { id: consent!.id }, data: { documentVersion: 'v9.9-falsificada' } }),
    ).rejects.toThrow();
  });

  it('pero SÍ permite revocarlo (art. 7 LFPDPPP)', async () => {
    const db = getDb();
    const consent = await db.memberConsent.findFirst({ where: { revokedAt: null } });
    const updated = await db.memberConsent.update({
      where: { id: consent!.id }, data: { revokedAt: new Date() },
    });
    expect(updated.revokedAt).toBeTruthy();
    await db.memberConsent.update({ where: { id: consent!.id }, data: { revokedAt: null } });
  });
});

describe('catálogo de planes', () => {
  let app: FastifyInstance;
  let cookie: string;
  beforeAll(async () => { app = await makeApp(); await app.ready(); cookie = await loginAs(app, 'recepcion@demo.mx'); });
  afterAll(async () => { await app.close(); await closeDb(); });

  it('soporta mensual, trimestral, anual, paquete de visitas y day pass', async () => {
    const res = await app.inject({ method: 'GET', url: '/plans', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const modelos = new Set(res.json().map((p: { billingModel: string }) => p.billingModel));
    expect(modelos).toContain('RECURRING');
    expect(modelos).toContain('PREPAID_PERIOD');
    expect(modelos).toContain('VISIT_PACK');
    expect(modelos).toContain('DAY_PASS');
  });

  it('los precios viajan como STRING de centavos', async () => {
    const plans = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie } })).json();
    for (const p of plans) expect(typeof p.priceCents).toBe('string');
  });

  it('el paquete de visitas declara cuántas incluye', async () => {
    const plans = (await app.inject({ method: 'GET', url: '/plans', headers: { cookie } })).json();
    const pack = plans.find((p: { billingModel: string }) => p.billingModel === 'VISIT_PACK');
    expect(pack.visitsIncluded).toBeGreaterThan(0);
  });

  it('PRECIO POR SUCURSAL: Frontera cuesta más que Centro sin duplicar el plan', async () => {
    const branches = (await app.inject({ method: 'GET', url: '/branches', headers: { cookie } })).json();
    const centro = branches.find((b: { code: string }) => b.code === 'CEN').id;
    const frontera = branches.find((b: { code: string }) => b.code === 'FRO').id;

    const enCentro = (await app.inject({ method: 'GET', url: `/plans?branchId=${centro}`, headers: { cookie } })).json();
    const enFrontera = (await app.inject({ method: 'GET', url: `/plans?branchId=${frontera}`, headers: { cookie } })).json();

    const men = (list: Array<{ code: string; effectivePriceCents: string }>) =>
      BigInt(list.find((p) => p.code === 'MEN')!.effectivePriceCents);

    expect(men(enFrontera)).toBeGreaterThan(men(enCentro));
  });

  it('el coach NO puede dar de alta socios pero SÍ ver el catálogo', async () => {
    const coach = await loginAs(app, 'coach@demo.mx');
    expect((await app.inject({ method: 'GET', url: '/plans', headers: { cookie: coach } })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: '/members', headers: { cookie: coach },
      payload: { firstName: 'A', lastName: 'B', consents: CONSENTS },
    })).statusCode).toBe(403);
  });
});

describe('privilegios de base de datos (anti-regresión)', () => {
  afterAll(async () => { await closeDb(); });

  /**
   * Un `GRANT ... ON ALL TABLES` en una migración posterior DESHACE los
   * REVOKE anteriores. Ocurrió de verdad en el Sprint 2 y solo lo detectó
   * una revisión manual. Esta prueba lo convierte en fallo de CI.
   */
  it('gymflow_app NO puede modificar ni borrar la bitácora', async () => {
    const db = getDb();
    const rows = await db.$queryRaw<Array<{ privilege_type: string }>>`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE grantee = 'gymflow_app' AND table_name = 'audit_logs'`;
    const privs = rows.map((r) => r.privilege_type).sort();
    expect(privs).toEqual(['INSERT', 'SELECT']);
  });

  it('gymflow_app NO puede borrar evidencia de consentimiento', async () => {
    const db = getDb();
    const rows = await db.$queryRaw<Array<{ privilege_type: string }>>`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE grantee = 'gymflow_app' AND table_name = 'member_consents' AND privilege_type = 'DELETE'`;
    expect(rows).toHaveLength(0);
  });

  it('gymflow_app solo puede escribir la revocación de un consentimiento (SEC-15)', async () => {
    const db = getDb();
    const tabla = await db.$queryRaw<Array<{ privilege_type: string }>>`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE grantee = 'gymflow_app' AND table_name = 'member_consents' AND privilege_type = 'UPDATE'`;
    expect(tabla).toHaveLength(0);
    const columnas = await db.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.column_privileges
      WHERE grantee = 'gymflow_app' AND table_name = 'member_consents' AND privilege_type = 'UPDATE'`;
    expect(columnas.map((c) => c.column_name)).toEqual(['revokedAt']);
  });

  it('gymflow_app NO es propietario de las tablas (requisito para RLS en fase 2)', async () => {
    const db = getDb();
    const rows = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_tables
      WHERE schemaname = 'public' AND tableowner = 'gymflow_app'`;
    expect(rows[0]!.n).toBe(0);
  });
});

/**
 * Regresión del Sprint 5.
 *
 * El código de socio es `PREFIJO-NNNNN` con el prefijo truncado a tres letras
 * del código de sucursal. Dos defectos reales convivían ahí y los dos emitían
 * códigos duplicados en silencio.
 */
describe('prefijo del código de socio', () => {
  let app: FastifyInstance;
  let orgId: string;

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    orgId = (await orgFixtures()).demo.id;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  const db = () => getDb();

  it('la base IMPIDE dos sucursales vivas con el mismo prefijo de tres letras', async () => {
    const { uuidv7 } = await import('@gymflow/core');
    const sufijo = Date.now().toString(36).slice(-4).toUpperCase();
    const a = await db().branch.create({
      data: { id: uuidv7(), organizationId: orgId, code: `PRE${sufijo}A`, name: 'Prefijo A' },
    });

    // "PREFIJO" y "PREFIJO NORTE" son códigos distintos y ambos dan `PRE`.
    await expect(db().branch.create({
      data: { id: uuidv7(), organizationId: orgId, code: `PRE${sufijo}B`, name: 'Prefijo B' },
    })).rejects.toThrow(/branches_member_code_prefix_key/);

    await db().branch.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
  });

  it('archivar una sucursal y reusar su prefijo CONTINÚA la numeración, no la reinicia', async () => {
    const { uuidv7, memberCodePrefix } = await import('@gymflow/core');
    const cookie = await loginAs(app, 'gerencia@demo.mx');
    // Un prefijo que NADIE use todavía. Antes era `RE` + un carácter del
    // reloj: 36 posibilidades, y en una base de desarrollo con historia
    // acababa cayendo en uno ya usado y la numeración no empezaba donde la
    // prueba esperaba.
    const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let prefijo = '';
    for (let i = 0; i < 200 && !prefijo; i++) {
      const p = `Q${letras[Math.floor(Math.random() * letras.length)]}${letras[Math.floor(Math.random() * letras.length)]}`;
      const usado = await db().branch.count({ where: { organizationId: orgId, code: { startsWith: p } } })
        + await db().member.count({ where: { organizationId: orgId, memberCode: { startsWith: `${p}-` } } });
      if (usado === 0) prefijo = p;
    }
    expect(prefijo).not.toBe('');

    const primera = await db().branch.create({
      data: { id: uuidv7(), organizationId: orgId, code: `${prefijo}UNO`, name: 'Reuso primera' },
    });
    const alta1 = await app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: {
        // Nombres con LETRAS: la normalización elimina los dígitos, así que un
        // sufijo numérico produce claves idénticas entre corridas.
        firstName: nombreUnico('Reuso'), lastName: nombreUnico('Primero'),
        homeBranchId: primera.id, consents: CONSENTS,
      },
    });
    expect(alta1.statusCode, alta1.body).toBe(201);
    const codigo1 = alta1.json().memberCode as string;
    expect(memberCodePrefix(`${prefijo}UNO`)).toBe(prefijo);

    // Se archiva la sucursal y se crea otra con el MISMO prefijo.
    await db().branch.update({ where: { id: primera.id }, data: { deletedAt: new Date() } });
    const segunda = await db().branch.create({
      data: { id: uuidv7(), organizationId: orgId, code: `${prefijo}DOS`, name: 'Reuso segunda' },
    });

    const alta2 = await app.inject({
      method: 'POST', url: '/members', headers: { cookie },
      payload: {
        firstName: nombreUnico('Reuso'), lastName: nombreUnico('Segundo'),
        homeBranchId: segunda.id, consents: CONSENTS,
      },
    });
    expect(alta2.statusCode, alta2.body).toBe(201);
    const codigo2 = alta2.json().memberCode as string;

    // Antes reiniciaba en 00001 y chocaba con el socio de la sede archivada.
    expect(codigo2).not.toBe(codigo1);
    expect(Number(codigo2.slice(-5))).toBe(Number(codigo1.slice(-5)) + 1);

    await db().branch.update({ where: { id: segunda.id }, data: { deletedAt: new Date() } });
  });
});
