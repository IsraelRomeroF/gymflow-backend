import { registrarEfectoDeRetiro } from '../members/index.js';
import { EnrollmentService } from '../access/index.js';
import { PaymentMethodRepository } from '../payments/index.js';

/**
 * LO QUE PASA AL RETIRAR UN PERMISO, fuera de la ficha del socio (auditoría 8,
 * bloque 1.10; 21-10, 21-11). Socios no conoce a pagos ni a acceso (dependen
 * de él); privacidad sí, y por eso inscribe aquí, al arrancar, lo que cada uno
 * ejecuta. Así retirar desde la ficha, desde el portal o por una solicitud
 * ARCO hace exactamente lo mismo.
 *
 *  · Cargo recurrente → ninguna tarjeta queda cobrable (antes solo desde el portal).
 *  · Biometría → se revocan sus rostros y huellas y la plantilla del servidor
 *    se borra en el acto (antes el permiso se podía «retirar» y el rostro seguía abriendo).
 *  · Salud (borrar la nota) lo hace socios mismo: la nota es suya.
 */
let inscritos = false;

export function inscribirEfectosDeRetiro(): void {
  if (inscritos) return;
  inscritos = true;

  registrarEfectoDeRetiro('RECURRING_CHARGE', async (ctx, memberId) => {
    const tarjetas = await new PaymentMethodRepository(ctx.tenant.organizationId).revokeAllForMember(memberId, 'Se retiró el cargo recurrente');
    return { cardsRevoked: tarjetas };
  });

  registrarEfectoDeRetiro('BIOMETRIC', async (ctx, memberId, motivo) => {
    const r = await new EnrollmentService().revokeAllForMember(ctx, memberId, `Retiró su consentimiento biométrico: ${motivo}`.slice(0, 300));
    return { enrollmentsRevoked: r.revocados, faceTemplatesDeleted: r.plantillasBorradas };
  });
}
