import { loadEnv } from '../../platform/env.js';
import { FaceTemplateRepository } from './face-template.repository.js';

/**
 * LOS ROSTROS QUE APAGAR BIOMETRÍA BORRARÍA (D-32, paréntesis; bloque 3.12).
 *
 * Apagada en TODO el gimnasio: todos los rostros guardados. Apagada en UNA
 * sucursal: los que se tomaron ahí, pero solo si la cámara de cada sucursal
 * reconoce únicamente a los suyos (`FACE_RECOGNITION_SCOPE=branch`, lo de
 * siempre). Si la instalación reconoce en todo el gimnasio, un rostro tomado
 * en la sucursal que se apaga sigue sirviendo en las demás: ni deja de
 * reconocerse ni se borra, y entonces no hay nada que avisar.
 *
 * Lo usan el aviso de la pantalla Módulos (cuántos) y el cierre diario
 * (cuáles): la misma cuenta en los dos lados.
 */
export async function rostrosQueBorraApagar(organizationId: string, branchId?: string | null): Promise<Array<{ enrollmentId: string; memberId: string; branchId: string }>> {
  if (branchId && loadEnv().FACE_RECOGNITION_SCOPE === 'organization') return [];
  return new FaceTemplateRepository(organizationId).guardadas(branchId ?? null);
}
