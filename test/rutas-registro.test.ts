import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ROLE_PERMISSIONS, type PermissionKey } from '@gymflow/core';
import { makeApp, loginAs } from './helpers.js';
import { closeDb } from '../src/platform/db/client.js';
import { registeredRoutes } from '../src/platform/http/registry.js';
import { gimnasioDeRutas, type GimnasioDeRutas } from './rutas-fixtures.js';
import {
  CONSULTAS, CUERPOS, CUERPO_POR_OMISION, DE_ORGANIZACION, LECTURAS_SIN_FILTRO_DE_SEDE, OTROS_PARAMETROS, PERMISO_DE_TODOS,
  RECURSO_POR_PREFIJO, SEDE_SIN_403, SIN_404_AJENO, SIN_RECURSO_DE_GIMNASIO,
} from './rutas-clasificacion.js';

/**
 * TODA RUTA, DESDE EL REGISTRO (bloque 1.17b; 28-06, 28-19).
 *
 * Estas pruebas no tienen una lista de rutas: recorren lo que la API montó
 * (`registeredRoutes()`) y a cada ruta le hacen las mismas preguntas.
 *
 *  1. Sin sesión → 401.
 *  2. Con sesión de personal, lo de plataforma no existe (404) y lo del socio
 *     no abre (401).
 *  3. Sin el permiso declarado → 403, puesto por puesto.
 *  4. Con el permiso, pero el recurso es de OTRO gimnasio → 404.
 *  5. Con el permiso solo en una sede, y el recurso es de OTRA sede → 403.
 *  6. Una lectura no entrega lo de otra sede: ni pidiéndola (`?branchId=`),
 *     ni callando la sede.
 *
 * Lo que el registro no dice (de qué clase es un `:id`, qué cuerpo hay que
 * mandar, por qué una ruta vale para todo el gimnasio) está en
 * `rutas-clasificacion.ts`. Una ruta nueva sin clasificar hace fallar la
 * primera prueba, o la que le toque, y el mensaje dice cuál es.
 *
 * Los recursos son de un gimnasio aparte (`rutas-fixtures.ts`): estas pruebas
 * no escriben en el Gimnasio Demo ni dejan datos por corrida.
 */
type Ruta = ReturnType<typeof registeredRoutes>[number];
const PUESTOS = ['MANAGER', 'RECEPTION', 'COACH', 'OWNER'] as const;
type Puesto = (typeof PUESTOS)[number];
/** Con alcance de sede se prueba sin el dueño (siempre es de todo el gimnasio) y con el coach al final (solo ve a sus socios). */
const DE_SEDE = ['RECEPTION', 'MANAGER', 'COACH'] as const;
const UUID_INEXISTENTE = '01890000-0000-7000-8000-000000000000';

const clave = (r: Ruta) => `${r.method} ${r.url}`;
const prefijo = (url: string) => url.split('/:')[0]!;
const parametros = (url: string): string[] => url.match(/:\w+/g) ?? [];
const permisosDe = (r: Ruta): PermissionKey[] => (r.security.kind === 'permission' ? [r.security.permission, ...(r.security.anyOf ?? [])] : []);
/**
 * Lo que la SESIÓN le suma a un puesto sobre el catálogo (`identity/session.repository.ts`). D-23 (fase 3, 3.7): la
 * dueña anota gastos, nómina y retiros aunque haya gerente. (Sin gerente suma más, pero estos gimnasios lo tienen.)
 */
const DE_LA_SESION: Partial<Record<Puesto, readonly string[]>> = { OWNER: ['expenses:manage'] };
const tiene = (puesto: Puesto, r: Ruta) => permisosDe(r).some((p) => ROLE_PERMISSIONS[puesto].includes(p) || (DE_LA_SESION[puesto] ?? []).includes(p));
const esDePersonal = (r: Ruta) => r.security.kind === 'permission' || r.security.kind === 'session';
const sinFallos = (mal: string[]) => expect(mal.join('\n')).toBe('');

describe('toda ruta, desde el registro', () => {
  let app: FastifyInstance;
  let g: GimnasioDeRutas;
  /** Cuentas del Gimnasio Demo (otro gimnasio que el de los recursos). */
  const ajenas = {} as Record<Puesto, string>;
  /** Cuentas del gimnasio de rutas, con todo el gimnasio. */
  const propias = {} as Record<Puesto, string>;
  /** Cuentas del gimnasio de rutas que solo trabajan en la sede A. */
  const deSedeA = {} as Record<Puesto, string>;
  let rutas: readonly Ruta[];
  /** Los ids de lo que vive en la sede B: ninguno debe salir en lo que lee alguien de la sede A. */
  let deLaOtraSede: string[];

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    g = await gimnasioDeRutas();
    const demo: Record<Puesto, string> = { OWNER: 'owner@demo.mx', MANAGER: 'gerencia@demo.mx', RECEPTION: 'recepcion@demo.mx', COACH: 'coach@demo.mx' };
    for (const p of PUESTOS) {
      ajenas[p] = await loginAs(app, demo[p]);
      propias[p] = await loginAs(app, g.porPuesto[p]);
      deSedeA[p] = await loginAs(app, g.soloSedeA[p]);
    }
    rutas = registeredRoutes();
    deLaOtraSede = [...g.extras, g.ids.member, ...(['cashRegister', 'cashSession', 'posSale', 'expense', 'classTemplate', 'classSchedule', 'classBooking',
      'intake', 'memberImport', 'prospect', 'approvalRequest', 'accessGateway', 'accessDecision'] as const).map((c) => g.ids[c])];
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  /** La URL con los ids del gimnasio de rutas (o con ids que no existen). */
  function urlCon(r: Ruta, recursos: boolean): string {
    const clase = RECURSO_POR_PREFIJO[prefijo(r.url)];
    return r.url.replace(/:\w+/g, (param) => {
      if (!recursos) return param === ':key' ? 'classes' : param === ':type' ? 'MARKETING' : UUID_INEXISTENTE;
      if (param === ':id') return clase ? g.ids[clase] : UUID_INEXISTENTE;
      const otro = OTROS_PARAMETROS[param];
      if (!otro) return UUID_INEXISTENTE;
      return typeof otro === 'string' ? g.ids[otro] : otro.literal;
    });
  }

  /** Pide la ruta con su cuerpo y su consulta mínimos válidos (de la clasificación). */
  async function pedir(r: Ruta, url: string, cookie: string | null, masConsulta?: string) {
    const propia = CONSULTAS[clave(r)];
    const consulta = [typeof propia === 'function' ? propia(g) : propia, masConsulta].filter(Boolean).join('&');
    const res = await app.inject({
      method: r.method as 'GET', url: consulta ? `${url}?${consulta}` : url,
      ...(cookie ? { headers: { cookie } } : {}),
      ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: CUERPOS[clave(r)]?.(g) ?? CUERPO_POR_OMISION }),
    });
    let json: { error?: string } = {};
    try { json = res.json(); } catch { /* respuesta sin JSON */ }
    return { status: res.statusCode, error: json.error ?? null, cuerpo: res.body.slice(0, 160), texto: res.body };
  }

  /**
   * ¿Fue una negativa? 403, o —para el coach en la ficha de un socio— 404: el
   * coach solo ve a SUS socios (2026-10-09), la ficha de cualquier otro no
   * existe para él, y esa puerta va antes que la del permiso.
   */
  const negada = (res: { status: number; error: string | null }, puesto: Puesto, r: Ruta) =>
    (res.status === 403 && res.error === 'FORBIDDEN')
    || (puesto === 'COACH' && r.url.startsWith('/members/:id') && res.status === 404 && res.error === 'NOT_FOUND');

  it('toda ruta está clasificada, y la clasificación no habla de rutas que ya no existen', () => {
    const faltan: string[] = [];
    for (const r of rutas) {
      if (!esDePersonal(r) || parametros(r.url).length === 0) continue;
      if (SIN_RECURSO_DE_GIMNASIO[clave(r)]) continue;
      if (parametros(r.url).includes(':id') && !RECURSO_POR_PREFIJO[prefijo(r.url)]) faltan.push(`${clave(r)}: su prefijo ${prefijo(r.url)} no está en RECURSO_POR_PREFIJO`);
      for (const p of parametros(r.url)) if (p !== ':id' && !OTROS_PARAMETROS[p]) faltan.push(`${clave(r)}: el parámetro ${p} no está en OTROS_PARAMETROS`);
    }
    expect(faltan.join('\n'), 'rutas sin clasificar (ver rutas-clasificacion.ts)').toBe('');

    const existentes = new Set(rutas.map(clave));
    const sobran = [CUERPOS, CONSULTAS, SIN_404_AJENO, DE_ORGANIZACION, SEDE_SIN_403, SIN_RECURSO_DE_GIMNASIO, LECTURAS_SIN_FILTRO_DE_SEDE]
      .flatMap((tabla) => Object.keys(tabla)).concat(PERMISO_DE_TODOS).filter((k) => !existentes.has(k));
    expect(sobran, 'clasificación de rutas que ya no existen').toEqual([]);
    const prefijos = new Set(rutas.map((r) => prefijo(r.url)));
    expect(Object.keys(RECURSO_POR_PREFIJO).filter((p) => !prefijos.has(p)), 'prefijos sin rutas').toEqual([]);
  });

  it('sin sesión, toda ruta que no es pública responde 401', async () => {
    const mal: string[] = [];
    let n = 0;
    for (const r of rutas) {
      if (r.security.kind === 'public') continue;
      n++;
      const res = await pedir(r, urlCon(r, false), null);
      if (res.status !== 401) mal.push(`${clave(r)} → ${res.status} ${res.cuerpo}`);
    }
    sinFallos(mal);
    expect(n).toBeGreaterThan(250);
  });

  it('con sesión de personal, lo de plataforma no existe (404) y lo del socio no abre (401)', async () => {
    const mal: string[] = [];
    for (const r of rutas) {
      if (r.security.kind !== 'platform' && r.security.kind !== 'member') continue;
      const esperado = r.security.kind === 'platform' ? 404 : 401;
      for (const p of ['OWNER', 'MANAGER'] as const) {
        const res = await pedir(r, urlCon(r, false), ajenas[p]);
        if (res.status !== esperado) mal.push(`${clave(r)} como ${p} → ${res.status} ${res.cuerpo}`);
      }
    }
    sinFallos(mal);
  });

  it('sin el permiso de la ruta, 403: cada puesto contra cada ruta que no le toca', async () => {
    const mal: string[] = [];
    const nadieLaPrueba: string[] = [];
    let n = 0;
    for (const r of rutas) {
      if (r.security.kind !== 'permission') continue;
      const sinPermiso = PUESTOS.filter((p) => !tiene(p, r));
      if (sinPermiso.length === 0) { nadieLaPrueba.push(clave(r)); continue; }
      for (const p of sinPermiso) {
        n++;
        // Con sus propios recursos y un cuerpo válido: si la puerta fallara, la operación se haría.
        const res = await pedir(r, urlCon(r, true), propias[p]);
        if (!negada(res, p, r)) mal.push(`${clave(r)} como ${p} → ${res.status} ${res.cuerpo}`);
      }
    }
    sinFallos(mal);
    expect(n).toBeGreaterThan(300);
    // Las rutas cuyo permiso tienen los cuatro puestos no se pueden negar con un puesto del catálogo: se dicen.
    expect(nadieLaPrueba.sort()).toEqual([...PERMISO_DE_TODOS].sort());
  });

  it('un recurso de OTRO gimnasio no existe: 404 en toda ruta con parámetro, lea o escriba', async () => {
    const mal: string[] = [];
    let n = 0;
    for (const r of rutas) {
      if (!esDePersonal(r) || parametros(r.url).length === 0 || SIN_RECURSO_DE_GIMNASIO[clave(r)]) continue;
      const puesto = r.security.kind === 'session' ? 'MANAGER' : PUESTOS.find((p) => tiene(p, r));
      if (!puesto) { mal.push(`${clave(r)}: ningún puesto tiene su permiso`); continue; }
      n++;
      const res = await pedir(r, urlCon(r, true), ajenas[puesto]);
      const otra = SIN_404_AJENO[clave(r)];
      if (otra) {
        if (!otra.status.includes(res.status)) mal.push(`${clave(r)} → ${res.status} (declarado ${otra.status.join(' o ')}: ${otra.porque}) ${res.cuerpo}`);
        else if (otra.sinDatos && !otra.sinDatos(res.texto)) mal.push(`${clave(r)} → ${res.status} con datos: ${res.cuerpo}`);
      } else if (res.status !== 404 || res.error !== 'NOT_FOUND') {
        mal.push(`${clave(r)} como ${puesto} → ${res.status} ${res.cuerpo}`);
      }
    }
    sinFallos(mal);
    expect(n).toBeGreaterThan(130);
  });

  it('con el permiso solo en una sede, un recurso de OTRA sede responde 403 (o la ruta dice por qué es de todo el gimnasio)', async () => {
    const mal: string[] = [];
    let n = 0;
    for (const r of rutas) {
      if (r.security.kind !== 'permission' || parametros(r.url).length === 0 || SIN_RECURSO_DE_GIMNASIO[clave(r)]) continue;
      if (DE_ORGANIZACION[clave(r)]) continue;
      const puesto = DE_SEDE.find((p) => tiene(p, r));
      if (!puesto) continue;
      n++;
      const res = await pedir(r, urlCon(r, true), deSedeA[puesto]);
      const otra = SEDE_SIN_403[clave(r)];
      if (otra) { if (res.status !== otra.status) mal.push(`${clave(r)} → ${res.status} (declarado ${otra.status}: ${otra.porque}) ${res.cuerpo}`); }
      else if (!negada(res, puesto, r)) mal.push(`${clave(r)} como ${puesto} → ${res.status} ${res.cuerpo}`);
    }
    sinFallos(mal);
    expect(n).toBeGreaterThan(60);
  });

  it('una lectura no entrega lo de otra sede: pedirla con `?branchId=` responde 403, y sin decir sede no trae nada de ella', async () => {
    const mal: string[] = [];
    let n = 0;
    const fuga = (texto: string) => deLaOtraSede.find((id) => texto.includes(id));
    for (const r of rutas) {
      if (r.security.kind !== 'permission' || r.method !== 'GET' || parametros(r.url).length > 0 || DE_ORGANIZACION[clave(r)]) continue;
      const puesto = DE_SEDE.find((p) => tiene(p, r));
      if (!puesto) continue;
      n++;
      // 1. Pidiendo la otra sede.
      const otra = await pedir(r, r.url, deSedeA[puesto], `branchId=${g.sedeB}`);
      if (LECTURAS_SIN_FILTRO_DE_SEDE[clave(r)]) {
        if (otra.status !== 200) mal.push(`${clave(r)}?branchId=otra → ${otra.status} (declarada sin filtro de sede) ${otra.cuerpo}`);
        else if (fuga(otra.texto)) mal.push(`${clave(r)}?branchId=otra trae ${fuga(otra.texto)} de la otra sede`);
      } else if (otra.status !== 403) {
        mal.push(`${clave(r)}?branchId=otra como ${puesto} → ${otra.status} ${otra.cuerpo}`);
      }
      // 2. Sin decir sede: lo suyo, nunca lo de la otra.
      const callada = await pedir(r, r.url, deSedeA[puesto]);
      if (callada.status >= 500) mal.push(`${clave(r)} sin sede → ${callada.status} ${callada.cuerpo}`);
      else if (callada.status < 300 && fuga(callada.texto)) mal.push(`${clave(r)} sin sede trae ${fuga(callada.texto)} de la otra sede`);
    }
    sinFallos(mal);
    expect(n).toBeGreaterThan(30);
  });

  /**
   * Las rutas de la segunda firma solo piden sesión (la autorización fina va
   * en el handler), así que la prueba de sede de arriba no las toca. Se
   * pregunta aquí con la contraseña CORRECTA: lo que se niega es la sede.
   */
  it('una firma pedida en otra sede no la aprueba quien no trabaja ahí, ni con su contraseña correcta', async () => {
    const { getDb } = await import('../src/platform/db/client.js');
    const { PASSWORD } = await import('./helpers.js');
    const id = g.ids.approvalRequest;
    const estado = async () => (await getDb().approvalRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
    expect(await estado()).toBe('PENDING');
    for (const cookie of [deSedeA.MANAGER, deSedeA.OWNER, propias.RECEPTION]) {
      const r = await app.inject({ method: 'POST', url: `/approvals/requests/${id}/approve`, headers: { cookie }, payload: { password: PASSWORD } });
      expect(r.statusCode, r.body).toBe(403);
      for (const paso of ['cancel', 'reject']) {
        const otro = await app.inject({ method: 'POST', url: `/approvals/requests/${id}/${paso}`, headers: { cookie }, payload: { reason: 'Intento desde otra sede' } });
        expect([403, 404], `${paso}: ${otro.body}`).toContain(otro.statusCode);
      }
    }
    expect(await estado()).toBe('PENDING');
  });
});
