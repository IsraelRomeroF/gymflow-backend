/**
 * El EQUIPO de una sesión, en palabras de quien la abrió: «iPhone · Safari»,
 * «Windows · Chrome» (24-05).
 *
 * Antes la lista de sesiones decía «Otro equipo» en todas, y quien revisaba
 * «¿hay alguien más en mi cuenta?» no podía distinguir su teléfono de una
 * intrusión. Se deduce del navegador (user-agent), que lo manda solo; no es
 * una prueba de nada, es una pista para reconocer los propios equipos.
 *
 * El orden de las preguntas importa: Edge y Opera también dicen «Chrome», y
 * Chrome también dice «Safari».
 */
export function equipoDe(userAgent: string | null | undefined): string | null {
  const ua = userAgent ?? '';
  if (!ua.trim()) return null;

  let aparato: string | null = null;
  if (/iPhone/.test(ua)) aparato = 'iPhone';
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))) aparato = 'iPad';
  else if (/Android/.test(ua)) aparato = /Mobile/.test(ua) ? 'Teléfono Android' : 'Tableta Android';
  else if (/CrOS/.test(ua)) aparato = 'Chromebook';
  else if (/Windows/.test(ua)) aparato = 'Windows';
  else if (/Macintosh|Mac OS X/.test(ua)) aparato = 'Mac';
  else if (/Linux/.test(ua)) aparato = 'Linux';

  let navegador: string | null = null;
  if (/Edg(e|A|iOS)?\//.test(ua)) navegador = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) navegador = 'Opera';
  else if (/SamsungBrowser\//.test(ua)) navegador = 'Samsung Internet';
  else if (/Firefox\/|FxiOS\//.test(ua)) navegador = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(ua)) navegador = 'Chrome';
  else if (/Safari\//.test(ua)) navegador = 'Safari';

  if (!aparato && !navegador) return null;
  return [aparato, navegador].filter(Boolean).join(' · ');
}
