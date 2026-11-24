import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from './helpers.js';
import { closeDb } from '../src/platform/db/client.js';
import { registeredRoutes } from '../src/platform/http/registry.js';

/**
 * RUTAS QUE NINGUNA PANTALLA LLAMA (28-06; bloque 1.17b).
 *
 * La auditoría 8 contó 37 rutas de personal y socio sin ningún cliente, y la
 * auditoría 6 ya había pedido una lista para que no crecieran sin decisión.
 * Cada una es superficie de permisos, de aislamiento y de mantenimiento que
 * nadie usa ni mira.
 *
 * Esta prueba lee el código del panel y del portal (los repos hermanos) y
 * busca cada URL del registro. La que nadie llama tiene que estar en
 * `SIN_CLIENTE` con su porqué. Una ruta nueva sin pantalla hace fallar la
 * prueba: o se le pone su pantalla, o se anota aquí por qué existe sin ella.
 * Y al revés: cuando una ruta de la lista ya tiene cliente, o se borra, la
 * prueba pide quitarla de la lista.
 *
 * Es una búsqueda de texto. Reconoce el último tramo puesto por una expresión
 * (`/payments/${id}/${revertir ? 'reverse' : 'refund'}`); una URL armada de otro
 * modo (`${base}/${accion}` con variables) no, y habría que anotarla aquí diciéndolo. Si los repos hermanos
 * no están (otra máquina, CI con un solo repo), la prueba se salta.
 */
const POR_QUE = {
  equipo: 'la llamará el torniquete o su gateway cuando exista el equipo (contrato del torniquete, D28-06); hoy no hay cliente',
  credencial: 'credenciales de tarjeta y PIN: el panel solo registra la entrada por el mostrador (5-08); sin pantalla',
  tarjeta: 'cobro con tarjeta en línea y su conciliación: el procesador real no está contratado; sin pantalla',
  vieja: 'operación de membresía o de cargos anterior a la venta con cobro y al cambio de plan de 1.3: la pantalla usa la ruta nueva; candidata a borrarse',
  paquete: 'paquetes de visitas por id: la ficha usa la lista del socio; sin pantalla',
  suelta: 'sin pantalla; decidir si se borra o se le pone una (28-06)',
  otroSistema: 'no la llama una pantalla: la llama el procesador de pagos, autenticado por la firma del cuerpo',
} as const;

const SIN_CLIENTE: Record<string, string> = {
  'GET /access/gateways': POR_QUE.equipo, 'POST /access/gateways': POR_QUE.equipo, 'POST /access/gateways/:id/heartbeat': POR_QUE.equipo,
  'GET /access/roster': POR_QUE.equipo, 'GET /access/roster/public-key': POR_QUE.equipo, 'GET /access/revocations': POR_QUE.equipo,
  'GET /access/denials': POR_QUE.equipo, 'GET /access/manual-policy': POR_QUE.equipo,
  'GET /members/:id/credentials': POR_QUE.credencial, 'POST /members/:id/credentials': POR_QUE.credencial, 'POST /credentials/:id/revoke': POR_QUE.credencial,
  'POST /charges/:id/charge-card': POR_QUE.tarjeta, 'GET /members/:id/payment-methods': POR_QUE.tarjeta,
  'GET /payments/:id/refunds': POR_QUE.tarjeta,
  'GET /payments/chargebacks': POR_QUE.tarjeta, 'GET /payments/webhooks/dead-letters': POR_QUE.tarjeta, 'POST /payments/attempts/:id/resolve': POR_QUE.tarjeta,
  // Las cinco rutas sin cobro de `memberships` se quitaron en la fase 3 (bloque 3.5, D-12).
  'POST /memberships/:id/period-charge': POR_QUE.vieja, 'GET /memberships/:id/events': POR_QUE.vieja,
  'POST /members/:id/charges': POR_QUE.vieja,
  'GET /visit-packs/:id': POR_QUE.paquete, 'POST /visit-packs/:id/adjust': POR_QUE.paquete, 'POST /visit-packs/:id/consume': POR_QUE.paquete,
  'POST /auth/logout-all': POR_QUE.suelta, 'GET /platform/invoices': POR_QUE.suelta,
  'GET /portfolio': POR_QUE.suelta, 'GET /discount-reasons': POR_QUE.suelta,
  'POST /member-imports/:id/decide-all': POR_QUE.suelta,
  // Bloque 2.5: `…/generate` y `…/capacity` salieron de la lista (ya tienen pantalla en Clases). El coach de un horario
  // se cambia ahora con «Editar» (`PATCH /classes/templates/:id`); la ruta de antes queda sin pantalla.
  'PUT /classes/templates/:id/coach': 'el coach de un horario se cambia con «Editar» del horario (`PATCH /classes/templates/:id`, bloque 2.5); candidata a borrarse',
  'POST /webhooks/payments': POR_QUE.otroSistema,
  // Bloque 2.4: el pendiente de interesados ya lo sirve la API; lo pinta el Inicio (bloque 2.1). `check-duplicates` salió de la lista: ya es el buscador de identidad.
  'GET /prospects/pending': 'el pendiente de interesados del Inicio (10-08): la ruta está lista y falta que el Inicio (bloque 2.1) la pinte',
};

const RAIZ = resolve(import.meta.dirname, '../..');
const CLIENTES = [join(RAIZ, 'gymflow-web'), join(RAIZ, 'gymflow-portal')];
const FUERA = new Set(['node_modules', '.next', 'e2e', 'public', 'scripts']);

function fuentes(dir: string, salida: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (FUERA.has(e.name)) continue;
    const ruta = join(dir, e.name);
    if (e.isDirectory()) fuentes(ruta, salida);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) salida.push(ruta);
  }
  return salida;
}

/**
 * ¿Alguna pantalla la llama? Se busca la URL como aparece en el código de un cliente:
 * `/members/${id}/charges`, con comilla, `?` o `${…}` detrás. Y también con el ÚLTIMO
 * tramo puesto por una expresión, como `/payments/${id}/${revertir ? 'reverse' : 'refund'}`.
 */
function tieneCliente(url: string, codigo: string): boolean {
  const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tramos = url.split('/').filter(Boolean);
  const partes = tramos.map((s) => (s.startsWith(':') ? '(?:\\$\\{[^}]+\\}|[^/\'"`?]+)' : escapar(s)));
  if (new RegExp(`/${partes.join('/')}(?=['"\`?]|\\$\\{[a-zA-Z]*(?:qs|query|q|params|filtro|sufijo))`).test(codigo)) return true;
  const ultimo = tramos[tramos.length - 1]!;
  if (tramos.length < 2 || ultimo.startsWith(':')) return false;
  return new RegExp(`/${partes.slice(0, -1).join('/')}/\\$\\{[^}]*['"]${escapar(ultimo)}['"][^}]*\\}`).test(codigo);
}

describe.skipIf(!CLIENTES.every((d) => existsSync(d)))('rutas que ninguna pantalla llama (28-06)', () => {
  let app: FastifyInstance;
  let sinCliente: string[];

  beforeAll(async () => {
    app = await makeApp();
    await app.ready();
    const codigo = CLIENTES.flatMap((d) => fuentes(d)).map((f) => readFileSync(f, 'utf8')).join('\n');
    sinCliente = registeredRoutes().filter((r) => !tieneCliente(r.url, codigo)).map((r) => `${r.method} ${r.url}`).sort();
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  it('toda ruta sin pantalla está anotada con su porqué: una nueva no pasa sin decisión', () => {
    expect(sinCliente.filter((k) => !SIN_CLIENTE[k]), 'rutas que ninguna pantalla del panel ni del portal llama y no están en SIN_CLIENTE').toEqual([]);
  });

  it('la lista no guarda rutas que ya tienen pantalla o que ya no existen', () => {
    expect(Object.keys(SIN_CLIENTE).filter((k) => !sinCliente.includes(k)), 'quítalas de SIN_CLIENTE').toEqual([]);
  });

  it('la lista no crece: 38 rutas sin pantalla el 2026-11-21 (la auditoría 8 contó 37)', () => {
    expect(Object.keys(SIN_CLIENTE).length).toBeLessThanOrEqual(38);
  });
});
