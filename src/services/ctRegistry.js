// Connecticut Business Registry (Socrata open data): download + filtering of new companies.
// Port of scripts/llcs_connecticut_con_email.py — same filters, same detection. Pure functions except fetchRegistrations().
//
// Dataset "Business Master": https://data.ct.gov/resource/n7gp-d28j.json

export const CT_SOURCE = 'ct_registry';
export const API_URL = 'https://data.ct.gov/resource/n7gp-d28j.json';

// Registered-agent / filing-service emails: they belong to the agency, not the owner
export const DOMINIOS_GESTORIA = new RegExp(
  'incfile|zenbusiness|legalzoom|cscglobal|cscinfo|northwestregisteredagent|registeredagentsinc|'
  + 'wolterskluwer|cogencyglobal|tailorbrands|swyftfilings|usa-llc-filing|corporatedocfiling|incorp\\.com|'
  + 'unitedagentgroup|corpcreations|rasi\\.com|bizee|northwest|registeredagent|harborcompliance|'
  + 'inc-?authority|mycompanyworks|govdocs|compliance',
  'i',
);

// Sector by NAICS prefix (the 6-digit code sits inside the text, e.g. "Janitorial Services (561720)")
export const SECTORES = {
  construccion: ['2361', '2362', '238'],
  limpieza:     ['561720', '561740', '561790'],
  jardineria:   ['561730'],
  belleza:      ['8121'],
  comida:       ['722', '3118'],
  transporte:   ['484', '4921', '4922', '4885'],
  taxes:        ['5412'],
  auto:         ['8111', '4411', '4412'],
  seguros:      ['5242'],
  salud:        ['621'],
  eventos:      ['5413', '7113', '5419', '8129'],
};
// Holdings, real-estate rental, investment vehicles: they don't buy a website
export const NAICS_EXCLUIR = ['5311', '5239', '5511', '5251', '5259'];

export const APELLIDOS = `
garcia rodriguez martinez hernandez lopez gonzalez perez sanchez ramirez torres flores rivera
gomez diaz reyes morales cruz ortiz gutierrez chavez ramos ruiz alvarez mendoza vasquez vazquez
castillo jimenez moreno romero herrera medina aguilar garza castro vargas fernandez guzman munoz
mendez salazar soto delgado pena rios alvarado sandoval contreras valdez guerrero ortega estrada
nunez maldonado vega dominguez luna rojas figueroa cabrera espinoza espinosa carrillo avila acosta
campos cervantes navarro fuentes marquez cortez cortes santiago rosales padilla molina suarez
juarez salinas solis cardenas pacheco miranda ibarra velasquez velazquez arias zamora orozco
cisneros trujillo calderon montoya benitez barrera villarreal rosario colon serrano duran ochoa
galvan hidalgo bautista paredes pineda zuniga macias valencia ayala beltran esquivel quintero
robles ponce rangel escobar bermudez villanueva gallegos mejia osorio tapia cuevas arellano
camacho lozano palacios quintana pizarro zapata rincon andrade barajas bonilla caballero
carrasco corona enriquez esparza gallardo granados guevara huerta lucero magana olivares
pantoja quiroz renteria rubio saldana santana segura tovar urbina zavala zepeda aguirre
arroyo bustamante chacon cordova cuellar duarte echeverria escamilla fajardo jaramillo
medrano montalvo murillo najera noriega ocampo perales quezada saenz sepulveda toledo uribe
valenzuela zarate carranza portillo henriquez amaya gonzales rodrigues machado betancourt
quinones feliciano melendez negron velez rosado burgos matos marrero irizarry pagan
`.trim().split(/\s+/);

// Latin agencies that register many clients' companies with their own email
export const EMAILS_GESTOR = new Set(['taxcenterct@gmail.com']);

// Names of holding / financial vehicles
export const RE_NO_OPERATIVA = /holding|propert|investment|funding|rentals|realty|capital|equity|trust\b|limited liability partnership|enterprise management/i;

// Spanish words in the business name. Word boundaries matter: "Remi" must not match "mi".
export const RE_ESPANOL = /servicios|latin[oa]|hispan|familia|nuestra|\blos\b|\blas\b|\bdel\b|\bel\b|y\s+m[aá]s|limpieza|construccion|jardin|panaderia|taqueria|belleza|mudanza|mecanica|seguros|boricua|sabor|cocina|\bcasa\b|\bmi\s/i;

// ─── Small helpers (mirror the Python ones) ──────────────────────────────────

// lower-case, accents removed, trimmed
export function limpiar(t) {
  return String(t ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// "Janitorial Services (561720)" → "561720"
export function codigoNaics(texto) {
  const m = String(texto ?? '').match(/(\d{6})/);
  return m ? m[1] : '';
}

export function sectorDe(naics) {
  for (const [nombre, prefijos] of Object.entries(SECTORES)) {
    if (prefijos.some(p => naics.startsWith(p))) return nombre;
  }
  return '';
}

// Python's str.title(): "new britain" → "New Britain", "o'neil" → "O'Neil"
export function titleCase(s) {
  return String(s ?? '').toLowerCase().replace(/(^|[^a-zà-ÿ])([a-zà-ÿ])/g, (_, pre, ch) => pre + ch.toUpperCase());
}

// Latino signals from the business name and the email.
// → { reasons: ["nombre: 'el'", "email: ramos"], nameMatch, emailMatch }
export function senalesLatinas(nombre, email) {
  const reasons = [];
  const m = limpiar(nombre).match(RE_ESPANOL);
  if (m) reasons.push(`nombre: '${m[0].trim()}'`);

  const local = limpiar(String(email).split('@')[0]);
  const tokens = new Set(local.split(/[^a-z]+/));
  const letras = local.replace(/[^a-z]/g, '');
  // Exact word; or at the start/end of the email (5+ letters); or in the middle only if long (7+)
  const encontrado =
    APELLIDOS.find(a => tokens.has(a))
    || APELLIDOS.find(a => a.length >= 5 && (letras.startsWith(a) || letras.endsWith(a)))
    || APELLIDOS.find(a => a.length >= 7 && letras.includes(a));
  if (encontrado) reasons.push(`email: ${encontrado}`);

  return { reasons, nameMatch: !!m, emailMatch: !!encontrado };
}

// ─── Classification ──────────────────────────────────────────────────────────

// Turns raw registry rows into lead candidates, applying the Python script's filters in the same order.
// Options: latinOnly (default true) keeps only leads with a Latino signal.
export function classifyRegistrations(rows, { latinOnly = true } = {}) {
  const stats = {
    raw: rows.length, noEmail: 0, gestoriaDomain: 0, sharedEmail: 0, nonOperating: 0, notLatino: 0, kept: 0,
  };

  // An email shared by 4+ new companies of the batch is an agency, not the owner
  const repeats = new Map();
  for (const f of rows) {
    const k = String(f.business_email_address ?? '').trim().toLowerCase();
    repeats.set(k, (repeats.get(k) || 0) + 1);
  }

  const leads = [];
  for (const f of rows) {
    let email = String(f.business_email_address ?? '').trim();
    if (!email || !email.includes('@')) { stats.noEmail++; continue; }

    if (DOMINIOS_GESTORIA.test(email)) {
      const alt = String(f.category_survey_email_address ?? '').trim();
      if (alt && alt.includes('@') && !DOMINIOS_GESTORIA.test(alt)) email = alt;
      else { stats.gestoriaDomain++; continue; }
    }
    if (EMAILS_GESTOR.has(email.toLowerCase()) || (repeats.get(email.toLowerCase()) || 0) >= 4) {
      stats.sharedEmail++;
      continue;
    }

    const naics = codigoNaics(f.naics_code);
    if (NAICS_EXCLUIR.some(p => naics.startsWith(p)) || RE_NO_OPERATIVA.test(f.name ?? '')) {
      stats.nonOperating++;
      continue;
    }

    const sector = sectorDe(naics);
    const nombre = f.name ?? '';
    const signal = senalesLatinas(nombre, email);
    if (latinOnly && !signal.reasons.length) { stats.notLatino++; continue; }

    leads.push({
      external_id: String(f.accountnumber ?? ''),
      name: nombre,
      email: email.toLowerCase(),
      city: titleCase(f.billingcity),
      zip: String(f.billingpostalcode ?? '').slice(0, 5),
      address: f.billingstreet ?? '',
      registered_at: String(f.date_registration ?? '').slice(0, 10) || null,
      naics_code: f.naics_code ?? '',
      sector: sector || 'otro',
      priority: sector ? 'A' : 'B',
      latino_signal: signal.reasons.length > 0,
      latino_strong: signal.nameMatch,
      minority_owned: f.minority_owned_organization === true || String(f.minority_owned_organization).toLowerCase() === 'true',
      notes: signal.reasons.length ? `señal latina: ${signal.reasons.join(' + ')}` : null,
    });
    stats.kept++;
  }

  // Most recent registrations first
  leads.sort((a, b) => String(b.registered_at).localeCompare(String(a.registered_at)));
  return { leads, stats };
}

// ─── Download ────────────────────────────────────────────────────────────────

const sleepDefault = (ms) => new Promise(r => setTimeout(r, ms));

// All Active companies with an email registered on/after `since` ("YYYY-MM-DD"), newest first, paginated.
// `$order` includes accountnumber as a tie-breaker so $offset paging never repeats or skips rows.
export async function fetchRegistrations({
  since, pageSize = 5000, maxPages = 100, appToken = process.env.SOCRATA_APP_TOKEN,
  fetchImpl = globalThis.fetch, sleep = sleepDefault, retries = 3,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since || '')) throw new Error(`fetchRegistrations: "since" debe ser YYYY-MM-DD (recibido: ${since})`);

  const where = `status = 'Active' AND business_email_address IS NOT NULL AND date_registration >= '${since}T00:00:00'`;
  const headers = { Accept: 'application/json', ...(appToken ? { 'X-App-Token': appToken } : {}) };
  const all = [];

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      $where: where,
      $order: 'date_registration DESC, accountnumber',
      $limit: String(pageSize),
      $offset: String(page * pageSize),
    });

    let rows;
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${API_URL}?${params}`, { headers });
      } catch (err) {
        if (attempt >= retries) throw new Error(`No se pudo consultar data.ct.gov: ${err.message}`);
        await sleep(1000 * attempt);
        continue;
      }
      if (res.ok) { rows = await res.json(); break; }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) { await sleep(1000 * attempt); continue; }
      throw new Error(`data.ct.gov respondió ${res.status}${res.status === 429 ? ' (límite de peticiones: pon SOCRATA_APP_TOKEN)' : ''}`);
    }

    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
  throw new Error(`fetchRegistrations: se alcanzó el máximo de ${maxPages} páginas`);
}
