import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { computeAuditHash, uuidv7, type AuditContent } from '@gymflow/core';
import { closeDb, getDb } from '../src/platform/db/client.js';
import { AuditService } from '../src/platform/audit/audit.service.js';
import { PlatformAuditService } from '../src/platform/audit/platform-audit.service.js';
import { systemContext } from '../src/platform/jobs/types.js';
import { gimnasioPropio, type GimnasioPropio } from './gimnasio-propio.js';

/**
 * LA CADENA DE LA BITÁCORA Y EL RELOJ (bloque 3.12).
 *
 * Cada eslabón lleva su número (`chainSeq`): la punta es el número más alto y
 * la verificación recorre los números en orden. La hora del servidor ya no
 * decide con quién se enlaza un asiento ni en qué orden se revisa.
 *
 * Lo asentado ANTES de que existiera el número (`chainSeq` NULL) no se toca:
 * se verifica como siempre, por (at, id), y va antes de lo numerado. Aquí ese
 * tramo se fabrica escribiendo filas sin número, tal como las dejaba el
 * código anterior.
 */
describe('la cadena de la bitácora no depende del reloj', () => {
  const db = () => getDb();
  const audit = new AuditService();
  const abiertos: GimnasioPropio[] = [];
  const propio = async () => { const g = await gimnasioPropio({ sedes: [{ name: 'Sede de la cadena', cajas: 1 }] }); abiertos.push(g); return g; };
  const asentar = (g: GimnasioPropio, paso: string) => audit.record(systemContext(g.organizationId), {
    action: 'cash.register.update', resourceType: 'cash_register', resourceId: g.sedes[0]!.cajas[0]!, afterState: { paso },
  });
  const cadena = (organizationId: string) => db().auditLog.findMany({ where: { organizationId, chainSeq: { not: null } }, orderBy: { chainSeq: 'asc' }, select: { id: true, chainSeq: true, prevHash: true, hash: true, at: true } });

  /** Un asiento como lo dejaba el código anterior: enlazado con «el más tardío» y SIN número. */
  async function asentarComoAntes(organizationId: string, at: Date, paso: string): Promise<string> {
    const tip = await db().auditLog.findFirst({ where: { organizationId }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { hash: true } });
    const content: AuditContent = {
      id: uuidv7(), organizationId, branchId: null, actorUserId: null, actorType: 'SYSTEM', action: 'cash.register.update',
      resourceType: 'cash_register', resourceId: null, beforeState: null, afterState: { paso }, reason: null, approvedByUserId: null, at: at.toISOString(),
    };
    const prevHash = tip?.hash ?? null;
    const hash = computeAuditHash(prevHash, content);
    await db().auditLog.create({
      data: {
        id: content.id, organizationId, actorType: 'SYSTEM', action: content.action, resourceType: content.resourceType,
        afterState: { paso }, prevHash, hash, at, businessDate: new Date(at.toISOString().slice(0, 10)),
      },
    });
    return hash;
  }

  afterEach(() => { vi.useRealTimers(); });
  afterAll(async () => {
    for (const g of abiertos) await g.cerrar();
    await closeDb();
  });

  it('con el reloj detenido, veinte asientos en el mismo milisegundo encadenan en el orden en que se escribieron', async () => {
    const g = await propio();
    const antes = (await cadena(g.organizationId)).length;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-16T18:00:00.000Z'));
    for (let i = 0; i < 20; i++) await asentar(g, `paso ${i}`);
    vi.useRealTimers();
    const filas = (await cadena(g.organizationId)).slice(antes);
    expect(filas).toHaveLength(20);
    expect(new Set(filas.map((f) => f.at.toISOString())).size, 'todos a la misma hora').toBe(1);
    for (let i = 1; i < filas.length; i++) {
      expect(filas[i]!.chainSeq).toBe(filas[i - 1]!.chainSeq! + 1);
      expect(filas[i]!.prevHash).toBe(filas[i - 1]!.hash);
    }
    const v = await audit.verifyChain(g.organizationId);
    expect(v.ok, JSON.stringify(v)).toBe(true);
  });

  it('el reloj salta un año hacia delante y regresa: los asientos conservan su hora verdadera y la cadena sigue íntegra', async () => {
    const g = await propio();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-06-16T18:00:00.000Z'));
    const adelantado = await asentar(g, 'con el reloj un año adelante');
    vi.setSystemTime(new Date('2026-06-16T18:00:05.000Z'));
    const corregido = await asentar(g, 'con el reloj ya corregido');
    vi.useRealTimers();
    const filas = await db().auditLog.findMany({ where: { id: { in: [adelantado.id, corregido.id] } }, select: { id: true, at: true, prevHash: true } });
    const fila = (id: string) => filas.find((f) => f.id === id)!;
    expect(fila(corregido.id).at.toISOString(), 'la hora no se inventa para que la cadena cuadre').toBe('2026-06-16T18:00:05.000Z');
    expect(fila(corregido.id).prevHash).toBe(adelantado.hash);
    expect((await audit.verifyChain(g.organizationId)).ok).toBe(true);
  });

  it('muchos asientos a la vez: números seguidos, sin huecos ni repetidos', async () => {
    const g = await propio();
    const antes = await cadena(g.organizationId);
    await Promise.all(Array.from({ length: 25 }, (_, i) => asentar(g, `a la vez ${i}`)));
    const filas = await cadena(g.organizationId);
    expect(filas).toHaveLength(antes.length + 25);
    expect(filas.map((f) => f.chainSeq)).toEqual(filas.map((_, i) => i + 1));
    expect((await audit.verifyChain(g.organizationId)).ok).toBe(true);
  });

  it('una cadena ya escrita (sin número) se verifica como siempre y lo nuevo se engancha a su punta, aunque el reloj haya retrocedido', async () => {
    const g = await propio();
    const organizationId = g.organizationId;
    // `gimnasioPropio` no asienta nada: la cadena de esta marca empieza aquí, con tres asientos «de antes».
    expect(await db().auditLog.count({ where: { organizationId } })).toBe(0);
    await asentarComoAntes(organizationId, new Date('2026-06-16T18:00:00.000Z'), 'de antes 1');
    await asentarComoAntes(organizationId, new Date('2026-06-16T18:00:01.000Z'), 'de antes 2');
    const punta = await asentarComoAntes(organizationId, new Date('2026-06-16T18:00:02.000Z'), 'de antes 3');
    const soloLoDeAntes = await audit.verifyChain(organizationId);
    expect(soloLoDeAntes).toMatchObject({ ok: true, checked: 3, lastHash: punta });

    // Llega el código nuevo y el reloj está DOS HORAS ATRÁS de la punta.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-16T16:00:00.000Z'));
    const primero = await asentar(g, 'primero con número');
    vi.setSystemTime(new Date('2026-06-16T15:00:00.000Z'));
    const segundo = await asentar(g, 'segundo con número');
    vi.useRealTimers();

    const numerados = await cadena(organizationId);
    expect(numerados.map((f) => f.chainSeq)).toEqual([1, 2]);
    expect(numerados[0]!.prevHash, 'el primero numerado se enlaza con la punta de lo anterior').toBe(punta);
    expect(numerados[1]!.prevHash).toBe(primero.hash);
    // Con cualquier tamaño de tramo (el corte cae dentro de lo anterior, en la costura y dentro de lo numerado).
    for (const tramo of [1, 2, 3, 4, 1000]) {
      const v = await audit.verifyChain(organizationId, tramo);
      expect(v, `tramos de ${tramo}`).toMatchObject({ ok: true, checked: 5, lastHash: segundo.hash });
    }
  });

  it('la base no deja que dos asientos ocupen el mismo lugar de la cadena', async () => {
    const g = await propio();
    await asentar(g, 'uno');
    const uno = (await cadena(g.organizationId))[0]!;
    await expect(db().auditLog.create({
      data: {
        id: uuidv7(), organizationId: g.organizationId, actorType: 'SYSTEM', action: 'cash.register.update', resourceType: 'cash_register',
        prevHash: uno.prevHash, hash: 'x'.repeat(64), chainSeq: uno.chainSeq, businessDate: new Date('2026-06-16'),
      },
    })).rejects.toThrow();
    expect((await audit.verifyChain(g.organizationId)).ok).toBe(true);
  });

  it('la cadena de plataforma tampoco depende del reloj', async () => {
    const plataforma = new PlatformAuditService();
    expect((await plataforma.verifyChain()).ok, 'la cadena de plataforma ya venía íntegra').toBe(true);
    const asentarEnConsola = (paso: string) => plataforma.record({ userId: null, ip: null, userAgent: null, sessionId: null, requestId: null }, {
      action: 'platform.console.login', resourceType: 'PlatformSession', afterState: { paso },
    });
    // Horas de HOY (no del pasado): esta cadena es una sola para toda la base y su «inicio»
    // se mide por su asiento más antiguo; uno fechado en el pasado movería ese inicio.
    const ahora = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(ahora + 2_000));
    const a = await asentarEnConsola('antes de la corrección');
    vi.setSystemTime(new Date(ahora));
    const b = await asentarEnConsola('primero después');
    const c = await asentarEnConsola('segundo después, mismo milisegundo');
    vi.useRealTimers();
    const filas = await db().platformAuditLog.findMany({ where: { id: { in: [a.id, b.id, c.id] } }, orderBy: { chainSeq: 'asc' }, select: { id: true, prevHash: true, chainSeq: true } });
    expect(filas.map((f) => f.id)).toEqual([a.id, b.id, c.id]);
    expect(filas[1]!.prevHash).toBe(a.hash);
    expect(filas[2]!.prevHash).toBe(b.hash);
    const v = await plataforma.verifyChain();
    expect(v.ok, JSON.stringify(v)).toBe(true);
  });
});
