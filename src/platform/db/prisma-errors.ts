/**
 * Guardia para errores conocidos de Prisma.
 *
 * `instanceof Prisma.PrismaClientKnownRequestError` no estrecha el tipo bajo
 * `strict` con el cliente generado, así que se comprueba la forma. Es lo que
 * permite tratar una violación de unicidad como IDEMPOTENCIA en vez de como
 * fallo: insertar y atrapar, sin la rendija que deja consultar antes.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null &&
    'code' in err && (err as { code?: unknown }).code === 'P2002'
  );
}
