/**
 * GYMFLOW COMO EMISOR DE SUS FACTURAS (D-39, bloque 4.9). Los datos fiscales
 * de quien cobra NO viven en el código ni en la base (los repositorios son
 * públicos): salen de la configuración del servidor, fuera de los repos.
 *
 *   GYMFLOW_ISSUER_LEGAL_NAME   razón social (sin ella, no hay emisor configurado)
 *   GYMFLOW_ISSUER_RFC          RFC
 *   GYMFLOW_ISSUER_ADDRESS      domicilio fiscal, en una línea
 *   GYMFLOW_ISSUER_PAYMENT      cómo pagar: banco, CLABE, a nombre de quién
 *   GYMFLOW_ISSUER_CONTACT      a dónde escribir o llamar por una factura
 *
 * Cada factura guarda los que había el día en que se emitió. Sin configurar,
 * la factura sale igual, a nombre de «GymFlow» y sin datos de pago: la consola
 * lo avisa en Precios.
 */
export type Emisor = { legalName: string; rfc: string | null; address: string | null; payment: string | null; contact: string | null };

const texto = (v: string | undefined, max: number): string | null => {
  const t = v?.trim();
  return t ? t.slice(0, max) : null;
};

export function emisor(fuente: NodeJS.ProcessEnv = process.env): Emisor | null {
  const legalName = texto(fuente.GYMFLOW_ISSUER_LEGAL_NAME, 200);
  if (!legalName) return null;
  return {
    legalName, rfc: texto(fuente.GYMFLOW_ISSUER_RFC, 13)?.toUpperCase() ?? null, address: texto(fuente.GYMFLOW_ISSUER_ADDRESS, 300),
    payment: texto(fuente.GYMFLOW_ISSUER_PAYMENT, 400), contact: texto(fuente.GYMFLOW_ISSUER_CONTACT, 200),
  };
}

/** Lo guardado en `platform_invoices.issuer`, leído con cuidado. */
export function emisorGuardado(j: unknown): Emisor | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (typeof o.legalName !== 'string' || !o.legalName) return null;
  const t = (k: string): string | null => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : null);
  return { legalName: o.legalName, rfc: t('rfc'), address: t('address'), payment: t('payment'), contact: t('contact') };
}

/** El receptor de una factura: la razón social y el RFC del gimnasio, de su ficha. */
export type Receptor = { legalName: string; rfc: string | null; tradeName?: string };
export function receptorGuardado(j: unknown): Receptor | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (typeof o.legalName !== 'string') return null;
  return { legalName: o.legalName, rfc: typeof o.rfc === 'string' && o.rfc ? o.rfc : null, ...(typeof o.tradeName === 'string' ? { tradeName: o.tradeName } : {}) };
}
