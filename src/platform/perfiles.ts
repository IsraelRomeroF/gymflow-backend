/**
 * PERFILES DE ARRANQUE (auditoría 8, fase 0.1).
 *
 * GymFlow corre dos veces en la misma computadora: el USO REAL, con el
 * gimnasio de verdad, y las PRUEBAS, con gimnasios ficticios para los
 * recorridos de navegador. Antes compartían puertos y configuración: correr
 * la regresión apagaba el mostrador (27-01), el portal del uso real cobraba
 * con la caja de arena (25-01) y todo el gimnasio compartía un solo cupo de
 * intentos porque detrás del panel todos llegaban como 127.0.0.1 (24-01).
 *
 * Un perfil por base, con todo lo demás explícito:
 *
 *   | Perfil    | Base            | API · portal · panel | Pagos   | Proxies       |
 *   |-----------|-----------------|----------------------|---------|---------------|
 *   | uso real  | gymflow_local   | 3001 · 3002 · 3003   | none    | 127.0.0.1,::1 |
 *   | pruebas   | gymflow_pruebas | 4001 · 4002 · 4003   | sandbox | 127.0.0.1,::1 |
 *   | unitarias | gymflow_test*   | —                    | sandbox | —             |
 *
 * El uso real puede además abrirse a internet con una DIRECCIÓN FIJA (D-01,
 * fase 3): mismas base y puertos, más las reglas de «abierto a internet» de
 * abajo.
 *
 * Aquí viven las REGLAS (qué combinación vale), no los valores: los pone
 * `scripts/perfil.sh`. Con una combinación inválida la API no arranca y dice
 * qué está mal y cómo se arregla.
 */

export const PERFILES = {
  'uso-real': { base: 'gymflow_local', api: 3001, portal: 3002, panel: 3003, pagos: 'none' },
  pruebas: { base: 'gymflow_pruebas', api: 4001, portal: 4002, panel: 4003, pagos: 'sandbox' },
} as const;

export type Perfil = keyof typeof PERFILES;

/**
 * Qué clase de base es, por su nombre.
 * - `desarrollo` es `gymflow_dev`, la base de desarrollo que crea `instalar.sh`.
 * - `otra` es cualquier otra: la de producción, una de ensayo (`gymflow_ensayo`).
 */
export type TipoDeBase = Perfil | 'unitarias' | 'desarrollo' | 'otra';

/** Contraseñas publicadas en el repositorio (`.env.example`, `bootstrap-db.mjs`, `instalar.sh`). */
export const CLAVES_DE_DESARROLLO: readonly string[] = ['gymflow_app_dev', 'gymflow_owner_dev', 'CAMBIAR'];

/** El rol con contraseña propia con el que el uso real se conecta (lo crea `pnpm local:preparar`). */
export const ROL_USO_REAL = 'gymflow_local_app';

export type DatosDeConexion = { nombre: string; usuario: string; clave: string };

/** Base, usuario y contraseña de una `DATABASE_URL`, o `null` si no se entiende. */
export function datosDeConexion(url: string | undefined): DatosDeConexion | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const nombre = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!nombre) return null;
    return { nombre, usuario: decodeURIComponent(u.username), clave: decodeURIComponent(u.password) };
  } catch {
    return null;
  }
}

export function tipoDeBase(nombre: string | undefined): TipoDeBase {
  if (nombre === PERFILES['uso-real'].base) return 'uso-real';
  if (nombre === PERFILES.pruebas.base) return 'pruebas';
  // `gymflow_test` y las de cada desarrollador o agente: `gymflow_test_a`, `gymflow_test_b`…
  if (nombre && /^gymflow_test(_[a-z0-9]+)*$/.test(nombre)) return 'unitarias';
  if (nombre === 'gymflow_dev') return 'desarrollo';
  return 'otra';
}

/** El perfil con nombre de una conexión: `uso-real`, `pruebas` o ninguno. */
export function perfilDe(databaseUrl: string | undefined): Perfil | null {
  const tipo = tipoDeBase(datosDeConexion(databaseUrl)?.nombre);
  return tipo === 'uso-real' || tipo === 'pruebas' ? tipo : null;
}

/**
 * ¿Esta base admite la caja de arena? Solo las de prueba: en cualquier otra,
 * un "pago aplicado" de la caja de arena parecería dinero de verdad en el
 * corte, en Movimientos y en el pulso de la dueña.
 */
export function admiteCajaDeArena(tipo: TipoDeBase): boolean {
  return tipo === 'pruebas' || tipo === 'unitarias' || tipo === 'desarrollo';
}

type Procesador = 'none' | 'sandbox';

/**
 * El procesador cuando no se indica `PAYMENT_PROVIDER`: la caja de arena
 * solo en bases de prueba y nunca en producción. Antes bastaba con no estar
 * en producción, y el uso real (que corre en desarrollo) cobraba con ella.
 */
export function procesadorPorOmision(nodeEnv: string | undefined, tipo: TipoDeBase): Procesador {
  return nodeEnv !== 'production' && admiteCajaDeArena(tipo) ? 'sandbox' : 'none';
}

/**
 * El procesador que de verdad corre, para quien lo pregunta sin la
 * configuración cargada (los jobs, el portal). Si alguien pidió la caja de
 * arena donde no vale, se responde `none`: ante la duda, no se cobra.
 */
export function procesadorEnUso(source: NodeJS.ProcessEnv): Procesador {
  const tipo = tipoDeBase(datosDeConexion(source.DATABASE_URL)?.nombre);
  const pedido = source.PAYMENT_PROVIDER;
  if (pedido === 'none') return 'none';
  if (pedido === 'sandbox') return source.NODE_ENV !== 'production' && admiteCajaDeArena(tipo) ? 'sandbox' : 'none';
  return procesadorPorOmision(source.NODE_ENV, tipo);
}

/** El valor de `CORS_ORIGINS` que trae el esquema: no es ningún origen de GymFlow. */
export const CORS_POR_OMISION = 'http://localhost:3000';

export type Arranque = {
  NODE_ENV: string;
  API_PORT: number;
  DATABASE_URL: string;
  paymentProvider: Procesador;
  trustedProxies: readonly string[];
  CORS_ORIGINS: string;
  portalOrigins: readonly string[];
  /** Dirección pública del portal: con ella el portal se abre por túnel o dominio. */
  PORTAL_PUBLIC_URL?: string | undefined;
  /** Dirección pública del panel (D-01): la que abre la dueña desde su teléfono. */
  PANEL_PUBLIC_URL?: string | undefined;
  /** Dominio de las cookies de sesión; vacío = cada cookie vale solo en la dirección que la puso. */
  SESSION_COOKIE_DOMAIN?: string | undefined;
};

/**
 * ENTRAR DESDE FUERA CON DIRECCIÓN FIJA (D-01, fase 3).
 *
 * GymFlow sigue en la computadora del gimnasio; un túnel con nombre publica
 * el panel y el portal en un dominio propio. Desde que una de las dos
 * direcciones públicas no es de esta computadora ni de la red del gimnasio,
 * la instalación está ABIERTA A INTERNET y la API solo arranca si todo lo
 * demás corresponde: https, proxies de confianza (para contar a cada persona
 * con su IP real), el cobro con tarjeta apagado, y como orígenes los
 * públicos. Los valores los pone `gymflow.sh` desde `~/.gymflow/uso-real.env`.
 */

/** `localhost`, 127.x, ::1, las redes privadas (10.x, 172.16–31.x, 192.168.x) y `*.local`. */
export function esHostLocal(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/** La URL si se entiende y es http o https; si no, `null`. */
function direccion(valor: string | undefined): URL | null {
  if (!valor?.trim()) return null;
  try {
    const u = new URL(valor.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** ¿Alguna dirección pública sale de esta computadora y de la red del gimnasio? */
export function abiertoAInternet(e: Pick<Arranque, 'PANEL_PUBLIC_URL' | 'PORTAL_PUBLIC_URL'>): boolean {
  return [e.PANEL_PUBLIC_URL, e.PORTAL_PUBLIC_URL].some((v) => {
    const u = direccion(v);
    return u !== null && !esHostLocal(u.hostname);
  });
}

/** Los túneles sin cuenta de Cloudflare: su dirección cambia en cada arranque. */
export function esDireccionProvisional(url: string | undefined): boolean {
  const u = direccion(url);
  return u !== null && /(^|\.)trycloudflare\.com$/.test(u.hostname);
}

/** El dominio de cookie como se compara: sin punto inicial y en minúsculas. */
export function dominioDeCookie(valor: string | undefined): string {
  return (valor ?? '').trim().toLowerCase().replace(/^\./, '');
}

/**
 * ¿La cookie con ese dominio le sirve a quien entró por `host`? Solo si el
 * host ES el dominio o cuelga de él. Quien entra por `localhost` o por la red
 * del gimnasio recibe la cookie sin dominio: con dominio, su navegador la
 * tiraría y el mostrador se quedaría sin poder entrar el día que se va
 * internet.
 */
export function cookieConDominio(host: string | undefined, dominio: string | undefined): boolean {
  const d = dominioDeCookie(dominio);
  if (!d || !host) return false;
  const h = host.trim().toLowerCase().replace(/:\d+$/, '');
  return h === d || h.endsWith(`.${d}`);
}

/** Lo que el modo abierto a internet exige, además de lo de cada perfil. */
function problemasDeDireccionPublica(e: Arranque): string[] {
  const problemas: string[] = [];
  const publicas = [
    { nombre: 'PANEL_PUBLIC_URL', que: 'el panel', a: 'al panel', valor: e.PANEL_PUBLIC_URL },
    { nombre: 'PORTAL_PUBLIC_URL', que: 'el portal', a: 'al portal', valor: e.PORTAL_PUBLIC_URL },
  ].filter((p) => p.valor?.trim());
  const origenes = e.CORS_ORIGINS.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  const portal = e.portalOrigins.map((o) => o.replace(/\/$/, ''));

  for (const p of publicas) {
    const u = direccion(p.valor);
    if (!u) {
      problemas.push(`${p.nombre}=«${p.valor}» no es una dirección: va completa, con https:// (por ejemplo https://panel.tu-dominio.mx).`);
      continue;
    }
    if (esHostLocal(u.hostname)) continue;
    if (u.protocol !== 'https:') {
      problemas.push(
        `${p.nombre} abre ${p.que} a internet por http (${u.origin}): por internet solo se entra por https. `
        + 'El túnel de Cloudflare ya lo da: escribe la dirección con https://.',
      );
    }
    if (!origenes.includes(u.origin)) {
      problemas.push(`CORS_ORIGINS no incluye ${u.origin} (${p.nombre}): desde esa dirección la API rechazaría ${p.a}. «bash gymflow.sh» lo agrega solo.`);
    }
    if (p.nombre === 'PORTAL_PUBLIC_URL' && !portal.includes(u.origin)) {
      problemas.push(`PORTAL_ORIGINS no incluye ${u.origin}: es la dirección pública del portal. «bash gymflow.sh» lo agrega solo.`);
    }
  }

  if (abiertoAInternet(e)) {
    if (e.trustedProxies.length === 0) {
      problemas.push(
        'Con una dirección pública (PANEL_PUBLIC_URL o PORTAL_PUBLIC_URL: el panel o el portal abiertos por un túnel o un dominio) '
        + 'TRUSTED_PROXIES es obligatoria: sin ella todos los teléfonos comparten un solo cupo de intentos y nadie más puede darse de alta.',
      );
    }
    if (e.paymentProvider === 'sandbox') {
      problemas.push(
        'Con una dirección pública el cobro con tarjeta va apagado (PAYMENT_PROVIDER=none): la caja de arena aprueba pagos sin mover dinero '
        + 'y por internet cualquiera la alcanzaría. El portal dice «Paga en recepción».',
      );
    }
  }

  const dominio = dominioDeCookie(e.SESSION_COOKIE_DOMAIN);
  if (dominio) {
    const hosts = publicas.map((p) => direccion(p.valor)?.hostname).filter((h): h is string => !!h);
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dominio) || /^\d+(\.\d+){3}$/.test(dominio)) {
      problemas.push(`SESSION_COOKIE_DOMAIN=«${e.SESSION_COOKIE_DOMAIN}» no es un dominio: va sin https:// y sin puerto (por ejemplo tu-dominio.mx). Vacía también vale.`);
    } else if (abiertoAInternet(e) && !hosts.some((h) => cookieConDominio(h, dominio))) {
      problemas.push(
        `SESSION_COOKIE_DOMAIN=«${dominio}» no corresponde a ninguna dirección pública (${hosts.join(', ')}): `
        + 'el navegador tiraría la cookie y nadie podría entrar desde fuera. Déjala vacía o pon el dominio del que cuelgan.',
      );
    }
  }
  return problemas;
}

/**
 * Lo que impide arrancar, en español y con el arreglo. Vacío = la
 * combinación vale. Se juntan todos para no arreglar de uno en uno.
 */
export function problemasDeArranque(e: Arranque): string[] {
  const problemas: string[] = [];
  const conexion = datosDeConexion(e.DATABASE_URL);
  const tipo = tipoDeBase(conexion?.nombre);
  const base = conexion?.nombre ?? '(sin nombre)';
  const claveDeDesarrollo = conexion !== null && (conexion.clave === '' || CLAVES_DE_DESARROLLO.includes(conexion.clave));
  const comoSeLlamaLaClave = conexion?.clave ? `la contraseña de desarrollo «${conexion.clave}», que está publicada en el repositorio` : 'una conexión sin contraseña';

  if (e.paymentProvider === 'sandbox' && !admiteCajaDeArena(tipo)) {
    problemas.push(
      `PAYMENT_PROVIDER=sandbox con la base ${base}: la caja de arena aprueba cobros sin mover dinero y solo corre con `
      + 'gymflow_pruebas o gymflow_test. Sin procesador contratado usa PAYMENT_PROVIDER=none: el portal dice «Paga en recepción».',
    );
  }

  if (tipo === 'pruebas' && e.API_PORT === PERFILES['uso-real'].api) {
    problemas.push(
      `La base de pruebas (gymflow_pruebas) no se sirve en el puerto ${e.API_PORT}, que es del uso real: `
      + `recepción cobraría en un gimnasio ficticio. Arráncala con «bash gymflow.sh pruebas» (API en ${PERFILES.pruebas.api}).`,
    );
  }

  if (tipo === 'uso-real') {
    if (e.API_PORT === PERFILES.pruebas.api) {
      problemas.push(
        `La base del uso real (gymflow_local) no se sirve en el puerto ${e.API_PORT}, que es de las pruebas: `
        + `los recorridos automáticos escribirían en el gimnasio de verdad. Arráncala con «bash gymflow.sh» (API en ${PERFILES['uso-real'].api}).`,
      );
    }
    if (e.trustedProxies.length === 0) {
      problemas.push(
        'El uso real necesita TRUSTED_PROXIES=127.0.0.1,::1: sin eso, detrás del panel todos llegan como 127.0.0.1 '
        + 'y el gimnasio entero comparte un solo cupo de intentos.',
      );
    }
    if (!e.CORS_ORIGINS.trim() || e.CORS_ORIGINS.trim() === CORS_POR_OMISION || e.portalOrigins.length === 0) {
      problemas.push(
        'El uso real necesita sus orígenes explícitos: CORS_ORIGINS con el panel y el portal '
        + '(http://localhost:3003,http://localhost:3002) y PORTAL_ORIGINS con el portal (http://localhost:3002).',
      );
    }
    if (claveDeDesarrollo) {
      problemas.push(
        `La base del uso real (gymflow_local) no puede abrirse con ${comoSeLlamaLaClave}. `
        + `«pnpm local:preparar» crea el rol ${ROL_USO_REAL} con una contraseña propia en ~/.gymflow/uso-real.env, `
        + 'y «bash gymflow.sh» la usa.',
      );
    }
  }

  if (e.NODE_ENV === 'production' && claveDeDesarrollo) {
    problemas.push(`En producción la base no puede abrirse con ${comoSeLlamaLaClave}.`);
  }

  // Con el portal en otra dirección (aunque sea de esta computadora, como en
  // las pruebas) los proxies siguen siendo obligatorios (9-05); abierto a
  // internet lo exige `problemasDeDireccionPublica`, con todo lo demás.
  if (e.PORTAL_PUBLIC_URL?.trim() && e.trustedProxies.length === 0 && !abiertoAInternet(e)) {
    problemas.push(
      'Con PORTAL_PUBLIC_URL (el portal abierto por un túnel o un dominio) TRUSTED_PROXIES es obligatoria: '
      + 'sin ella todos los teléfonos comparten un solo cupo de intentos y nadie más puede darse de alta.',
    );
  }

  problemas.push(...problemasDeDireccionPublica(e));
  return problemas;
}
