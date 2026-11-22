import fp from 'fastify-plugin';
import { findPanLike, redactPanLike, DomainError } from '@gymflow/core';
import type { FastifyInstance } from 'fastify';

/**
 * NINGÚN endpoint acepta un número de tarjeta (§11.7, regla dura 3).
 *
 * No es una comprobación de formularios: es una barrera de alcance PCI. El
 * PAN no debe tocar la infraestructura de GymFlow **ni de rebote** —ni base,
 * ni Redis, ni colas, ni logs, ni trazas—, y el sitio por donde de verdad
 * entraría no es un campo `cardNumber`, que no existe, sino el campo de notas
 * de un socio donde alguien pega lo que le dictaron por teléfono.
 *
 * Por eso se rechaza **antes** del manejador: una vez dentro, el dato ya
 * apareció en el log de la petición.
 *
 * El mensaje de error NO repite el valor. Devolverlo lo metería en el log de
 * respuesta, que es exactamente lo que se intenta evitar.
 */
export const panGuardPlugin = fp(async (app: FastifyInstance) => {
  app.addHook('preValidation', async (request) => {
    // Cuerpo, QUERY y parámetros de ruta. Mirar solo el cuerpo dejaba abierto
    // el camino más corto que existe: `GET /members/search?q=<PAN>` no tiene
    // cuerpo, así que el guard no se disparaba, y la URL con su query entra
    // entera en el log de la petición. Recepción pegando un número en la caja
    // de búsqueda bastaba.
    const rutas = [
      ...findPanLike(request.body, '$body'),
      ...findPanLike(request.query, '$query'),
      ...findPanLike(request.params, '$params'),
    ];
    if (rutas.length === 0) return;

    request.log.warn(
      { paths: rutas, url: redactPanLike(request.url) },
      'petición rechazada: contiene algo con forma de tarjeta',
    );

    throw new DomainError(
      'VALIDATION',
      'La petición contiene algo con forma de número de tarjeta. ' +
      'GymFlow nunca recibe números de tarjeta: el socio los captura en el procesador.',
      `campos: ${rutas.join(', ')}`,
    );
  });
});
