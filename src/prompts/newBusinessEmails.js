// Cold-email sequence for new-business leads (Connecticut LLCs). EDIT THE TEXTS HERE — the sending logic never touches them.
//
// Rules the copy follows:
//  - The demo website does NOT exist yet when email 0 goes out (it is built when the lead fills the form), so no email says
//    "ya está hecha / ya está lista / ya está diseñada". They promise the design and the demo (free, no commitment), not the price.
//  - The only link in the body is the form; the footer has the company name, postal address and the one-click unsubscribe link.

// Day (counted from the first email) on which each email goes out. Index = email number (0 = first email).
export const SEQUENCE_DAYS = [0, 3, 7, 12, 18, 25];
export const SEQUENCE_LENGTH = SEQUENCE_DAYS.length;

// Sector key (from the registry NAICS mapping) → Spanish label. "otro" has none: the copy then omits the sector.
const SECTOR_LABELS = {
  construccion: 'construcción',
  limpieza: 'limpieza',
  jardineria: 'jardinería',
  belleza: 'belleza',
  comida: 'comida',
  transporte: 'transporte',
  taxes: 'impuestos',
  auto: 'automoción',
  seguros: 'seguros',
  salud: 'salud',
  eventos: 'eventos',
};
export const sectorLabel = (sector) => SECTOR_LABELS[sector] ?? null;

const LOWER_WORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'and', 'of', 'the', 'a']);

// "EL RASPA ELECTROMECANICA LLC" → "El Raspa Electromecanica LLC". Names with mixed case are kept as registered.
export function displayName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (name !== name.toUpperCase()) return name;
  return name.toLowerCase().split(' ').map((w, i) => {
    if (['llc', 'inc', 'corp', 'ltd', 'llp'].includes(w.replace(/\./g, ''))) return w.toUpperCase();
    if (i > 0 && LOWER_WORDS.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

export const firstSubject = (lead) => `Enhorabuena por ${displayName(lead.name)} 🎉`;

const isRecent = (lead, now) => {
  if (!lead.registered_at) return true;
  const days = (now.getTime() - new Date(`${lead.registered_at}T00:00:00Z`).getTime()) / 86_400_000;
  return days <= 30;
};

// The paragraphs (before the footer) of email number `step`. `{form}` is replaced by the form URL.
function bodyParagraphs(lead, step, now) {
  const empresa = displayName(lead.name);
  const ciudad = lead.city || 'Connecticut';
  const label = sectorLabel(lead.sector);
  const deSector = label ? ` de ${label}` : '';
  const latina = lead.latino_strong
    ? '¡Enhorabuena por crear tu empresa en Estados Unidos y por aportar a nuestra comunidad latina!'
    : '¡Enhorabuena por crear tu empresa en Estados Unidos!';

  switch (step) {
    case 0:
      return [
        'Hola:',
        `Vimos en el registro público de empresas de Connecticut que ${isRecent(lead, now) ? 'acabas de registrar' : 'registraste recientemente'} ${empresa} en ${ciudad}. ${latina}`,
        `Nos gustaría diseñarte una web para ${empresa}, pensada para tu negocio${deSector}. El diseño y la demo son gratis y sin compromiso: te la preparamos en cuanto nos dejes tu teléfono.`,
        '¿Por qué? Porque hoy tus clientes te buscan en Google antes de contratarte. Si apareces en Google Maps y tienes una web profesional, confían en ti y te eligen antes que a la competencia. Y cuando quieras pedir financiamiento, los bancos también se fijan en si tu empresa se ve seria en internet.',
        'Me encantaría enseñártela. Déjame tu teléfono aquí y yo mismo te llamo: {form}',
      ];
    case 1:
      return [
        'Hola,',
        `¿Pudiste ver mi mensaje? Me encantaría prepararte la web de ${empresa} y enseñártela. Déjame tu teléfono y te llamo: {form}`,
      ];
    case 2:
      return [
        'Hola,',
        `Te cuento cómo sería tu web: la diseñaríamos para que salgan tus servicios${deSector} y tus clientes de ${ciudad} te encuentren en Google. Es mejor que la veas tú: déjame tu teléfono y te la enseño: {form}`,
      ];
    case 3:
      return [
        'Hola,',
        'Sé que al abrir una empresa no hay tiempo para nada. Si te va mejor, respóndeme a este email con un horario y te llamo yo.',
      ];
    case 4:
      return [
        'Hola,',
        `¿Te interesa ver la web de ${empresa}? Con un "sí" o un "no" me vale, así no te escribo más.`,
      ];
    case 5:
      return [
        'Hola,',
        `Este es mi último mensaje. Si en algún momento quieres ver la web que podemos diseñar para ${empresa}, aquí tienes el enlace: {form}`,
        'Mucho éxito con tu negocio.',
      ];
    default:
      throw new Error(`renderEmail: paso ${step} fuera de la secuencia (0-${SEQUENCE_LENGTH - 1})`);
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// → { subject, text, html }
// ctx: { formUrl, unsubUrl, senderName, companyName, companyAddress, now? }
export function renderEmail(lead, step, ctx) {
  for (const key of ['formUrl', 'unsubUrl', 'senderName', 'companyName', 'companyAddress']) {
    if (!ctx?.[key]) throw new Error(`renderEmail: falta ${key}`);
  }
  const now = ctx.now ?? new Date();
  const { formUrl, unsubUrl, senderName, companyName, companyAddress } = ctx;

  const paragraphs = bodyParagraphs(lead, step, now).map(p => p.replaceAll('{form}', formUrl));
  const signature = step === 0 ? `Un abrazo,\n${senderName} — ${companyName}` : senderName;
  const footerWhy = `Recibes este mensaje porque ${displayName(lead.name)} figura en el registro público de empresas del estado de Connecticut. Si no quieres recibir más correos, puedes darte de baja aquí: ${unsubUrl}`;
  const footerCompany = `${companyName} · ${companyAddress}`;

  const subject = step === 0 ? firstSubject(lead) : `Re: ${lead.first_subject || firstSubject(lead)}`;
  const text = [...paragraphs, signature, '--', footerCompany, footerWhy].join('\n\n');

  // Very simple HTML: paragraphs only, URLs shown as links, no images
  const link = (html) => html.replaceAll(escapeHtml(formUrl), `<a href="${escapeHtml(formUrl)}">${escapeHtml(formUrl)}</a>`);
  const p = (t, style = '') => `<p style="margin:0 0 14px;${style}">${link(escapeHtml(t)).replaceAll('\n', '<br>')}</p>`;
  const footerStyle = 'font-size:12px;color:#777;line-height:1.5;';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#222">
${paragraphs.map(t => p(t)).join('\n')}
${p(signature)}
<hr style="border:0;border-top:1px solid #ddd;margin:20px 0">
${p(footerCompany, footerStyle)}
<p style="margin:0;${footerStyle}">${escapeHtml(footerWhy).replace(escapeHtml(unsubUrl), `<a href="${escapeHtml(unsubUrl)}">${escapeHtml(unsubUrl)}</a>`)}</p>
</div>`;

  return { subject, text, html };
}
