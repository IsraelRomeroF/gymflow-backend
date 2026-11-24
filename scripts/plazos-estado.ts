/**
 * PLAZOS DEL SOCIO: QUÉ HARÍA EL PRIMER CIERRE DIARIO, SIN TOCAR NADA
 * (auditoría 8, fase 4, bloque 4.4; D-18).
 *
 * Solo lee. Para cada gimnasio dice, con sus plazos (los ajustados o los de
 * fábrica: 21 · 30 · 60 · 6 meses · 7 · 90):
 *   1. Las ventas sin cobrar que el cierre CANCELARÍA esta noche (antes
 *      esperaban 14 días; ahora 7): cuántas y cuánto importan sus cuotas, que
 *      se anulan (nunca se cobraron ni dieron acceso).
 *   2. La deuda que se DARÍA POR PERDIDA esta noche: la de membresías que ya
 *      terminaron por llevar suspendidas el plazo, más la de las suspendidas
 *      que lo cumplen hoy. Cuánto baja «Por cobrar». No se borra nada.
 *   3. Cuántos socios cuentan hoy como BAJA con la regla de D-18 y no tienen
 *      el acto «Dar de baja» en su ficha, y cuántos de ellos conservan su
 *      rostro guardado (la conservación, D-32, hoy solo cuenta desde el acto).
 *
 * Imprime códigos de socio, nunca nombres ni teléfonos. Es lo que hay que
 * mirar en una base ya en uso ANTES de dejar correr el cierre con la fase 4.
 *
 * Uso (desde ~/gymflow-backend; usa DATABASE_URL):
 *   pnpm exec tsx scripts/plazos-estado.ts
 *   pnpm exec tsx scripts/plazos-estado.ts --org <uuid> --detalle
 * Contra el uso real, con su perfil:
 *   bash scripts/perfil.sh uso-real ./node_modules/.bin/tsx scripts/plazos-estado.ts
 */
import { loadDotenvFromRepoRoot } from '../src/platform/load-env.js';

loadDotenvFromRepoRoot();

const args = process.argv.slice(2);
const iOrg = args.indexOf('--org');
const soloOrg = iOrg >= 0 ? args[iOrg + 1] ?? '' : null;
const detalle = args.includes('--detalle');
const conocidos = new Set(['--org', '--detalle', ...(soloOrg ? [soloOrg] : [])]);
const raros = args.filter((a) => !conocidos.has(a));
if (raros.length > 0 || (soloOrg !== null && !/^[0-9a-f-]{36}$/i.test(soloOrg))) {
  console.error(`Opción no reconocida: ${raros.join(' ') || '--org sin uuid'}. Se aceptan --org <uuid> y --detalle.`);
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('Falta DATABASE_URL.'); process.exit(2); }
const destino = (() => { try { const u = new URL(url); return `${u.pathname.replace(/^\//, '')} (${u.hostname}:${u.port || '5432'})`; } catch { return '(no se pudo leer DATABASE_URL)'; } })();

const { formatMoney, money } = await import('@gymflow/core');
const { getDb, closeDb } = await import('../src/platform/db/client.js');
const { BusinessCalendar } = await import('../src/platform/time/business-calendar.js');
const { PlazosDelSocioRepository } = await import('../src/platform/plazos/plazos-del-socio.repository.js');
const { MembershipRepository, BajaRepository } = await import('../src/modules/memberships/index.js');
const { DeudaPerdidaRepository, PortfolioRepository } = await import('../src/modules/billing/index.js');

const pesos = (c: bigint) => formatMoney(money(c));
const dia = (d: Date) => d.toISOString().slice(0, 10);

console.log(`Base: ${destino}`);
console.log('Solo lectura: este guion no cancela, no marca y no cambia ningún plazo.');

const db = getDb();
const gimnasios = await db.organization.findMany({
  where: soloOrg ? { id: soloOrg } : {}, select: { id: true, tradeName: true }, orderBy: { tradeName: 'asc' },
});
if (gimnasios.length === 0) console.log('No hay gimnasios que revisar.');

for (const g of gimnasios) {
  const plazos = await new PlazosDelSocioRepository(g.id).get();
  const t = plazos.terms;
  const calendario = new BusinessCalendar(g.id);
  const { gimnasio: hoy, grupos } = await calendario.dias();
  console.log(`\n── ${g.tradeName} · hoy ${dia(hoy)} ──`);
  console.log(`Plazos: dejó de venir ${t.dormantDays} d · baja ${t.churnDays} d · perdido ${t.lostDays} d · Recuperar ${t.winbackMonths} meses · venta sin cobrar ${t.unpaidSaleDays} d · deuda perdida ${t.lostDebtDays} d`
    + (plazos.customized.length ? ` (ajustados: ${plazos.customized.join(', ')})` : ' (todos de fábrica)'));

  // 1. Ventas sin cobrar.
  const membresias = new MembershipRepository(g.id);
  const ventas: Array<{ id: string; memberId: string; startDate: Date }> = [];
  for (const { day, sedes } of grupos) ventas.push(...await membresias.pendingOlderThan(day, t.unpaidSaleDays, 5000, sedes));
  const perdidas = new DeudaPerdidaRepository(g.id);
  const cuotasDeVentas = await perdidas.abiertosDeMembresias(ventas.map((v) => v.id));
  const importeVentas = cuotasDeVentas.reduce((a, c) => a + c.balanceCents, 0n);
  const yaConLaReglaVieja: typeof ventas = [];
  // 14 días era el plazo anterior, escrito en el job: aquí solo sirve para comparar.
  for (const { day, sedes } of grupos) yaConLaReglaVieja.push(...await membresias.pendingOlderThan(day, 14, 5000, sedes));
  console.log(`1. Ventas sin cobrar de más de ${t.unpaidSaleDays} días: ${ventas.length}. El cierre las CANCELA y anula sus cuotas (${pesos(importeVentas)} que dejan de contarse como deuda).`);
  console.log(`   De ellas, ${yaConLaReglaVieja.length} ya se habrían cancelado con la regla anterior (14 días); ${ventas.length - yaConLaReglaVieja.length} se cancelan antes por el plazo nuevo.`);

  // 2. Deuda que se da por perdida.
  const yaTerminadas = await perdidas.porMarcar(100_000);
  const porTerminar: Array<{ id: string }> = [];
  for (const { day, sedes } of grupos) porTerminar.push(...await membresias.suspendedOlderThan(day, t.lostDebtDays, 5000, sedes));
  const deHoy = await perdidas.abiertosDeMembresias(porTerminar.map((m) => m.id));
  const todos = [...yaTerminadas, ...deHoy];
  const importe = todos.reduce((a, c) => a + c.balanceCents, 0n);
  const socios = new Set(todos.map((c) => c.memberId));
  const cartera = await new PortfolioRepository(g.id).snapshot(hoy);
  const yaPerdida = await perdidas.resumen();
  console.log(`2. Deuda que el cierre daría por PERDIDA esta noche: ${pesos(importe)} en ${todos.length} cargo(s) de ${socios.size} socio(s).`);
  console.log(`   · de membresías que YA terminaron tras ${t.lostDebtDays} días suspendidas (atraso): ${pesos(yaTerminadas.reduce((a, c) => a + c.balanceCents, 0n))} en ${yaTerminadas.length} cargo(s)`);
  console.log(`   · de ${porTerminar.length} suspendida(s) que cumplen el plazo hoy y terminan: ${pesos(deHoy.reduce((a, c) => a + c.balanceCents, 0n))} en ${deHoy.length} cargo(s)`);
  console.log(`   «Por cobrar» hoy: ${pesos(cartera.totalOutstandingCents)} (${cartera.membersWithDebt} socios). Ya dada por perdida antes: ${pesos(yaPerdida.lostCents)} (${yaPerdida.lostMembers} socios).`);
  // 4.11 (edición puntual): la cartera ya cuenta también a los socios dados de baja en su ficha (D-12); ver `cartera-bajas-estado.ts`.
  console.log('   Nada se borra ni se condona: cada cargo conserva su saldo, sigue en el estado de cuenta del socio y se puede cobrar.');

  // 3. Bajas por plazo (para la decisión de la conservación, D-32).
  const conBaja = (await new BajaRepository(g.id).conBaja({ churnDays: t.churnDays, today: hoy })).filter((s) => s.baja !== null && !s.anonymized);
  const porCausa = { ARCHIVED: 0, CANCELED: 0, EXPIRED: 0 };
  for (const s of conBaja) porCausa[s.baja!.cause]++;
  const sinActo = conBaja.filter((s) => s.baja!.cause !== 'ARCHIVED');
  const conRostro = sinActo.length === 0 ? [] : await db.faceTemplate.findMany({
    where: { organizationId: g.id, memberId: { in: sinActo.map((s) => s.memberId) } }, select: { memberId: true }, distinct: ['memberId'],
  });
  console.log(`3. Socios que hoy cuentan como BAJA (D-18): ${conBaja.length} · dados de baja en su ficha ${porCausa.ARCHIVED} · cancelaron ${porCausa.CANCELED} · terminó hace ${t.churnDays} días o más sin renovar ${porCausa.EXPIRED}.`);
  console.log(`   Sin el acto «Dar de baja»: ${sinActo.length}; de ellos conservan su rostro guardado: ${conRostro.length}. La conservación (D-32) NO los toca: cuenta solo desde el acto de la ficha.`);

  if (detalle) {
    const codigos = new Map((await db.member.findMany({ where: { organizationId: g.id, id: { in: [...socios, ...ventas.map((v) => v.memberId)] } }, select: { id: true, memberCode: true } })).map((m) => [m.id, m.memberCode]));
    for (const v of ventas) console.log(`   venta sin cobrar · ${codigos.get(v.memberId) ?? v.memberId} · empezaba el ${dia(v.startDate)}`);
    const porSocio = new Map<string, bigint>();
    for (const c of todos) porSocio.set(c.memberId, (porSocio.get(c.memberId) ?? 0n) + c.balanceCents);
    for (const [id, c] of [...porSocio].sort((a, b) => (a[1] < b[1] ? 1 : -1))) console.log(`   deuda por perdida · ${codigos.get(id) ?? id} · ${pesos(c)}`);
    for (const s of sinActo) console.log(`   baja sin acto · ${s.memberCode} · ${s.baja!.cause === 'CANCELED' ? 'canceló' : 'terminó y no renovó'} · desde ${s.baja!.since}`);
  }
}
await closeDb();
