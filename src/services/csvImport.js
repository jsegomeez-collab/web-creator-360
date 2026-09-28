// Import leads from a CSV (e.g. the file the Python script writes) with a column mapping: for every field of a lead you
// say which CSV column holds it. Column names are guessed from common names (Spanish or English) and can be changed.
import { parseCsv } from '../lib/csv.js';
import { SECTORES, codigoNaics, sectorDe, senalesLatinas, titleCase } from './ctRegistry.js';
import { storeLeads, summarizeLeads } from './newLeads.js';

export const CSV_SOURCE = 'csv_import';
export const MAX_ROWS = 20000;
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

// The lead fields a column can be assigned to. `aliases` are the header names that get picked automatically.
export const LEAD_FIELDS = [
  { key: 'name', label: 'Nombre de la empresa', required: true, aliases: ['empresa', 'name', 'nombre', 'nombre_empresa', 'business_name', 'company', 'company_name', 'razon_social'] },
  { key: 'email', label: 'Email', required: true, aliases: ['email', 'correo', 'correo_electronico', 'e_mail', 'business_email_address', 'email_address'] },
  { key: 'city', label: 'Ciudad', aliases: ['ciudad', 'city', 'billingcity', 'municipio'] },
  { key: 'zip', label: 'Código postal', aliases: ['zip', 'zipcode', 'zip_code', 'cp', 'codigo_postal', 'postal', 'postalcode', 'billingpostalcode'] },
  { key: 'address', label: 'Dirección', aliases: ['direccion', 'address', 'billingstreet', 'calle', 'street'] },
  { key: 'registered_at', label: 'Fecha de registro', aliases: ['fecha_registro', 'date_registration', 'fecha', 'registered', 'registered_at', 'registration_date'] },
  { key: 'naics_code', label: 'Actividad (NAICS)', aliases: ['actividad_naics', 'naics_code', 'naics', 'actividad'] },
  { key: 'sector', label: 'Sector', aliases: ['sector', 'categoria', 'category'] },
  { key: 'priority', label: 'Prioridad (A / B)', aliases: ['prioridad', 'priority'] },
  { key: 'external_id', label: 'ID único (evita duplicados)', aliases: ['id_ct', 'accountnumber', 'account_number', 'external_id', 'id'] },
  { key: 'latino_signal', label: 'Señal latina', aliases: ['senal_latina', 'latina', 'latino', 'latino_signal'] },
  { key: 'minority_owned', label: 'Minoría declarada', aliases: ['declara_minoria', 'minority_owned', 'minoria', 'minority_owned_organization'] },
];
const REQUIRED = LEAD_FIELDS.filter(f => f.required).map(f => f.key);

// "Señal Latina" / "señal_latina" / "senal-latina" → "senal_latina"
const norm = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// { fieldKey: headerName | null }: first header whose name matches an alias; a column is never used for two fields
export function suggestMapping(headers) {
  const byNorm = new Map();
  headers.forEach(h => { if (!byNorm.has(norm(h))) byNorm.set(norm(h), h); });
  const used = new Set();
  const mapping = {};
  for (const field of LEAD_FIELDS) {
    const hit = field.aliases.map(a => byNorm.get(a)).find(h => h && !used.has(h));
    mapping[field.key] = hit ?? null;
    if (hit) used.add(hit);
  }
  return mapping;
}

// ─── Value cleaning ──────────────────────────────────────────────────────────

const NOT_TRUE = new Set(['', 'no', 'false', '0', 'n', 'none', 'null', 'nan', '-']);
const truthy = (v) => !NOT_TRUE.has(norm(v));

// Sector column → one of our sector keys ("Construcción", "construccion", "limpieza"…) or '' when it isn't one of them
const SECTOR_KEYS = new Set([...Object.keys(SECTORES), 'otro']);
const sectorKey = (raw) => { const k = norm(raw); return SECTOR_KEYS.has(k) ? k : ''; };

// 2026-09-14 · 2026-09-14T00:00:00.000 · 09/14/2026 (US) · 14/09/2026 (when the first number can't be a month) → YYYY-MM-DD | null
export function parseDate(raw) {
  const s = String(raw ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let y, mo, d;
  if (m) [, y, mo, d] = m;
  else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/))) {
    const a = +m[1], b = +m[2];
    [mo, d] = a > 12 ? [b, a] : [a, b];
    y = m[3];
  } else return null;
  const iso = `${y}-${String(+mo).padStart(2, '0')}-${String(+d).padStart(2, '0')}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso ? null : iso;
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

// → { leads, invalid: [{ line, name, reason }] }.  `line` is the line number in the file (header = line 1).
export function mapRows(rows, mapping) {
  const get = (row, key) => (mapping[key] ? String(row[mapping[key]] ?? '').trim() : '');
  const leads = [];
  const invalid = [];

  rows.forEach((row, i) => {
    const line = i + 2;
    const name = get(row, 'name');
    const email = get(row, 'email').toLowerCase();
    const bad = (reason) => invalid.push({ line, name: name || email || '(sin nombre)', reason });

    if (!name) return bad('sin nombre de empresa');
    if (!EMAIL_RE.test(email)) return bad('email vacío o inválido');
    const priorityRaw = get(row, 'priority').toUpperCase();
    if (priorityRaw === 'DESCARTAR') return bad('descartada (prioridad DESCARTAR)');

    const naics = get(row, 'naics_code');
    const sector = sectorKey(get(row, 'sector')) || sectorDe(codigoNaics(naics)) || 'otro';
    const signal = senalesLatinas(name, email);
    const signalText = get(row, 'latino_signal');
    const city = get(row, 'city');

    leads.push({
      external_id: get(row, 'external_id') || `csv:${email}`,
      name,
      email,
      city: city && city === city.toUpperCase() ? titleCase(city) : city,
      zip: get(row, 'zip').slice(0, 5),
      address: get(row, 'address'),
      registered_at: parseDate(get(row, 'registered_at')),
      naics_code: naics,
      sector,
      priority: ['A', 'B'].includes(priorityRaw) ? priorityRaw : (sector === 'otro' ? 'B' : 'A'),
      latino_signal: truthy(signalText) || signal.reasons.length > 0,
      latino_strong: signal.nameMatch,                       // Spanish words in the BUSINESS NAME: same definition as the registry
      minority_owned: truthy(get(row, 'minority_owned')),
      notes: truthy(signalText) ? `señal latina: ${signalText}` : (signal.reasons.length ? `señal latina: ${signal.reasons.join(' + ')}` : null),
    });
  });
  return { leads, invalid };
}

// ─── Preview and import ──────────────────────────────────────────────────────

// What sends a single import apart from the others, so "Envío" can target just this list.
// "prueba-lead.csv · 2026-09-29 15:32" — the minute is enough to tell two imports apart; a second import of the same
// file a minute later just gets a different label, which is fine (nothing keys off it besides being distinct).
export function buildBatchLabel(filename, now = new Date()) {
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  const name = String(filename ?? '').trim().slice(0, 80);
  return `${name || 'CSV'} · ${stamp}`;
}

export function previewCsv(csv) {
  const { headers, rows, delimiter } = parseCsv(csv);
  if (!headers.length) throw new Error('El archivo está vacío o no es un CSV');
  if (!rows.length) throw new Error('El CSV solo tiene la fila de cabecera: no hay datos');
  return {
    headers,
    delimiter,
    totalRows: rows.length,
    sample: rows.slice(0, 5),
    suggestedMapping: suggestMapping(headers),
    fields: LEAD_FIELDS.map(({ key, label, required }) => ({ key, label, required: !!required })),
  };
}

// mapping: { fieldKey: headerName | null }. With dryRun nothing is written ("what would happen").
// filename: the original file name, shown in "Envío" so you can send just this import; falls back to "CSV" without it.
export async function importCsvLeads({ db, ownerId, csv, mapping, dryRun = false, verify = true, verifyOptions = {}, filename = '', now = new Date() }) {
  const { headers, rows } = parseCsv(csv);
  if (!rows.length) throw new Error('El CSV no tiene filas de datos');
  if (rows.length > MAX_ROWS) throw new Error(`El CSV tiene ${rows.length} filas; el máximo por importación es ${MAX_ROWS}`);

  const clean = {};
  for (const field of LEAD_FIELDS) {
    const col = mapping?.[field.key];
    if (col && !headers.includes(col)) throw new Error(`La columna "${col}" (asignada a "${field.label}") no existe en el archivo`);
    clean[field.key] = col || null;
  }
  const missing = REQUIRED.filter(k => !clean[k]).map(k => LEAD_FIELDS.find(f => f.key === k).label);
  if (missing.length) throw new Error(`Falta asignar una columna a: ${missing.join(', ')}`);

  const { leads, invalid } = mapRows(rows, clean);
  const batch = buildBatchLabel(filename, now);
  for (const l of leads) l.import_batch = batch;
  const stored = await storeLeads({ db, ownerId, source: CSV_SOURCE, candidates: leads, dryRun, verify, verifyOptions });

  return {
    dryRun,
    batch,
    totalRows: rows.length,
    invalidCount: invalid.length,
    invalid: invalid.slice(0, 50),                            // enough to show what's wrong without flooding the screen
    skipped: stored.skipped,
    invalidEmailCount: stored.invalid.length,
    invalidReasons: stored.invalidReasons,
    valid: stored.valid.length,                               // enter as "new"
    inserted: stored.inserted,
    summary: summarizeLeads(stored.valid),
    notes: stored.notes,
  };
}
