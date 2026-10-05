// The (single) cold email of the new-business campaign. Instantly sends it, so the text lives in the Instantly campaign:
// paste the subject and body there (`npm run leads:email-template` prints them). {{variables}} are filled by Instantly
// from the values we push for each lead (see leadVariables). EDIT THE TEXT HERE, then paste it again in Instantly.
// Two versions: the classic one (a link to ask for a call) and the DEMO one (LEAD_DEMOS=true: a link to the lead's own
// website, already published). emailTemplate({ demos }) returns the one in use.

export const EMAIL_SUBJECT = 'Enhorabuena por {{empresa}} 🎉';

export const EMAIL_BODY = `Hola:

Vimos que acabas de registrar {{empresa}} en {{ciudad}}. ¡Enhorabuena por crear tu empresa en Estados Unidos{{latina}}!

Nos tomamos la libertad de diseñarte una web para {{empresa}}, totalmente gratis y sin compromiso. Ya está hecha, pensada para tu negocio{{sector_de}}.

¿Por qué? Porque hoy tus clientes te buscan en Google antes de contratarte. Si apareces en Google Maps y tienes una web profesional, confían en ti y te eligen antes que a la competencia. Y cuando quieras pedir financiamiento, los bancos también se fijan en si tu empresa se ve seria en internet.

Me encantaría enseñártela. Agenda una llamada de 15 minutos aquí y te la muestro en directo: {{calendario}}

Un abrazo,
Jose — Get ur Web

TRUDSALES LLC (dba Get ur Web) · 7901 4th St N, St. Petersburg, FL 33702, EE. UU.`;

// DEMO version: the website is really made and published before the email goes out; {{web}} is its address.
// One link only (better for deliverability): the "La quiero" bar inside the demo leads to the page to ask for the call.
export const EMAIL_SUBJECT_DEMO = 'Enhorabuena por {{empresa}} 🎉';

export const EMAIL_BODY_DEMO = `Buenas {{nombre}}!


Vi que acabas de registrar {{empresa}} en {{ciudad}}.
¡Felicidades por arrancar tu empresa en Estados Unidos!


Me adelanté y te diseñé una web pensada para tu negocio{{sector_de}}, en inglés y en español. Puedes verla aquí


{{web}}


Las fotos y algunos datos son de ejemplo. Si te gusta, la dejo con tus fotos, tu teléfono y tus servicios, y te doy de alta en Google Maps para que te encuentren los clientes de {{ciudad}}.


Hoy la gente busca en Google antes de contratar a nadie, y el negocio que sale en Maps con web propia es el que recibe la llamada. Además, cuando pidas financiamiento, el banco también verá tu web


La mantengo online 7 días. Si la quieres, respóndeme "SI" junto a tu phone number y te llamo para ajustarla contigo.


Un abrazo,
Jose
Get ur Web


TRUDSALES LLC (dba Get ur Web) · 7901 4th St N, St. Petersburg, FL 33702, USA`;

export const emailTemplate = ({ demos = false } = {}) => (demos
  ? { subject: EMAIL_SUBJECT_DEMO, body: EMAIL_BODY_DEMO }
  : { subject: EMAIL_SUBJECT, body: EMAIL_BODY });

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

// The address of a lead's demo website as it goes in the email: opens in Spanish (the owner reads the email in Spanish)
export const demoLink = (demoUrl) => (demoUrl ? `${String(demoUrl).replace(/\/+$/, '')}/?lang=es` : '');

// The values Instantly puts into the {{variables}} for one lead. `linkUrl` is that lead's own link (the page to ask for the call).
// `web` is its demo website ('' until it exists), so both versions of the email can be filled from the same values.
export function leadVariables(lead, linkUrl) {
  const label = sectorLabel(lead.sector);
  return {
    empresa: displayName(lead.name),
    ciudad: lead.city || 'Connecticut',
    latina: lead.latino_strong ? ' y por aportar a nuestra comunidad latina' : '',
    sector_de: label ? ` de ${label}` : '',
    calendario: linkUrl,
    web: demoLink(lead.demo_url),
    // The registry gives no owner name: greet the business ("Buenas equipo de X!") unless a contact name is known
    nombre: String(lead.contact_name || '').trim().split(/\s+/)[0] || `equipo de ${displayName(lead.name)}`,
  };
}

// {{names}} used by the subject and body of one version
export const templateVariables = ({ demos = false } = {}) => {
  const { subject, body } = emailTemplate({ demos });
  return [...new Set([...`${subject}\n${body}`.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))];
};

const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
  if (!(key in vars)) throw new Error(`Falta la variable {{${key}}}`);
  return vars[key];
});

// What one lead will read (same substitution Instantly does) — for previews and tests
export function renderEmail(lead, linkUrl, { demos = false } = {}) {
  const vars = leadVariables(lead, linkUrl);
  const { subject, body } = emailTemplate({ demos });
  return { subject: fill(subject, vars), body: fill(body, vars) };
}
