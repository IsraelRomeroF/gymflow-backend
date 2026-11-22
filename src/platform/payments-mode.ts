import { procesadorEnUso } from './perfiles.js';

/**
 * ¿Qué procesador de pagos corre? La misma regla que `PAYMENT_PROVIDER` en
 * `env.ts` (`platform/perfiles.ts`): sin valor, la caja de arena solo con una
 * base de pruebas y nunca en producción. Si alguien la pidió donde no vale
 * —el uso real, `gymflow_local`— aquí se responde `none`: ante la duda no se
 * cobra. La API ni siquiera arranca así; esto cubre a quien pregunta sin
 * pasar por `loadEnv`, como el cierre diario.
 *
 * Vive en la plataforma y no en `payments` porque lo preguntan varios
 * módulos (el portal antes de ofrecer domiciliar) y no deben importar las
 * entrañas del procesador.
 */
export function paymentProviderKind(): 'none' | 'sandbox' {
  return procesadorEnUso(process.env);
}

/** ¿Se puede cobrar con tarjeta en línea? */
export function onlinePaymentsEnabled(): boolean {
  return paymentProviderKind() !== 'none';
}
