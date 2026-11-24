import type { FastifyInstance } from 'fastify';
import { abiertoAInternet, esDireccionProvisional, type Perfil } from '../perfiles.js';
import { route } from './registry.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** `uso-real`, `pruebas` o `null`: lo decide la base al arrancar (`platform/perfiles.ts`). */
    perfilDeArranque: Perfil | null;
  }
}

export function registerHealthRoutes(app: FastifyInstance): void {
  route(app, {
    method: 'GET',
    url: '/health',
    security: { kind: 'public', why: 'Sonda de disponibilidad del balanceador y del watchdog externo' },
    // El perfil va a la vista a propósito: los recorridos y `gymflow.sh`
    // comprueban que hablan con la API de PRUEBAS antes de escribir nada, y
    // no con la del gimnasio de verdad (27-01). No es un dato privado.
    handler: async () => ({ status: 'ok', perfil: app.perfilDeArranque ?? null, at: new Date().toISOString() }),
  });

  /**
   * Direcciones públicas de esta instalación (2026-10-09): el panel arma con
   * ellas los QR del alta y del portal. Se leen al arrancar la API, no al
   * compilar, para que un túnel o un dominio nuevo no obligue a recompilar.
   * Solo URLs que de todos modos van impresas en los carteles.
   */
  route(app, {
    method: 'GET',
    url: '/public/config',
    security: { kind: 'public', why: 'Dirección pública del portal que el panel imprime en sus QR; no es un dato privado' },
    // D-01 (fase 3): también la del panel, y si la dirección es FIJA (un dominio propio) o
    // provisional (el túnel sin cuenta, que cambia en cada arranque): el panel avisa de la segunda.
    handler: async () => {
      const portalUrl = (process.env.PORTAL_PUBLIC_URL ?? '').trim().replace(/\/$/, '') || null;
      const panelUrl = (process.env.PANEL_PUBLIC_URL ?? '').trim().replace(/\/$/, '') || null;
      const abierto = abiertoAInternet({ PANEL_PUBLIC_URL: panelUrl ?? undefined, PORTAL_PUBLIC_URL: portalUrl ?? undefined });
      const provisional = esDireccionProvisional(portalUrl ?? undefined) || esDireccionProvisional(panelUrl ?? undefined);
      return { portalUrl, panelUrl, address: !abierto ? 'local' : provisional ? 'provisional' : 'fixed' };
    },
  });
}
