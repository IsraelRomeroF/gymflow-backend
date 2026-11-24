import {
  CONSERVACION, DomainError, MOTIVO_ROSTRO_TRAS_LA_BAJA, businessDateIn, conflict, corteDeAnonimizacion, forbidden, isoDate, mesesDeConservacion,
  motivoDeAnonimizacionPorLista, notFound, periodoDeConservacion, rostroSeBorraEl, tocaBorrarRostro, validation,
  type MotivoDeSaltoDeConservacion,
} from '@gymflow/core';
import type { PrivacyBatch, PrivacyBatchSummary, PrivacyConservation } from '@gymflow/core/contracts';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { systemContext } from '../../platform/jobs/types.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import type { RequestContext } from '../../platform/context.js';
import { EnrollmentService, FaceTemplateRepository } from '../access/index.js';
import { ApprovalService } from '../approvals/index.js';
import { AuthUserRepository, PushService, UserRepository } from '../identity/index.js';
import { OrganizationRepository } from '../organization/index.js';
import { ConservacionRepository, type ExsocioRecord, type ListaRecord, type RenglonRecord } from './conservacion.repository.js';
import { PrivacyService } from './privacy.service.js';

const DIA_MS = 86_400_000;
/** Un id que no es de nadie: para pedir «todo el personal activo» a quien pide «todos menos este». */
const NADIE = '00000000-0000-0000-0000-000000000000';

/** Cuántos exsocios se anonimizan dentro de la petición de la firma; el resto lo termina el cierre de esa noche. */
export const ANONIMIZAR_AL_FIRMAR = 100;

export type ErrorDePasada = { entityId: string; error: string };

/** Lo que hizo una pasada del cierre diario. */
export type PasadaDeConservacion = {
  /** `true` solo la primera vez: se fijó el día de arranque y no se borró nada. */
  arranco: boolean;
  rostrosBorrados: number;
  rostrosEnEspera: number;
  /** El mes de la lista que se armó en esta pasada, o null. */
  listaArmada: string | null;
  /** Anonimizados en esta pasada al amparo de una lista ya firmada (lo que una ejecución dejó a medias). */
  anonimizados: number;
  errores: ErrorDePasada[];
};

/** Lo que haría la pasada de hoy en un gimnasio, sin tocar nada. */
export type VistaPreviaDeConservacion = {
  hoy: string;
  /** El día de arranque ya fijado, o null si la primera pasada todavía no corre (lo fijaría en `hoy`). */
  arranque: string | null;
  meses: number;
  /** Entra a la lista quien se dio de baja este día o antes. */
  corte: string;
  /** Rostros de exsocios guardados: cuándo se borra cada uno y si la pasada de hoy ya lo borraría. */
  rostros: Array<{ memberCode: string; bajaEl: string; seBorraEl: string; hoy: boolean }>;
  /** La lista del mes: si ya existe no se arma otra; si no, quién entraría. Ninguno se anonimiza sin firma. */
  lista: { periodo: string; yaExiste: boolean; enEspera: string | null; exsocios: Array<{ memberCode: string; bajaEl: string }> };
};

const texto = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * CONSERVACIÓN DE DATOS (D-32, opción a; auditoría 8, fase 3, bloque 3.9).
 *
 *  · ROSTRO. Deja de reconocerse el día de la baja (el padrón de la cámara
 *    solo trae socios vigentes: `FaceTemplateRepository.padron`). Aquí se
 *    BORRA a los 30 días de la baja si no regresó. Si regresó antes, su
 *    enrolamiento sigue vivo y vuelve a reconocerse sin registrarlo otra vez.
 *  · LO DEMÁS. A los 24 meses de la baja (o el plazo del gimnasio) el exsocio
 *    entra a la lista del mes. La lista NO borra: la firma el dueño, una vez,
 *    y solo entonces se anonimiza a cada uno (y con ello su rostro, en el acto).
 *
 * Todo se puede correr dos veces sin daño: el rostro ya borrado no vuelve a
 * salir, hay una lista por mes, y un renglón resuelto no se vuelve a tocar.
 *
 * LA PRIMERA PASADA en un gimnasio no borra nada: fija el día de arranque.
 * A quien ya llevaba más de 30 días de baja, los 30 días le cuentan desde
 * ese día (`rostroSeBorraEl`), y la lista del mes se arma pero espera firma.
 */
export class ConservacionService {
  private readonly audit = new AuditService();

  // ── El cierre diario ──────────────────────────────────────────────────────

  async pasada(organizationId: string, ahora: Date = new Date()): Promise<PasadaDeConservacion> {
    const repo = new ConservacionRepository(organizationId);
    const salida: PasadaDeConservacion = { arranco: false, rostrosBorrados: 0, rostrosEnEspera: 0, listaArmada: null, anonimizados: 0, errores: [] };
    const hoy = (await new BusinessCalendar(organizationId).dias(ahora)).cierre;

    if (await repo.fijarArranque(hoy)) {
      salida.arranco = true;
      const enEspera = await new FaceTemplateRepository(organizationId).deExsocios();
      await this.audit.record(systemContext(organizationId), {
        action: 'privacy.conservation.start', resourceType: 'Organization', resourceId: organizationId,
        afterState: { startedOn: isoDate(hoy), facesWaiting: enEspera.length, faceDaysAfterArchive: CONSERVACION.rostroDiasTrasLaBaja },
      });
    }

    const rostros = await this.borrarRostrosVencidos(organizationId, ahora);
    salida.rostrosBorrados = rostros.borrados;
    salida.rostrosEnEspera = rostros.enEspera;
    salida.errores.push(...rostros.errores);

    // Lo que una lista firmada dejó a medias se termina ANTES de armar la del mes: así no vuelve a listarse.
    for (const lista of await repo.firmadasConPendientes()) {
      const r = await this.ejecutar(organizationId, lista, ahora, null);
      salida.anonimizados += r.anonimizados;
      salida.errores.push(...r.errores);
    }

    try {
      const lista = await this.prepararLista(organizationId, ahora);
      salida.listaArmada = lista?.period ?? null;
    } catch (e) {
      salida.errores.push({ entityId: 'lista', error: texto(e) });
    }
    return salida;
  }

  // ── El rostro ─────────────────────────────────────────────────────────────

  /**
   * Borra la plantilla de quien lleva 30 días de baja sin regresar, revocando
   * su enrolamiento (deja bitácora como acción del sistema y retira el permiso
   * biométrico de quien se queda sin rostro ni huella). Sin día de arranque no
   * borra nada: lo fija `pasada`. Cada rostro va en su propia unidad.
   */
  async borrarRostrosVencidos(organizationId: string, ahora: Date = new Date()): Promise<{ borrados: number; enEspera: number; errores: ErrorDePasada[] }> {
    const arranque = await new ConservacionRepository(organizationId).arranque();
    const plantillas = await new FaceTemplateRepository(organizationId).deExsocios();
    const salida = { borrados: 0, enEspera: 0, errores: [] as ErrorDePasada[] };
    if (!arranque) return { ...salida, enEspera: plantillas.length };

    const dias = this.diasDeSede(organizationId, ahora);
    const enrolamientos = new EnrollmentService();
    const ctx = systemContext(organizationId);
    for (const p of plantillas) {
      const { hoy, diaDe } = await dias(p.sedeDelSocio);
      if (!tocaBorrarRostro(diaDe(p.bajaEl), hoy, arranque)) { salida.enEspera += 1; continue; }
      try {
        await enUnaTransaccion(() => enrolamientos.revoke(ctx, p.enrollmentId, MOTIVO_ROSTRO_TRAS_LA_BAJA));
        salida.borrados += 1;
      } catch (e) {
        // Si otra pasada lo revocó en este instante ya no hay nada que borrar: no es un error.
        if (e instanceof DomainError && e.code === 'CONFLICT') continue;
        salida.errores.push({ entityId: p.enrollmentId, error: texto(e) });
      }
    }
    return salida;
  }

  // ── La lista del mes ──────────────────────────────────────────────────────

  /**
   * Arma la lista del mes si no existe y hay a quién listar. Una lista
   * anterior que nadie firmó se cierra como reemplazada (no borró nada) y sus
   * exsocios pasan a la nueva si siguen cumpliendo. Devuelve la lista que
   * armó, o null si no armó ninguna.
   */
  async prepararLista(organizationId: string, ahora: Date = new Date()): Promise<ListaRecord | null> {
    const repo = new ConservacionRepository(organizationId);
    const hoy = (await new BusinessCalendar(organizationId).dias(ahora)).cierre;
    const period = periodoDeConservacion(hoy);
    if (await repo.delPeriodo(period)) return null;

    const meses = await this.meses(organizationId);
    const candidatos = await this.cumplenElPlazo(organizationId, meses, ahora);
    const anterior = await repo.pendiente();
    if (candidatos.length === 0 && !anterior) return null;

    const ctx = systemContext(organizationId);
    const cutoffOn = corteDeAnonimizacion(hoy, meses);
    try {
      const armada = await enUnaTransaccion(async () => {
        const reemplazada = anterior ? await repo.reemplazar(anterior.id, ahora) : false;
        const lista = candidatos.length === 0 ? null : await repo.crear({
          period, monthsAfterArchive: meses, cutoffOn, preparedAt: ahora,
          renglones: candidatos.map((c) => ({ memberId: c.exsocio.id, memberCode: c.exsocio.memberCode, archivedAt: c.exsocio.deletedAt!, archivedOn: c.bajaEl })),
        });
        // La bitácora, al final de la unidad.
        if (reemplazada) {
          await this.audit.record(ctx, {
            action: 'privacy.batch.replace', resourceType: 'PrivacyBatch', resourceId: anterior!.id,
            afterState: { period: anterior!.period, replacedBy: lista?.period ?? null },
          });
        }
        if (lista) {
          await this.audit.record(ctx, {
            action: 'privacy.batch.prepare', resourceType: 'PrivacyBatch', resourceId: lista.id,
            afterState: { period, listed: candidatos.length, monthsAfterArchive: meses, cutoffOn: isoDate(cutoffOn) },
          });
        }
        return lista;
      });
      if (armada) await this.avisarAQuienFirma(organizationId, armada.period, candidatos.length);
      return armada;
    } catch (e) {
      // Dos pasadas a la vez: la base admite una lista por mes y una sola en espera. La otra ya la armó.
      if (String(e).includes('Unique constraint') || String(e).includes('privacy_batches_')) return null;
      throw e;
    }
  }

  /**
   * La firma del dueño: UNA por lista. Con su sesión (quién es) y su
   * contraseña (que está ahí), por la misma escalera de fallos de las demás
   * firmas. Después se anonimiza a cada exsocio de la lista, volviendo a
   * comprobar a cada uno; si son muchos, el cierre de esa noche termina.
   */
  async firmar(ctx: RequestContext, batchId: string, password: string, ahora: Date = new Date()): Promise<PrivacyBatch> {
    const orgId = ctx.tenant.organizationId;
    const yo = ctx.tenant.actorUserId;
    if (!yo) throw new DomainError('UNAUTHENTICATED', 'Sesión requerida');
    const repo = new ConservacionRepository(orgId);
    const lista = await repo.porId(batchId);
    if (!lista) throw notFound('Lista no encontrada');
    if (lista.status === 'SIGNED') throw conflict('Esa lista ya está firmada');
    if (lista.status !== 'PENDING') throw conflict('Esa lista ya no espera firma: la reemplazó la de un mes más reciente');
    const enLista = (await repo.renglones(batchId)).filter((r) => r.status === 'LISTED').length;
    if (enLista === 0) throw conflict('No queda nadie en la lista: no hay nada que firmar');

    const perfil = await new AuthUserRepository().findById(yo);
    if (!perfil || !perfil.isActive || perfil.organizationId !== orgId) throw new DomainError('UNAUTHENTICATED', 'Sesión requerida');
    const firmas = new ApprovalService();
    await firmas.comprobarContrasena(ctx, perfil, password, { branchId: null }, {
      canal: 'telefono',
      asentarFallo: async (f) => {
        if (f.causa !== 'CONTRASENA') return;
        await this.audit.record(ctx, {
          action: 'privacy.batch.sign.fail', resourceType: 'PrivacyBatch', resourceId: batchId,
          afterState: { period: lista.period, failedCount: f.failedCount ?? null, ...(f.pausedUntil ? { pausedUntil: f.pausedUntil.toISOString() } : {}) },
        });
      },
    });
    firmas.requireFirmaVigente(perfil);
    // La lista es de todo el gimnasio: la firma quien da la segunda firma de anonimizar, sin acotar a una sede.
    if (!(await firmas.puedeFirmar(orgId, yo, 'members:anonymize', { branchId: null }))) {
      throw forbidden('La lista de exsocios por anonimizar la firma el dueño del gimnasio');
    }

    await enUnaTransaccion(async () => {
      if (!await repo.firmar(batchId, yo, ahora)) throw conflict('Otra persona ya firmó esta lista, o dejó de estar en espera');
      await this.audit.record(ctx, {
        action: 'privacy.batch.sign', resourceType: 'PrivacyBatch', resourceId: batchId,
        afterState: { period: lista.period, listed: enLista, monthsAfterArchive: lista.monthsAfterArchive, cutoffOn: isoDate(lista.cutoffOn) },
      });
    });
    const firmada = (await repo.porId(batchId))!;
    await this.ejecutar(orgId, firmada, ahora, ANONIMIZAR_AL_FIRMAR);
    return this.detalle(orgId, (await repo.porId(batchId))!);
  }

  /** La gerencia saca a alguien de la lista en espera, con motivo. Sigue de baja y vuelve a salir en la del mes siguiente. */
  async sacar(ctx: RequestContext, batchId: string, memberId: string, motivo: string): Promise<void> {
    if (motivo.trim().length < 3) throw validation('Falta el motivo para sacarlo de la lista');
    const orgId = ctx.tenant.organizationId;
    const repo = new ConservacionRepository(orgId);
    const lista = await repo.porId(batchId);
    if (!lista) throw notFound('Lista no encontrada');
    if (lista.status !== 'PENDING') throw conflict('Esa lista ya no espera firma: no se le puede sacar a nadie');
    const renglon = await repo.renglon(batchId, memberId);
    if (!renglon) throw notFound('Ese exsocio no está en la lista');
    const exsocio = (await repo.exsocios([memberId])).get(memberId) ?? null;
    await enUnaTransaccion(async () => {
      const hecho = await repo.resolver(renglon.id, { status: 'EXCLUDED', note: motivo.trim(), cuando: new Date(), userId: ctx.tenant.actorUserId ?? null });
      if (!hecho) throw conflict('Ese exsocio ya no estaba en la lista');
      await this.audit.record(ctx, {
        action: 'privacy.batch.exclude', resourceType: 'Member', resourceId: memberId, branchId: exsocio?.homeBranchId ?? null, reason: motivo.trim(),
        afterState: { batchId, period: lista.period, memberCode: renglon.memberCode },
      });
    });
  }

  /**
   * Anonimiza a quienes siguen en una lista FIRMADA. Antes de tocar a cada
   * uno se vuelve a comprobar, porque entre la lista y la firma pasan días:
   *  · ya anonimizado (por una solicitud ARCO, por ejemplo) → no se toca;
   *  · regresó, o regresó y se volvió a ir (su baja ya es otra) → no se toca;
   *  · el gimnasio alargó el plazo y ya no lo cumple → no se toca.
   * Cada exsocio va en su propia unidad: si uno falla, sigue en la lista y lo
   * reintenta el cierre de la noche; los demás no se detienen.
   */
  private async ejecutar(organizationId: string, lista: ListaRecord, ahora: Date, tope: number | null): Promise<{ anonimizados: number; errores: ErrorDePasada[] }> {
    const salida = { anonimizados: 0, errores: [] as ErrorDePasada[] };
    if (lista.status !== 'SIGNED' || !lista.signedByUserId) return salida;
    const repo = new ConservacionRepository(organizationId);
    const porHacer = (await repo.renglones(lista.id)).filter((r) => r.status === 'LISTED');
    const exsocios = await repo.exsocios(porHacer.map((r) => r.memberId));
    const meses = await this.meses(organizationId);
    const dias = this.diasDeSede(organizationId, ahora);
    const ctx = systemContext(organizationId);
    const privacidad = new PrivacyService();
    const motivo = motivoDeAnonimizacionPorLista(lista.period, lista.monthsAfterArchive);

    let hechos = 0;
    for (const r of porHacer) {
      if (tope !== null && hechos >= tope) break;
      try {
        const salto = await this.porQueNo(r, exsocios.get(r.memberId) ?? null, meses, dias);
        if (salto) {
          await repo.resolver(r.id, { status: 'SKIPPED', note: salto, cuando: ahora, userId: null });
          continue;
        }
        await enUnaTransaccion(async () => {
          await privacidad.anonymize(ctx, r.memberId, motivo, lista.signedByUserId);
          await repo.resolver(r.id, { status: 'ANONYMIZED', note: null, cuando: ahora, userId: lista.signedByUserId });
        });
        salida.anonimizados += 1;
        hechos += 1;
      } catch (e) {
        salida.errores.push({ entityId: r.memberId, error: texto(e) });
      }
    }
    await repo.cerrarSiTermino(lista.id, ahora);
    return salida;
  }

  private async porQueNo(
    r: RenglonRecord, exsocio: ExsocioRecord | null, meses: number,
    dias: (sede: string | null) => Promise<{ hoy: Date; diaDe: (instante: Date) => Date }>,
  ): Promise<MotivoDeSaltoDeConservacion | null> {
    if (!exsocio || exsocio.anonymizedAt) return 'ALREADY_ANONYMIZED';
    if (!exsocio.deletedAt || exsocio.deletedAt.getTime() !== r.archivedAt.getTime()) return 'RETURNED';
    const { hoy, diaDe } = await dias(exsocio.homeBranchId);
    if (diaDe(exsocio.deletedAt).getTime() > corteDeAnonimizacion(hoy, meses).getTime()) return 'NOT_DUE';
    return null;
  }

  // ── Antes de la primera pasada ────────────────────────────────────────────

  /**
   * QUÉ HARÍA la pasada de hoy, sin tocar nada (ni fija el arranque ni
   * escribe en la bitácora). Es lo que se mira en una base ya en uso antes
   * de dejar correr el cierre diario por primera vez
   * (`scripts/conservacion-estado.ts`). Códigos de socio, no nombres.
   */
  async vistaPrevia(organizationId: string, ahora: Date = new Date()): Promise<VistaPreviaDeConservacion> {
    const repo = new ConservacionRepository(organizationId);
    const hoy = (await new BusinessCalendar(organizationId).dias(ahora)).cierre;
    const arranqueGuardado = await repo.arranque();
    const arranque = arranqueGuardado ?? hoy;
    const meses = await this.meses(organizationId);
    const dias = this.diasDeSede(organizationId, ahora);

    const plantillas = await new FaceTemplateRepository(organizationId).deExsocios();
    const codigos = await repo.exsocios(plantillas.map((p) => p.memberId));
    const rostros: VistaPreviaDeConservacion['rostros'] = [];
    for (const p of plantillas) {
      const { hoy: hoyDeSede, diaDe } = await dias(p.sedeDelSocio);
      const bajaEl = diaDe(p.bajaEl);
      rostros.push({
        memberCode: codigos.get(p.memberId)?.memberCode ?? p.memberId, bajaEl: isoDate(bajaEl),
        seBorraEl: isoDate(rostroSeBorraEl(bajaEl, arranque)), hoy: tocaBorrarRostro(bajaEl, hoyDeSede, arranque),
      });
    }
    const period = periodoDeConservacion(hoy);
    const [delMes, pendiente, candidatos] = await Promise.all([repo.delPeriodo(period), repo.pendiente(), this.cumplenElPlazo(organizationId, meses, ahora)]);
    return {
      hoy: isoDate(hoy), arranque: arranqueGuardado ? isoDate(arranqueGuardado) : null, meses, corte: isoDate(corteDeAnonimizacion(hoy, meses)),
      rostros,
      lista: {
        periodo: period, yaExiste: delMes !== null, enEspera: pendiente ? pendiente.period : null,
        exsocios: candidatos.map((c) => ({ memberCode: c.exsocio.memberCode, bajaEl: isoDate(c.bajaEl) })),
      },
    };
  }

  // ── Lo que ve la pantalla ─────────────────────────────────────────────────

  async estado(organizationId: string, puede: { firmar: boolean; sacar: boolean }, ahora: Date = new Date()): Promise<PrivacyConservation> {
    const repo = new ConservacionRepository(organizationId);
    const [{ monthsAfterArchive }, arranque, plantillas, pendiente, resueltas] = await Promise.all([
      new OrganizationRepository(organizationId).privacySettings(), repo.arranque(),
      new FaceTemplateRepository(organizationId).deExsocios(), repo.pendiente(), repo.resueltas(CONSERVACION.listasEnLaHistoria),
    ]);
    // Sin arranque todavía no corre ningún plazo: se dice cuántos hay, no una fecha que no es cierta.
    let proximo: Date | null = null;
    if (arranque) {
      const dias = this.diasDeSede(organizationId, ahora);
      for (const p of plantillas) {
        const { diaDe } = await dias(p.sedeDelSocio);
        const toca = rostroSeBorraEl(diaDe(p.bajaEl), arranque);
        if (!proximo || toca.getTime() < proximo.getTime()) proximo = toca;
      }
    }
    const resumenes = await this.resumenes(organizationId, resueltas);
    return {
      monthsAfterArchive: mesesDeConservacion(monthsAfterArchive),
      monthsIsDefault: monthsAfterArchive === null,
      faceDaysAfterArchive: CONSERVACION.rostroDiasTrasLaBaja,
      startedOn: arranque ? isoDate(arranque) : null,
      faces: { waiting: plantillas.length, nextDeletionOn: proximo ? isoDate(proximo) : null },
      batch: pendiente ? await this.detalle(organizationId, pendiente) : null,
      canSign: puede.firmar, canExclude: puede.sacar,
      history: resumenes,
    };
  }

  async detalle(organizationId: string, lista: ListaRecord): Promise<PrivacyBatch> {
    const repo = new ConservacionRepository(organizationId);
    const [resumen] = await this.resumenes(organizationId, [lista]);
    const renglones = await repo.renglones(lista.id);
    const exsocios = await repo.exsocios(renglones.map((r) => r.memberId));
    return {
      ...resumen!,
      items: renglones.map((r) => {
        const m = exsocios.get(r.memberId) ?? null;
        return {
          memberId: r.memberId, memberCode: r.memberCode,
          fullName: m && !m.anonymizedAt ? `${m.firstName} ${m.lastName}` : null,
          homeBranchId: m?.homeBranchId ?? null, archivedOn: isoDate(r.archivedOn), status: r.status, note: r.note,
        };
      }),
    };
  }

  private async resumenes(organizationId: string, listas: readonly ListaRecord[]): Promise<PrivacyBatchSummary[]> {
    if (listas.length === 0) return [];
    const [conteos, nombres] = await Promise.all([
      new ConservacionRepository(organizationId).conteos(listas.map((l) => l.id)),
      new UserRepository(organizationId).namesById(listas.flatMap((l) => (l.signedByUserId ? [l.signedByUserId] : []))),
    ]);
    return listas.map((l) => {
      const c = conteos.get(l.id)!;
      return {
        id: l.id, period: l.period, status: l.status, monthsAfterArchive: l.monthsAfterArchive, cutoffOn: isoDate(l.cutoffOn),
        preparedAt: l.preparedAt.toISOString(), signedAt: l.signedAt?.toISOString() ?? null,
        signedByName: l.signedByUserId ? nombres.get(l.signedByUserId) ?? null : null,
        counts: { listed: c.LISTED, anonymized: c.ANONYMIZED, excluded: c.EXCLUDED, skipped: c.SKIPPED },
      };
    });
  }

  // ── Piezas ────────────────────────────────────────────────────────────────

  /**
   * Aviso al teléfono de quien firma (si tiene los avisos encendidos): nació
   * la lista del mes. Sin nombres. Nunca lanza: un aviso que no sale no tira
   * el cierre; la lista se ve igual en Autorizaciones.
   */
  private async avisarAQuienFirma(organizationId: string, period: string, cuantos: number): Promise<void> {
    try {
      const firmas = new ApprovalService();
      const firmantes: string[] = [];
      for (const u of await new UserRepository(organizationId).activeExcept(NADIE)) {
        if (await firmas.puedeFirmar(organizationId, u.id, 'members:anonymize', { branchId: null })) firmantes.push(u.id);
      }
      if (firmantes.length === 0) return;
      await new PushService().sendToUsers(organizationId, firmantes, {
        title: 'Lista de exsocios por anonimizar',
        body: `${cuantos === 1 ? 'Un exsocio cumplió' : `${cuantos} exsocios cumplieron`} el plazo de conservación. Revisa la lista y fírmala: sin tu firma no se borra nada.`,
        url: '/autorizaciones', tag: `conservacion-${period}`,
      });
    } catch { /* el aviso es un extra: la lista ya quedó armada */ }
  }

  /** El plazo que rige en el gimnasio: el suyo o, sin él, el de por omisión (24 meses). */
  async meses(organizationId: string): Promise<number> {
    return mesesDeConservacion((await new OrganizationRepository(organizationId).privacySettings()).monthsAfterArchive);
  }

  /** Exsocios con nombre cuya baja ya cumplió el plazo, contando con el día de SU sede. */
  private async cumplenElPlazo(organizationId: string, meses: number, ahora: Date): Promise<Array<{ exsocio: ExsocioRecord; bajaEl: Date }>> {
    const hoyMasTardio = businessDateIn('Pacific/Kiritimati', ahora);
    // Filtro grueso por instante (dos días de holgura por las zonas); el fino, con el día de cada sede.
    const antesDe = new Date(corteDeAnonimizacion(hoyMasTardio, meses).getTime() + 2 * DIA_MS);
    const dias = this.diasDeSede(organizationId, ahora);
    const salida: Array<{ exsocio: ExsocioRecord; bajaEl: Date }> = [];
    for (const exsocio of await new ConservacionRepository(organizationId).exsociosDeBajaAntesDe(antesDe)) {
      const { hoy, diaDe } = await dias(exsocio.homeBranchId);
      const bajaEl = diaDe(exsocio.deletedAt!);
      if (bajaEl.getTime() <= corteDeAnonimizacion(hoy, meses).getTime()) salida.push({ exsocio, bajaEl });
    }
    return salida;
  }

  /** El «hoy» de una sede y cómo pasar un instante a día de esa sede; una lectura de zona por sede. */
  private diasDeSede(organizationId: string, ahora: Date): (sede: string | null) => Promise<{ hoy: Date; diaDe: (instante: Date) => Date }> {
    const calendario = new BusinessCalendar(organizationId);
    const vistas = new Map<string, { hoy: Date; diaDe: (instante: Date) => Date }>();
    return async (sede) => {
      const clave = sede ?? '';
      const vista = vistas.get(clave);
      if (vista) return vista;
      const zona = await calendario.timezoneFor(sede);
      const nueva = { hoy: businessDateIn(zona, ahora), diaDe: (instante: Date) => businessDateIn(zona, instante) };
      vistas.set(clave, nueva);
      return nueva;
    };
  }
}
