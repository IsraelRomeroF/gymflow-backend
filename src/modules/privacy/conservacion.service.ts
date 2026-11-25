import {
  CONSERVACION, DomainError, MOTIVO_ROSTRO_BIOMETRIA_APAGADA, MOTIVO_ROSTRO_TRAS_LA_BAJA, businessDateIn, conflict, corteDeAnonimizacion, forbidden, isoDate, mesesDeConservacion,
  motivoDeAnonimizacionPorLista, notFound, periodoDeConservacion, validation,
  arranqueDeLaBaja, rostroSeBorraEl, sumarMeses, type CausaDeBaja, type MotivoDeSaltoDeConservacion,
} from '@gymflow/core';
import type { MemberConservation, PrivacyBatch, PrivacyBatchSummary, PrivacyConservation } from '@gymflow/core/contracts';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enUnaTransaccion } from '../../platform/db/unit-of-work.js';
import { systemContext } from '../../platform/jobs/types.js';
import { BusinessCalendar } from '../../platform/time/business-calendar.js';
import type { RequestContext } from '../../platform/context.js';
import { ModuleStateRepository } from '../../platform/modules/module-state.repository.js';
import { EnrollmentService, FaceTemplateRepository, rostrosQueBorraApagar } from '../access/index.js';
import { ApprovalService } from '../approvals/index.js';
import { AuthUserRepository, PushService, UserRepository } from '../identity/index.js';
import { OrganizationRepository } from '../organization/index.js';
import { MemberRepository } from '../members/index.js';
import { ConservacionRepository, type ExsocioRecord, type ListaRecord, type RenglonRecord } from './conservacion.repository.js';
import { BajaParaConservarRepository, BajasParaConservar } from './baja-para-conservar.js';
import { PrivacyService } from './privacy.service.js';

const DIA_MS = 86_400_000;
/** Un id que no es de nadie: para pedir «todo el personal activo» a quien pide «todos menos este». */
const NADIE = '00000000-0000-0000-0000-000000000000';

/** Cuántos exsocios se anonimizan dentro de la petición de la firma; el resto lo termina el cierre de esa noche. */
export const ANONIMIZAR_AL_FIRMAR = 100;

/** Cuántos rostros por borrar enseña la tarjeta, del más próximo al más lejano (la cifra total va aparte). */
const ROSTROS_EN_PANTALLA = 200;

export type ErrorDePasada = { entityId: string; error: string };

/** Quién entra a la lista del mes: el dado de baja en su ficha (3.9) o el de la baja calculada (P-01, 4.18). */
type Candidato = { memberId: string; memberCode: string; archivedAt: Date; archivedOn: Date; cause: CausaDeBaja };

const medianoche = (dia: string) => new Date(`${dia}T00:00:00.000Z`);

/** Lo que hizo una pasada del cierre diario. */
export type PasadaDeConservacion = {
  /** `true` solo la primera vez: se fijó el día de arranque y no se borró nada. */
  arranco: boolean;
  rostrosBorrados: number;
  rostrosEnEspera: number;
  /** De `rostrosBorrados`, los que se borraron porque Biometría lleva 30 días apagada con aviso (3.12). */
  rostrosPorBiometriaApagada: number;
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
  /** P-01 (4.18): el arranque de la baja calculada, o null si la primera pasada con 4.18 todavía no corre (lo fijaría en `hoy`). */
  arranqueCalculada: string | null;
  /** El plazo de baja del gimnasio (D-18), con el que también se mide la visita «reciente». */
  churnDays: number;
  meses: number;
  /** Entra a la lista quien se dio de baja este día o antes. */
  corte: string;
  /** Rostros de exsocios guardados: cuándo se borra cada uno y si la pasada de hoy ya lo borraría. */
  rostros: Array<{ memberCode: string; causa: CausaDeBaja; bajaEl: string; seBorraEl: string; hoy: boolean }>;
  /** Con rostro guardado, baja para D-18 pero exceptuados (siguen viniendo o tienen paquete): NO se tocan. */
  exceptuados: Array<{ memberCode: string; causa: CausaDeBaja; porque: string; contaraDesde: string | null }>;
  /** La lista del mes: si ya existe no se arma otra; si no, quién entraría. Ninguno se anonimiza sin firma. */
  lista: { periodo: string; yaExiste: boolean; enEspera: string | null; exsocios: Array<{ memberCode: string; causa: CausaDeBaja; bajaEl: string }> };
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
 *
 * P-01 (Israel 2026-11-25; fase 4, bloque 4.18): «baja» ya no es solo el acto
 * de la ficha. Cuenta también la baja calculada de D-18 (canceló, o terminó
 * hace el plazo del gimnasio sin renovar), salvo quien sigue viniendo sin
 * membresía (`bajaParaConservar`, `baja-para-conservar.ts`). Esa regla tiene
 * su propio arranque (`privacy_calculated_baja_starts`): a quien ya era baja
 * calculada el día en que se activa, los 30 días le cuentan desde ahí. Su
 * rostro se sigue reconociendo hasta borrarse (no se tocó el padrón de la
 * cámara: la puerta le niega la entrada por no tener plan, como antes); al
 * firmarse la lista se le da de baja en su ficha y se anonimiza en el acto.
 */
export class ConservacionService {
  private readonly audit = new AuditService();

  // ── El cierre diario ──────────────────────────────────────────────────────

  async pasada(organizationId: string, ahora: Date = new Date()): Promise<PasadaDeConservacion> {
    const repo = new ConservacionRepository(organizationId);
    const salida: PasadaDeConservacion = { arranco: false, rostrosBorrados: 0, rostrosEnEspera: 0, rostrosPorBiometriaApagada: 0, listaArmada: null, anonimizados: 0, errores: [] };
    const hoy = (await new BusinessCalendar(organizationId).dias(ahora)).cierre;

    if (await repo.fijarArranque(hoy)) {
      salida.arranco = true;
      const enEspera = await new FaceTemplateRepository(organizationId).deExsocios();
      await this.audit.record(systemContext(organizationId), {
        action: 'privacy.conservation.start', resourceType: 'Organization', resourceId: organizationId,
        afterState: { startedOn: isoDate(hoy), facesWaiting: enEspera.length, faceDaysAfterArchive: CONSERVACION.rostroDiasTrasLaBaja },
      });
    }

    // P-01 (4.18): la baja calculada empieza a contar el día en que corre por primera vez este código (arranque suave).
    const bajas = new BajaParaConservarRepository(organizationId);
    if (await bajas.fijarArranqueCalculada(hoy)) {
      salida.arranco = true;
      const calculadas = await new BajasParaConservar(organizationId, ahora).calculadas();
      const rostros = (await new BajasParaConservar(organizationId, ahora).rostros({ ficha: await repo.arranque(), calculada: hoy })).filter((r) => r.cause !== 'ARCHIVED');
      await this.audit.record(systemContext(organizationId), {
        action: 'privacy.conservation.calculated.start', resourceType: 'Organization', resourceId: organizationId,
        afterState: {
          startedOn: isoDate(hoy), calculatedBajas: calculadas.length, facesWaiting: rostros.length,
          faceDaysAfterArchive: CONSERVACION.rostroDiasTrasLaBaja, churnDays: await new BajasParaConservar(organizationId, ahora).churnDays(),
        },
      });
    }

    const rostros = await this.borrarRostrosVencidos(organizationId, ahora);
    salida.rostrosBorrados = rostros.borrados;
    salida.rostrosEnEspera = rostros.enEspera;
    salida.errores.push(...rostros.errores);

    // Biometría apagada con aviso hace 30 días (D-32, paréntesis; 3.12).
    const apagada = await this.borrarRostrosDeBiometriaApagada(organizationId, ahora);
    salida.rostrosBorrados += apagada.borrados;
    salida.rostrosPorBiometriaApagada = apagada.borrados;
    salida.rostrosEnEspera += apagada.enEspera;
    salida.errores.push(...apagada.errores);

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
    const salida = { borrados: 0, enEspera: 0, errores: [] as ErrorDePasada[] };
    // P-01 (4.18): los de la baja calculada también; cada clase de baja con su arranque. Sin arranque no se borra nada.
    const rostros = await new BajasParaConservar(organizationId, ahora).rostros(await this.arranques(organizationId));
    const enrolamientos = new EnrollmentService();
    const ctx = systemContext(organizationId);
    for (const p of rostros) {
      if (!p.hoyToca) { salida.enEspera += 1; continue; }
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

  /** Los dos arranques del gimnasio: el del acto de la ficha (3.9) y el de la baja calculada (4.18). */
  async arranques(organizationId: string): Promise<{ ficha: Date | null; calculada: Date | null }> {
    const [ficha, calculada] = await Promise.all([new ConservacionRepository(organizationId).arranque(), new BajaParaConservarRepository(organizationId).arranqueCalculada()]);
    return { ficha, calculada };
  }

  /**
   * BIOMETRÍA APAGADA (D-32: «igual si se apaga Biometría, con aviso»; 3.12).
   * Borra los rostros de un gimnasio o de una sucursal cuando el módulo lleva
   * apagado el plazo Y quien lo apagó confirmó el aviso con el número de
   * rostros: ese día quedó anotada la fecha (`erasureOn`). Sin esa fecha no se
   * borra nada: un módulo apagado antes de que existiera el aviso, o apagado
   * por no estar contratado, no entra aquí. Encenderlo otra vez quita la fecha.
   *
   * Idempotente: lo ya borrado no vuelve a salir, y cada rostro va en su unidad.
   */
  async borrarRostrosDeBiometriaApagada(organizationId: string, ahora: Date = new Date()): Promise<{ borrados: number; enEspera: number; errores: ErrorDePasada[] }> {
    const salida = { borrados: 0, enEspera: 0, errores: [] as ErrorDePasada[] };
    const avisados = await new ModuleStateRepository(organizationId).borradosAvisados('biometrics');
    if (avisados.length === 0) return salida;

    const dias = this.diasDeSede(organizationId, ahora);
    const enrolamientos = new EnrollmentService();
    const ctx = systemContext(organizationId);
    const vistos = new Set<string>();
    // Primero lo que ya toca: si un rostro cae en dos avisos (su sucursal y todo el gimnasio), manda el que vence antes.
    for (const a of [...avisados].sort((x, y) => x.erasureOn.getTime() - y.erasureOn.getTime())) {
      const { hoy } = await dias(a.branchId);
      const toca = hoy.getTime() >= a.erasureOn.getTime();
      for (const p of await rostrosQueBorraApagar(organizationId, a.branchId)) {
        if (vistos.has(p.enrollmentId)) continue;
        vistos.add(p.enrollmentId);
        if (!toca) { salida.enEspera += 1; continue; }
        try {
          await enUnaTransaccion(() => enrolamientos.revoke(ctx, p.enrollmentId, MOTIVO_ROSTRO_BIOMETRIA_APAGADA));
          salida.borrados += 1;
        } catch (e) {
          if (e instanceof DomainError && e.code === 'CONFLICT') continue;
          salida.errores.push({ entityId: p.enrollmentId, error: texto(e) });
        }
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
    const candidatos = await this.candidatos(organizationId, meses, ahora);
    const anterior = await repo.pendiente();
    if (candidatos.length === 0 && !anterior) return null;

    const ctx = systemContext(organizationId);
    const cutoffOn = corteDeAnonimizacion(hoy, meses);
    try {
      const armada = await enUnaTransaccion(async () => {
        const reemplazada = anterior ? await repo.reemplazar(anterior.id, ahora) : false;
        const lista = candidatos.length === 0 ? null : await repo.crear({
          period, monthsAfterArchive: meses, cutoffOn, preparedAt: ahora,
          renglones: candidatos.map((c) => ({ memberId: c.memberId, memberCode: c.memberCode, archivedAt: c.archivedAt, archivedOn: c.archivedOn, bajaCause: c.cause })),
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
            afterState: { period, listed: candidatos.length, calculated: candidatos.filter((c) => c.cause !== 'ARCHIVED').length, monthsAfterArchive: meses, cutoffOn: isoDate(cutoffOn) },
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
    const bajas = new BajasParaConservar(organizationId, ahora);
    const ctx = systemContext(organizationId);
    const privacidad = new PrivacyService();
    const motivo = motivoDeAnonimizacionPorLista(lista.period, lista.monthsAfterArchive);

    let hechos = 0;
    for (const r of porHacer) {
      if (tope !== null && hechos >= tope) break;
      try {
        const exsocio = exsocios.get(r.memberId) ?? null;
        const salto = r.bajaCause === 'ARCHIVED'
          ? await this.porQueNo(r, exsocio, meses, dias)
          : await this.porQueNoCalculada(r, exsocio, meses, bajas);
        if (salto) {
          await repo.resolver(r.id, { status: 'SKIPPED', note: salto, cuando: ahora, userId: null });
          continue;
        }
        await enUnaTransaccion(async () => {
          // P-01 (4.18): la baja calculada no pasó por «Dar de baja». Se le da de baja en su ficha en el
          // mismo acto (anonimizar exige la baja), como acción del sistema al amparo de la misma firma.
          if (r.bajaCause !== 'ARCHIVED') await this.darDeBajaPorLaLista(ctx, r, exsocio, lista, motivo);
          await privacidad.anonymize(ctx, r.memberId, motivo, lista.signedByUserId, ahora);
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

  /**
   * La misma comprobación para quien entró por la baja calculada (P-01):
   * se vuelve a calcular su baja hoy. Si renovó o volvió a venir, ya no es
   * baja (o es otra, más reciente): no se toca.
   */
  private async porQueNoCalculada(r: RenglonRecord, exsocio: ExsocioRecord | null, meses: number, bajas: BajasParaConservar): Promise<MotivoDeSaltoDeConservacion | null> {
    if (!exsocio || exsocio.anonymizedAt) return 'ALREADY_ANONYMIZED';
    // Lo dieron de baja en su ficha después de listarlo: esa baja es más reciente y cuenta desde ella.
    if (exsocio.deletedAt) return 'NOT_DUE';
    const s = (await bajas.de([r.memberId])).get(r.memberId);
    if (!s?.conservar?.cuenta || s.conservar.since !== isoDate(r.archivedOn)) return 'RETURNED';
    if (medianoche(s.conservar.since).getTime() > corteDeAnonimizacion(medianoche(s.hoy), meses).getTime()) return 'NOT_DUE';
    return null;
  }

  /** Da de baja en su ficha, como el sistema, a quien la lista firmada anonimiza por su baja calculada. */
  private async darDeBajaPorLaLista(ctx: RequestContext, r: RenglonRecord, exsocio: ExsocioRecord | null, lista: ListaRecord, motivo: string): Promise<void> {
    const members = new MemberRepository(ctx.tenant.organizationId);
    if (!await members.archive(r.memberId, lista.signedByUserId ?? '', motivo)) throw conflict('Ese socio ya estaba dado de baja');
    await this.audit.record(ctx, {
      action: 'member.archive', resourceType: 'Member', resourceId: r.memberId, branchId: exsocio?.homeBranchId ?? null,
      beforeState: { status: 'INACTIVE' }, afterState: { status: 'ARCHIVED', bajaCause: r.bajaCause, bajaOn: isoDate(r.archivedOn), batchId: lista.id },
      reason: `${motivo} (${r.bajaCause === 'CANCELED' ? 'canceló su membresía' : 'su membresía terminó y no renovó'})`, approvedByUserId: lista.signedByUserId,
    });
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
    const guardados = await this.arranques(organizationId);
    // Lo que fijaría la primera pasada: hoy.
    const arranques = { ficha: guardados.ficha ?? hoy, calculada: guardados.calculada ?? hoy };
    const meses = await this.meses(organizationId);
    const bajas = new BajasParaConservar(organizationId, ahora);

    const rostros = (await bajas.rostros(arranques)).map((p) => ({
      memberCode: p.memberCode, causa: p.cause, bajaEl: p.since, seBorraEl: p.seBorraEl!, hoy: p.hoyToca,
    }));
    const plantillas = await new FaceTemplateRepository(organizationId).guardadas();
    const exceptuados: VistaPreviaDeConservacion['exceptuados'] = [];
    for (const s of (await bajas.de(plantillas.map((p) => p.memberId))).values()) {
      if (s.conservar && !s.conservar.cuenta) exceptuados.push({ memberCode: s.memberCode, causa: s.conservar.cause, porque: s.conservar.porque, contaraDesde: s.conservar.contaraDesde });
    }
    const period = periodoDeConservacion(hoy);
    const [delMes, pendiente, candidatos] = await Promise.all([repo.delPeriodo(period), repo.pendiente(), this.candidatos(organizationId, meses, ahora)]);
    return {
      hoy: isoDate(hoy), arranque: guardados.ficha ? isoDate(guardados.ficha) : null,
      arranqueCalculada: guardados.calculada ? isoDate(guardados.calculada) : null, churnDays: await bajas.churnDays(),
      meses, corte: isoDate(corteDeAnonimizacion(hoy, meses)),
      rostros, exceptuados: exceptuados.sort((a, b) => a.memberCode.localeCompare(b.memberCode)),
      lista: {
        periodo: period, yaExiste: delMes !== null, enEspera: pendiente ? pendiente.period : null,
        exsocios: candidatos.map((c) => ({ memberCode: c.memberCode, causa: c.cause, bajaEl: isoDate(c.archivedOn) })),
      },
    };
  }

  // ── Lo que ve la pantalla ─────────────────────────────────────────────────

  async estado(organizationId: string, puede: { firmar: boolean; sacar: boolean }, ahora: Date = new Date()): Promise<PrivacyConservation> {
    const repo = new ConservacionRepository(organizationId);
    const bajas = new BajasParaConservar(organizationId, ahora);
    const [{ monthsAfterArchive }, arranques, pendiente, resueltas, churnDays] = await Promise.all([
      new OrganizationRepository(organizationId).privacySettings(), this.arranques(organizationId),
      repo.pendiente(), repo.resueltas(CONSERVACION.listasEnLaHistoria), bajas.churnDays(),
    ]);
    // P-01 (4.18): cuentan también los rostros de la baja calculada. Sin arranque todavía no corre ningún
    // plazo: se dice cuántos hay, no una fecha que no es cierta (`deletesOn` null).
    const rostros = await bajas.rostros(arranques);
    const proximo = rostros.map((r) => r.seBorraEl).filter((d): d is string => d !== null).sort()[0] ?? null;
    // Los nombres solo para la gerencia (la dueña ve cifras y códigos, ADR-039; los nombres los ve en la lista que firma).
    const fichas = puede.sacar ? await new BajaParaConservarRepository(organizationId).fichas(rostros.map((r) => r.memberId)) : new Map();
    const resumenes = await this.resumenes(organizationId, resueltas);
    return {
      monthsAfterArchive: mesesDeConservacion(monthsAfterArchive),
      monthsIsDefault: monthsAfterArchive === null,
      faceDaysAfterArchive: CONSERVACION.rostroDiasTrasLaBaja,
      startedOn: arranques.ficha ? isoDate(arranques.ficha) : null,
      calculatedStartedOn: arranques.calculada ? isoDate(arranques.calculada) : null,
      churnDays,
      faces: {
        waiting: rostros.length, nextDeletionOn: proximo,
        items: rostros.slice(0, ROSTROS_EN_PANTALLA).map((r) => ({
          memberId: r.memberId, memberCode: r.memberCode, fullName: fichas.get(r.memberId)?.fullName ?? null,
          cause: r.cause, since: r.since, deletesOn: r.seBorraEl,
        })),
      },
      batch: pendiente ? await this.detalle(organizationId, pendiente) : null,
      canSign: puede.firmar, canExclude: puede.sacar,
      history: resumenes,
    };
  }

  /**
   * Lo que la conservación hace con UN socio (P-01; `GET /members/:id/conservation`):
   * si su baja cuenta (o por qué todavía no), cuándo se borra su rostro y
   * desde cuándo entraría a la lista. Nada de esto escribe.
   */
  async deSocio(organizationId: string, memberId: string, ahora: Date = new Date()): Promise<MemberConservation> {
    const bajas = new BajasParaConservar(organizationId, ahora);
    const [s, guardado, arranques, meses] = await Promise.all([
      bajas.de([memberId]).then((m) => m.get(memberId) ?? null),
      new BajaParaConservarRepository(organizationId).rostroGuardado(memberId),
      this.arranques(organizationId), this.meses(organizationId),
    ]);
    const fichas = await new BajaParaConservarRepository(organizationId).fichas([memberId]);
    const hoy = s?.hoy ?? await bajas.hoyEn(fichas.get(memberId)?.homeBranchId ?? null);
    const c = s?.conservar ?? null;
    const cuenta = c?.cuenta ? c : null;
    const arranque = cuenta ? arranqueDeLaBaja(cuenta.cause, arranques) : null;
    return {
      memberId, asOf: hoy,
      baja: c ? {
        cause: c.cause, counts: c.cuenta, since: c.cuenta ? c.since : null,
        exception: c.cuenta ? null : c.porque, countsFrom: c.cuenta ? null : c.contaraDesde,
        lastEntryOn: s!.actividad.ultimaEntrada,
      } : null,
      face: { stored: guardado, deletesOn: guardado && cuenta && arranque ? isoDate(rostroSeBorraEl(medianoche(cuenta.since), arranque)) : null },
      listFrom: cuenta ? sumarMeses(cuenta.since, meses) : null,
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
          homeBranchId: m?.homeBranchId ?? null, archivedOn: isoDate(r.archivedOn), cause: r.bajaCause, status: r.status, note: r.note,
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
        // D-05 (bloque 4.2, edición puntual): quien apagó este aviso en su teléfono no lo recibe; la lista sale igual en su Inicio.
        url: '/autorizaciones', tag: `conservacion-${period}`, kind: 'EXMEMBERS_LIST',
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

  /**
   * Quién entra a la lista del mes: los dados de baja en su ficha que cumplen
   * el plazo (3.9) y, desde P-01 (4.18), los de la baja calculada que lo
   * cumplen contando desde su baja para la conservación (con la excepción de
   * quien sigue viniendo ya aplicada). Del más antiguo al más reciente.
   */
  private async candidatos(organizationId: string, meses: number, ahora: Date): Promise<Candidato[]> {
    const deFicha: Candidato[] = (await this.cumplenElPlazo(organizationId, meses, ahora)).map((c) => ({
      memberId: c.exsocio.id, memberCode: c.exsocio.memberCode, archivedAt: c.exsocio.deletedAt!, archivedOn: c.bajaEl, cause: 'ARCHIVED',
    }));
    const calculadas: Candidato[] = [];
    for (const s of await new BajasParaConservar(organizationId, ahora).calculadas()) {
      if (!s.conservar?.cuenta) continue;
      const desde = medianoche(s.conservar.since);
      if (desde.getTime() > corteDeAnonimizacion(medianoche(s.hoy), meses).getTime()) continue;
      calculadas.push({ memberId: s.memberId, memberCode: s.memberCode, archivedAt: desde, archivedOn: desde, cause: s.conservar.cause });
    }
    return [...deFicha, ...calculadas].sort((a, b) => a.archivedOn.getTime() - b.archivedOn.getTime() || a.memberId.localeCompare(b.memberId));
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
