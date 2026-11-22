import { notFound, uuidv7, validation } from '@gymflow/core';
import type { FaceMeasurementAttempt, FaceMeasurementReport, FaceThresholdRow } from '@gymflow/core/contracts';
import { TenantRepository } from '../../platform/db/tenant-repository.js';
import type { RequestContext } from '../../platform/context.js';
import { MemberRepository } from '../members/index.js';
import { FaceTemplateRepository } from './face-template.repository.js';
import type { FaceEngine } from './face.engine.js';

/**
 * MEDICIÓN DEL RECONOCIMIENTO (auditoría 8, bloque 2.3; hallazgo 6-10).
 *
 * El umbral con el que la Estación reconoce (0.38) viene de otro producto y
 * nadie lo midió con socios. Antes de usar el rostro en serio —y antes de
 * que valga en todo el gimnasio, que agranda el padrón— se mide aquí: socios
 * con su rostro registrado («es») y personas que no son socios («no es») se
 * paran frente a la cámara de recepción, igual que al entrar, y de cada
 * intento se guardan SOLO dos números: cuánto se pareció a su propio rostro
 * y cuánto al de la persona más parecida del padrón. Nunca la foto ni la
 * plantilla; no registra ninguna entrada ni consume visitas.
 *
 * Esto mide y propone. NO cambia el umbral: ese vive en `FACE_MATCH_THRESHOLD`
 * y lo cambia quien instala, con el resultado a la vista.
 */

/** Lo que pide el plan de la auditoría (06 §3.2): 30 socios y 10 que no lo son. */
export const SOCIOS_NECESARIOS = 30;
export const AJENOS_NECESARIOS = 10;
/** La holgura que se le deja al umbral sobre el parecido ajeno más alto. */
export const HOLGURA = 0.05;

export type IntentoMedido = {
  kind: 'MEMBER' | 'STRANGER';
  memberId: string | null;
  ownScore: number | null;
  bestOtherScore: number | null;
};

const redondear = (x: number) => Math.round(x * 1000) / 1000;
/** A centésimas, hacia arriba o hacia abajo: una franja nunca se agranda por redondeo. */
const haciaArriba = (x: number) => Math.ceil(x * 100 - 1e-9) / 100;
const haciaAbajo = (x: number) => Math.floor(x * 100 + 1e-9) / 100;
/** Lo que admite `FACE_MATCH_THRESHOLD`. */
const MINIMO = 0.2;
const MAXIMO = 0.9;
const acotar = (x: number) => Math.min(MAXIMO, Math.max(MINIMO, x));

/**
 * Lo que dicen los intentos. Pura: no lee nada.
 *
 *  · «propio»: el parecido de un socio con SU rostro. Por debajo del umbral,
 *    la Estación le diría «No te reconocí» (rechazo falso).
 *  · «ajeno»: el mayor parecido de alguien con el rostro de OTRA persona (un
 *    socio contra los demás, o alguien que no es socio contra todos). Igual o
 *    por encima del umbral, la Estación podría tomarlo por otro (confusión).
 *
 * LA FRANJA SEGURA va del ajeno más alto más 0.05 (`safeFrom`) al propio más
 * bajo menos 0.05 (`safeTo`): cualquier umbral ahí dentro no confunde a nadie
 * de lo medido y reconoce a todos, con holgura por los dos lados.
 *
 *  · El umbral de hoy cae dentro: se queda. No se propone moverlo por moverlo
 *    (y menos BAJARLO con una muestra de 40 personas).
 *  · Está por debajo de la franja: se propone subirlo a su inicio.
 *  · Está por encima: se propone bajarlo solo hasta el final de la franja.
 *  · No hay franja (alguien ajeno se parece más que algún socio a sí mismo):
 *    manda no confundir; se propone el inicio y se dice a cuántos socios deja
 *    fuera, que es a quienes hay que volver a tomarles el rostro.
 */
export function analizarMedicion(
  intentos: readonly IntentoMedido[],
  hoy: { umbral: number; margen: number },
): FaceMeasurementReport['analysis'] {
  const propios = intentos.filter((i) => i.kind === 'MEMBER' && i.ownScore !== null).map((i) => i.ownScore!);
  const ajenos = intentos.filter((i) => i.bestOtherScore !== null).map((i) => i.bestOtherScore!);
  const socios = new Set(intentos.filter((i) => i.kind === 'MEMBER' && i.memberId).map((i) => i.memberId!)).size;
  const extranos = intentos.filter((i) => i.kind === 'STRANGER').length;
  const suficiente = socios >= SOCIOS_NECESARIOS && extranos >= AJENOS_NECESARIOS;

  const rechazosCon = (t: number) => propios.filter((s) => s < t).length;
  const confusionesCon = (t: number) => ajenos.filter((s) => s >= t).length;

  const masBajoPropio = propios.length ? Math.min(...propios) : null;
  const masAltoAjeno = ajenos.length ? Math.max(...ajenos) : null;
  const medible = masBajoPropio !== null && masAltoAjeno !== null;
  const desde = medible ? acotar(haciaArriba(masAltoAjeno + HOLGURA)) : null;
  const hasta = medible ? haciaAbajo(masBajoPropio - HOLGURA) : null;
  const hayFranja = desde !== null && hasta !== null && desde <= hasta;

  let sugerido: number | null = null;
  if (desde !== null && hasta !== null) {
    if (!hayFranja) sugerido = desde;
    else if (hoy.umbral < desde) sugerido = desde;
    else if (hoy.umbral > hasta) sugerido = acotar(hasta);
    else sugerido = hoy.umbral;
  }

  const tabla: FaceThresholdRow[] = [];
  for (let c = 20; c <= 90; c += 2) {
    const t = c / 100;
    tabla.push({ threshold: t, falseRejects: rechazosCon(t), falseAccepts: confusionesCon(t) });
  }

  const sinVentaja = intentos.filter((i) => i.kind === 'MEMBER' && i.ownScore !== null && i.bestOtherScore !== null && i.ownScore - i.bestOtherScore < hoy.margen).length;

  let veredicto: string;
  if (sugerido === null || desde === null || hasta === null) {
    veredicto = 'Todavía no hay intentos de los dos tipos: hacen falta socios con su rostro registrado y personas que no sean socios.';
  } else {
    const u = hoy.umbral.toFixed(2);
    let base: string;
    if (!hayFranja) {
      base = `No hay un umbral que sirva para todos: alguien se pareció ${masAltoAjeno!.toFixed(2)} a otra persona y un socio solo ${masBajoPropio!.toFixed(2)} a sí mismo. Para no confundir a nadie haría falta ${sugerido.toFixed(2)}, y con eso ${rechazosCon(sugerido)} de ${propios.length} intentos de socios no se reconocerían. Antes de decidir: revisa que en cada intento se eligió al socio correcto (descarta los que no), y vuelve a tomar el rostro de quien salió bajo, con buena luz y de frente.`;
    } else if (sugerido === hoy.umbral) {
      base = `El umbral de hoy (${u}) sirve: queda dentro de la franja segura (de ${desde.toFixed(2)} a ${hasta.toFixed(2)}), donde nadie de lo medido se confunde con otra persona y todos los socios medidos se reconocen. No hace falta cambiarlo.`;
    } else if (hoy.umbral < desde) {
      base = `El umbral de hoy (${u}) es bajo: hubo quien se pareció ${masAltoAjeno!.toFixed(2)} a otra persona. Conviene subirlo a ${sugerido.toFixed(2)} (la franja segura va de ${desde.toFixed(2)} a ${hasta.toFixed(2)}); con eso todos los socios medidos se siguen reconociendo.`;
    } else {
      base = `El umbral de hoy (${u}) es alto: ${rechazosCon(hoy.umbral)} de ${propios.length} intentos de socios no se reconocerían o quedarían al límite. Se puede bajar a ${sugerido.toFixed(2)} sin que nadie de lo medido se confunda con otra persona (la franja segura va de ${desde.toFixed(2)} a ${hasta.toFixed(2)}). Antes de bajarlo conviene volver a tomar el rostro de quien salió bajo y repetir su intento.`;
    }
    const falta = suficiente ? '' : ` Todavía no se da por medido: van ${socios} de ${SOCIOS_NECESARIOS} socios y ${extranos} de ${AJENOS_NECESARIOS} personas que no son socios.`;
    veredicto = base + falta;
  }

  return {
    members: socios, strangers: extranos,
    membersNeeded: SOCIOS_NECESARIOS, strangersNeeded: AJENOS_NECESARIOS,
    enough: suficiente,
    currentThreshold: hoy.umbral, currentMargin: hoy.margen,
    lowestOwn: masBajoPropio === null ? null : redondear(masBajoPropio),
    highestOther: masAltoAjeno === null ? null : redondear(masAltoAjeno),
    safeFrom: desde, safeTo: hayFranja ? hasta : null,
    suggestedThreshold: sugerido,
    suggestedFalseRejects: sugerido === null ? null : rechazosCon(sugerido),
    currentFalseRejects: rechazosCon(hoy.umbral),
    currentFalseAccepts: confusionesCon(hoy.umbral),
    currentMarginFailures: sinVentaja,
    verdict: veredicto,
    table: tabla,
  };
}

type Fila = {
  id: string; branchId: string; kind: string; memberId: string | null;
  ownScore: number | null; bestOtherScore: number | null; compared: number; createdAt: Date;
};
const SELECT = { id: true, branchId: true, kind: true, memberId: true, ownScore: true, bestOtherScore: true, compared: true, createdAt: true } as const;

/** Los intentos de la medición (`face_measurements`): solo parecidos. */
export class FaceMeasurementRepository extends TenantRepository {
  async guardar(input: { branchId: string; kind: 'MEMBER' | 'STRANGER'; memberId: string | null; ownScore: number | null; bestOtherScore: number | null; compared: number; recordedByUserId: string | null }): Promise<Fila> {
    return this.db.faceMeasurement.create({ data: { id: uuidv7(), organizationId: this.organizationId, ...input }, select: SELECT });
  }

  async listar(branchIds?: readonly string[] | null): Promise<Fila[]> {
    return this.db.faceMeasurement.findMany({
      where: this.scope(branchIds ? { branchId: { in: [...branchIds] } } : {}),
      select: SELECT, orderBy: { createdAt: 'desc' }, take: 1000,
    });
  }

  async sedeDe(id: string): Promise<string | undefined> {
    return (await this.db.faceMeasurement.findFirst({ where: this.scope({ id }), select: { branchId: true } }))?.branchId;
  }

  async borrar(id: string): Promise<boolean> {
    return (await this.db.faceMeasurement.deleteMany({ where: this.scope({ id }) })).count > 0;
  }

  async borrarTodos(branchIds?: readonly string[] | null): Promise<number> {
    return (await this.db.faceMeasurement.deleteMany({ where: this.scope(branchIds ? { branchId: { in: [...branchIds] } } : {}) })).count;
  }
}

export class FaceMeasurementService {
  /**
   * Un intento frente a la cámara, con el mismo camino que la Estación (reto
   * de movimiento, cuadro más frontal). Se compara contra los rostros de TODO
   * el gimnasio —el peor caso, el de cuando el rostro valga en todas las
   * sucursales—, no solo contra los de la sede.
   */
  async medir(
    ctx: RequestContext, engine: FaceEngine,
    input: { branchId: string; frames: string[]; reto: string | null; kind: 'MEMBER' | 'STRANGER'; memberId: string | null },
  ): Promise<{ ok: true; attempt: FaceMeasurementAttempt } | { ok: false; motivo: string }> {
    const orgId = ctx.tenant.organizationId;
    if ((input.kind === 'MEMBER') !== (input.memberId !== null)) throw validation('Un intento de «es» lleva al socio; uno de «no es», a nadie.');
    const plantillas = await new FaceTemplateRepository(orgId).padron(input.branchId, 'organization');
    let nombre: string | null = null;
    if (input.memberId) {
      const socio = await new MemberRepository(orgId).findById(input.memberId);
      if (!socio) throw notFound('Socio no encontrado');
      nombre = `${socio.firstName} ${socio.lastName}`;
      if (!plantillas.some((p) => p.memberId === input.memberId)) {
        throw validation(`${socio.firstName} no tiene su rostro registrado: regístralo primero desde su ficha y vuelve a medir.`);
      }
    }
    if (plantillas.length === 0) throw validation('Nadie tiene su rostro registrado todavía: no hay contra quién comparar.');

    const r = await engine.extraer(input.frames, input.reto, false);
    if (!r.ok) return { ok: false, motivo: r.error };

    const parecidos = engine.parecidos(r.embedding, plantillas.map((p) => ({ id: p.memberId, embedding: engine.descifrar(p.embeddingEncrypted) })));
    const propio = input.memberId ? parecidos.get(input.memberId) ?? null : null;
    let ajeno: number | null = null;
    for (const [id, s] of parecidos) if (id !== input.memberId && (ajeno === null || s > ajeno)) ajeno = s;

    const fila = await new FaceMeasurementRepository(orgId).guardar({
      branchId: input.branchId, kind: input.kind, memberId: input.memberId,
      ownScore: propio, bestOtherScore: ajeno, compared: parecidos.size,
      recordedByUserId: ctx.tenant.actorUserId ?? null,
    });
    return { ok: true, attempt: serializar(fila, nombre) };
  }

  async informe(orgId: string, engine: FaceEngine, branchIds?: readonly string[] | null): Promise<FaceMeasurementReport> {
    const filas = await new FaceMeasurementRepository(orgId).listar(branchIds);
    const nombres = await new MemberRepository(orgId).namesByIds(filas.flatMap((f) => (f.memberId ? [f.memberId] : [])));
    return {
      attempts: filas.map((f) => serializar(f, f.memberId ? nombres.get(f.memberId)?.fullName ?? null : null)),
      analysis: analizarMedicion(
        filas.map((f) => ({ kind: f.kind === 'MEMBER' ? 'MEMBER' : 'STRANGER', memberId: f.memberId, ownScore: f.ownScore, bestOtherScore: f.bestOtherScore })),
        { umbral: engine.umbral, margen: engine.margen },
      ),
    };
  }
}

function serializar(f: Fila, memberName: string | null): FaceMeasurementAttempt {
  return {
    id: f.id, branchId: f.branchId, kind: f.kind === 'MEMBER' ? 'MEMBER' : 'STRANGER',
    memberId: f.memberId, memberName,
    ownScore: f.ownScore === null ? null : redondear(f.ownScore),
    bestOtherScore: f.bestOtherScore === null ? null : redondear(f.bestOtherScore),
    compared: f.compared, at: f.createdAt.toISOString(),
  };
}
