// The (single) cold email of the new-business campaign. Instantly sends it, so the text lives in the Instantly campaign:
// paste EMAIL_SUBJECT / EMAIL_BODY there (`npm run leads:email-template` prints them). {{variables}} are filled by Instantly
// from the values we push for each lead (see leadVariables). EDIT THE TEXT HERE, then paste it again in Instantly.

export const EMAIL_SUBJECT = 'Enhorabuena por {{empresa}} 🎉';

export const EMAIL_BODY = `Hola:

Vimos que acabas de registrar {{empresa}} en {{ciudad}}. ¡Enhorabuena por crear tu empresa en Estados Unidos{{latina}}!

Nos tomamos la libertad de diseñarte una web para {{empresa}}, totalmente gratis y sin compromiso. Ya está hecha, pensada para tu negocio{{sector_de}}.

¿Por qué? Porque hoy tus clientes te buscan en Google antes de contratarte. Si apareces en Google Maps y tienes una web profesional, confían en ti y te eligen antes que a la competencia. Y cuando quieras pedir financiamiento, los bancos también se fijan en si tu empresa se ve seria en internet.

Me encantaría enseñártela. Agenda una llamada de 15 minutos aquí y te la muestro en directo: {{calendario}}

Un abrazo,
Jose — Get ur Web

TRUDSALES LLC (dba Get ur Web) · 7901 4th St N, St. Petersburg, FL 33702, EE. UU.`;

// Sector key (from the registry NAICS mapping) → Spanish label. "otro" has none: the text then just says "tu negocio".
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

// The values Instantly puts into the {{variables}} for one lead. `linkUrl` is that lead's own link (the page to ask for the call).
export function leadVariables(lead, linkUrl) {
  const label = sectorLabel(lead.sector);
  return {
    empresa: displayName(lead.name),
    ciudad: lead.city || 'Connecticut',
    latina: lead.latino_strong ? ' y por aportar a nuestra comunidad latina' : '',
    sector_de: label ? ` de ${label}` : '',
    calendario: linkUrl,
  };
}

// {{names}} used by the subject and body
export const templateVariables = () => [...new Set([...`${EMAIL_SUBJECT}\n${EMAIL_BODY}`.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))];

const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
  if (!(key in vars)) throw new Error(`Falta la variable {{${key}}}`);
  return vars[key];
});

// What one lead will read (same substitution Instantly does) — for previews and tests
export function renderEmail(lead, linkUrl) {
  const vars = leadVariables(lead, linkUrl);
  return { subject: fill(EMAIL_SUBJECT, vars), body: fill(EMAIL_BODY, vars) };
}
