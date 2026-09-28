// API del pipeline "LLCs nuevas" del dashboard: contadores, listado con filtros, estados manuales, ingesta CT, CSV y envío a Instantly.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { createLeadsRouter } from '../src/routes/leads.js';
import { clearDomainCache } from '../src/services/emailVerify.js';

const OWNER = 'owner-1';
const OTHER = 'owner-2';
const mx = [{ exchange: 'mx.example.com', priority: 10 }];
const resolver = {
  resolveMx: async (d) => { if (d === 'gmail.com') return mx; throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); },
  resolve4: async () => { throw Object.assign(new Error('x'), { code: 'ENODATA' }); },
  resolve6: async () => { throw Object.assign(new Error('x'), { code: 'ENODATA' }); },
};
const verifyOptions = { resolver, provider: async () => null };

// Descarga falsa del registro de Connecticut: una sola página con dos empresas
const registryRow = (n, o = {}) => ({
  name: `Limpieza ${n} LLC`, accountnumber: String(n), status: 'Active', date_registration: '2026-09-14T00:00:00.000',
  business_email_address: `dueno${n}@gmail.com`, category_survey_email_address: '', naics_code: 'Janitorial Services (561720)',
  minority_owned_organization: false, billingstreet: '1 Main St', billingcity: 'HARTFORD', billingpostalcode: '06103', ...o,
});
let registryCalls = [];
const fetchImpl = async (url) => {
  registryCalls.push(String(url));
  const offset = Number(new URL(url).searchParams.get('$offset') || 0);
  const rows = offset === 0 ? [registryRow(1), registryRow(2)] : [];
  return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
};

let db, server, base;
const lead = (id, o = {}) => ({
  id, user_id: OWNER, source: 'ct_registry', external_id: id, name: `Empresa ${id}`, email: `${id.toLowerCase()}@gmail.com`, city: 'Hartford', zip: '06103',
  sector: 'limpieza', priority: 'A', status: 'new', registered_at: '2026-09-14', latino_signal: true, latino_strong: false, minority_owned: false,
  link_token: `token-${id}`, ...o,
});

const api = (path, { method = 'GET', body } = {}) => fetch(`${base}/api/leads${path}`, {
  method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ status: r.status, body: await r.json() }));

before(async () => {
  db = createMemoryDb();
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/leads', createLeadsRouter({ db, ownerId: OWNER, verifyOptions, fetchImpl }));
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });
beforeEach(() => {
  clearDomainCache();
  registryCalls = [];
  db.tables.new_business_leads = [];
  db.tables.email_suppressions = [];
  db.tables.lead_ingest_runs = [];
  for (const k of ['OUTREACH_DRY_RUN', 'INSTANTLY_API_KEY', 'INSTANTLY_CAMPAIGN_ID', 'CAMPAIGN_PUBLIC_URL', 'CALENDAR_URL']) delete process.env[k];
});

// ─── sin propietario configurado ─────────────────────────────────────────────
test('sin NEW_LEADS_OWNER_USER_ID cualquier ruta responde 503 con instrucciones', async () => {
  const app = express();
  app.use('/api/leads', createLeadsRouter({ db, ownerId: '' }));
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/leads/stats`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /NEW_LEADS_OWNER_USER_ID/);
  } finally { s.closeAllConnections?.(); s.close(); }
});

// ─── stats y listado ─────────────────────────────────────────────────────────
test('stats: cuenta por estado solo los leads del propietario, última ingesta y estado de Instantly', async () => {
  db.tables.new_business_leads = [lead('A'), lead('B'), lead('C', { status: 'engaged' }), lead('X', { user_id: OTHER })];
  db.tables.lead_ingest_runs = [
    { user_id: OWNER, ran_at: '2026-09-27T10:00:00.000Z', newest_registration: '2026-09-26', fetched: 10, inserted: 3, ok: true },
    { user_id: OWNER, ran_at: '2026-09-28T10:00:00.000Z', newest_registration: '2026-09-27', fetched: 12, inserted: 5, ok: true },
  ];
  const r = await api('/stats');
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 3);
  assert.deepEqual(r.body.byStatus, { new: 2, engaged: 1 });
  assert.equal(r.body.lastRun.inserted, 5);
  assert.deepEqual(r.body.instantly, { ready: false, dryRun: false });
  process.env.OUTREACH_DRY_RUN = 'true';
  assert.equal((await api('/stats')).body.instantly.dryRun, true);
});

test('listado: solo del propietario, más recientes primero, con filtros combinables y búsqueda', async () => {
  db.tables.new_business_leads = [
    lead('A', { registered_at: '2026-09-10' }),
    lead('B', { registered_at: '2026-09-12', sector: 'auto', priority: 'B', status: 'queued', name: 'Taller Ramos', city: 'New Britain' }),
    lead('C', { registered_at: '2026-09-11', status: 'engaged', source: 'csv_import' }),
    lead('X', { user_id: OTHER }),
  ];
  const ids = (r) => r.body.leads.map(l => l.id);
  assert.deepEqual(ids(await api('/')), ['B', 'C', 'A']);
  assert.deepEqual(ids(await api('/?status=queued,engaged')), ['B', 'C']);
  assert.deepEqual(ids(await api('/?sector=auto')), ['B']);
  assert.deepEqual(ids(await api('/?priority=A&source=csv_import')), ['C']);
  assert.deepEqual(ids(await api('/?q=ramos')), ['B']);
  assert.deepEqual(ids(await api('/?q=new%20britain')), ['B']);
  assert.deepEqual(ids(await api('/?q=c@gmail')), ['C']);
  const page = await api('/?limit=1&offset=1');
  assert.equal(page.body.total, 3);
  assert.deepEqual(ids(page), ['C']);
});

test('listado: no expone el token del enlace ni el id de Instantly', async () => {
  db.tables.new_business_leads = [lead('A', { instantly_lead_id: 'inst-1' })];
  const [l] = (await api('/')).body.leads;
  assert.equal(l.link_token, undefined);
  assert.equal(l.instantly_lead_id, undefined);
  assert.equal(l.user_id, undefined);
});

// ─── estados manuales ────────────────────────────────────────────────────────
test('PATCH: cambia a replied/called/won/lost; rechaza otros estados y leads ajenos', async () => {
  db.tables.new_business_leads = [lead('A', { status: 'engaged' }), lead('X', { user_id: OTHER })];
  assert.equal((await api('/A', { method: 'PATCH', body: { status: 'called' } })).status, 200);
  assert.equal(db.rows('new_business_leads').find(l => l.id === 'A').status, 'called');
  for (const status of ['won', 'lost', 'replied']) assert.equal((await api('/A', { method: 'PATCH', body: { status } })).status, 200);
  for (const status of ['queued', 'unsubscribed', 'new', '', undefined]) {
    const r = await api('/A', { method: 'PATCH', body: { status } });
    assert.equal(r.status, 400, String(status));
  }
  assert.equal((await api('/X', { method: 'PATCH', body: { status: 'won' } })).status, 404);
  assert.equal(db.rows('new_business_leads').find(l => l.id === 'X').status, 'new');
  assert.equal((await api('/no-existe', { method: 'PATCH', body: { status: 'won' } })).status, 404);
});

// ─── ingesta de Connecticut ──────────────────────────────────────────────────
test('ingesta CT en vista previa: cuenta y no escribe; sin listas de emails en la respuesta', async () => {
  const r = await api('/ingest/ct', { method: 'POST', body: { days: 30, dryRun: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.equal(r.body.fetched, 2);
  assert.equal(r.body.summary.total, 2);
  assert.equal(r.body.inserted, 0);
  assert.equal(r.body.leads, undefined);
  assert.equal(r.body.invalid, undefined);
  assert.equal(r.body.invalidEmailCount, 0);
  assert.equal(db.rows('new_business_leads').length, 0);
  assert.equal(db.rows('lead_ingest_runs').length, 0);
});

test('ingesta CT real: guarda con source ct_registry, registra la ejecución y no duplica al repetir', async () => {
  const first = await api('/ingest/ct', { method: 'POST', body: { days: 30 } });
  assert.equal(first.body.inserted, 2);
  const rows = db.rows('new_business_leads');
  assert.ok(rows.every(l => l.user_id === OWNER && l.source === 'ct_registry' && l.status === 'new'));
  assert.equal(db.rows('lead_ingest_runs').length, 1);
  const again = await api('/ingest/ct', { method: 'POST', body: { days: 30 } });
  assert.equal(again.body.inserted, 0);
  assert.equal(again.body.skipped.existing, 2);
  assert.equal(db.rows('new_business_leads').length, 2);
});

test('ingesta CT: valida days y usa la ventana pedida', async () => {
  for (const days of [0, -1, 3651, 1.5, '7']) assert.equal((await api('/ingest/ct', { method: 'POST', body: { days } })).status, 400, String(days));
  assert.equal(registryCalls.length, 0);
  await api('/ingest/ct', { method: 'POST', body: { days: 7, dryRun: true } });
  assert.ok(registryCalls.length > 0);
});

// ─── CSV ─────────────────────────────────────────────────────────────────────
const CSV = 'empresa,email,ciudad,sector\nPanadería Luna,luna@gmail.com,HARTFORD,otro\nTaller Ramos,ramos@gmail.com,New Britain,auto\n';

test('CSV vista previa: cabeceras, muestra y mapeo sugerido', async () => {
  const r = await api('/import/csv/preview', { method: 'POST', body: { csv: CSV } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.headers, ['empresa', 'email', 'ciudad', 'sector']);
  assert.equal(r.body.totalRows, 2);
  assert.equal(r.body.suggestedMapping.city, 'ciudad');
  assert.equal(r.body.suggestedMapping.zip, null);
});

test('CSV vista previa: archivo vacío → 400 legible', async () => {
  const r = await api('/import/csv/preview', { method: 'POST', body: { csv: '' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /vacío/);
  assert.equal((await api('/import/csv/preview', { method: 'POST', body: {} })).status, 400);
});

test('CSV importación: dryRun no escribe; real guarda con source csv_import', async () => {
  const mapping = { name: 'empresa', email: 'email', city: 'ciudad', sector: 'sector' };
  const dry = await api('/import/csv', { method: 'POST', body: { csv: CSV, mapping, dryRun: true } });
  assert.equal(dry.body.valid, 2);
  assert.equal(db.rows('new_business_leads').length, 0);
  const real = await api('/import/csv', { method: 'POST', body: { csv: CSV, mapping } });
  assert.equal(real.body.inserted, 2);
  assert.deepEqual(db.rows('new_business_leads').map(l => [l.source, l.city]).sort(), [['csv_import', 'Hartford'], ['csv_import', 'New Britain']]);
});

test('CSV importación: errores del archivo o del mapeo → 400 con el motivo', async () => {
  const noEmail = await api('/import/csv', { method: 'POST', body: { csv: CSV, mapping: { name: 'empresa' } } });
  assert.equal(noEmail.status, 400);
  assert.match(noEmail.body.error, /Email/);
  const ghost = await api('/import/csv', { method: 'POST', body: { csv: CSV, mapping: { name: 'empresa', email: 'inexistente' } } });
  assert.equal(ghost.status, 400);
  assert.match(ghost.body.error, /inexistente/);
  assert.equal((await api('/import/csv', { method: 'POST', body: { mapping: { name: 'a', email: 'b' } } })).status, 400);
  assert.equal(db.rows('new_business_leads').length, 0);
});

test('CSV importación: un fallo de la base de datos es un 500 con pista sobre el SQL', async () => {
  db.failNext('new_business_leads', 'select', 'relation "new_business_leads" does not exist');
  const r = await api('/import/csv', { method: 'POST', body: { csv: CSV, mapping: { name: 'empresa', email: 'email' } } });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /schema-new-business-leads\.sql/);
});

// ─── envío a Instantly ───────────────────────────────────────────────────────
test('push sin configuración de Instantly → 400 con las variables que faltan', async () => {
  db.tables.new_business_leads = [lead('A')];
  const r = await api('/push', { method: 'POST', body: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /INSTANTLY_API_KEY/);
  assert.equal(db.rows('new_business_leads')[0].status, 'new');
});

test('push en modo prueba (OUTREACH_DRY_RUN): cuenta lo que enviaría y no cambia nada', async () => {
  process.env.OUTREACH_DRY_RUN = 'true';
  db.tables.new_business_leads = [lead('A'), lead('B'), lead('C', { status: 'invalid_email' })];
  const r = await api('/push', { method: 'POST', body: { limit: 10 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { dryRun: true, pushed: 2, rejected: 0 });
  assert.deepEqual(db.rows('new_business_leads').map(l => l.status), ['new', 'new', 'invalid_email']);
});

test('email-template: asunto, cuerpo y variables del texto único', async () => {
  const r = await api('/email-template');
  assert.equal(r.status, 200);
  assert.match(r.body.subject, /Enhorabuena por \{\{empresa\}\}/);
  assert.match(r.body.body, /\{\{calendario\}\}/);
  assert.ok(r.body.variables.includes('empresa'));
});
