// API del pipeline "LLCs nuevas" del dashboard: contadores, listado con filtros, estados manuales, ingesta CT, CSV y envío a Instantly.
import { test, before, after, beforeEach, mock } from 'node:test';
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
let instantlyHandler = async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) });   // overridden per test
const fetchImpl = async (url, opts) => {
  if (new URL(url).host === 'api.instantly.ai') return instantlyHandler(url, opts);
  registryCalls.push(String(url));
  const offset = Number(new URL(url).searchParams.get('$offset') || 0);
  const rows = offset === 0 ? [registryRow(1), registryRow(2)] : [];
  return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
};

let db, server, base, onReply;
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
  onReply = mock.fn(async () => {});
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/leads', createLeadsRouter({ db, ownerId: OWNER, verifyOptions, fetchImpl, onReply: (...a) => onReply(...a) }));
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });
beforeEach(() => {
  clearDomainCache();
  registryCalls = [];
  instantlyHandler = async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) });
  onReply.mock.resetCalls();
  db.tables.new_business_leads = [];
  db.tables.email_suppressions = [];
  db.tables.lead_ingest_runs = [];
  for (const k of ['OUTREACH_DRY_RUN', 'INSTANTLY_API_KEY', 'INSTANTLY_CAMPAIGN_ID', 'CAMPAIGN_PUBLIC_URL']) delete process.env[k];
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

test('listado de "Pidió llamada": las más recientes primero y con el teléfono', async () => {
  db.tables.new_business_leads = [
    lead('A', { status: 'requested', phone: '+18605550100', contact_name: 'Ana', preferred_time: 'Lo antes posible', requested_at: '2026-09-29T10:00:00.000Z', registered_at: '2026-09-20' }),
    lead('B', { status: 'requested', phone: '+12035550111', preferred_time: 'Mañana por la tarde', requested_at: '2026-09-29T12:00:00.000Z', registered_at: '2026-09-10' }),
    lead('C', { status: 'emailed', registered_at: '2026-09-25' }),
  ];
  const asked = await api('/?status=requested');
  assert.deepEqual(asked.body.leads.map(l => [l.id, l.phone, l.preferred_time]), [['B', '+12035550111', 'Mañana por la tarde'], ['A', '+18605550100', 'Lo antes posible']]);
  assert.equal(asked.body.leads[1].contact_name, 'Ana');
  assert.deepEqual((await api('/')).body.leads.map(l => l.id), ['C', 'A', 'B']);      // sin filtro: por fecha de registro
});

test('listado: no expone el consentimiento (IP y texto) ni el token del enlace', async () => {
  db.tables.new_business_leads = [lead('A', { status: 'requested', phone: '+18605550100', consent_ip: '1.2.3.4', consent_text: 'x', consent_at: '2026-09-29T10:00:00.000Z' })];
  const [l] = (await api('/')).body.leads;
  assert.equal(l.consent_ip, undefined);
  assert.equal(l.consent_text, undefined);
  assert.equal(l.link_token, undefined);
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

// ─── comprobar Instantly (reemplaza al webhook) ──────────────────────────────
test('poll-instantly sin configuración de Instantly → 400 con las variables que faltan', async () => {
  db.tables.new_business_leads = [lead('A', { status: 'queued', instantly_lead_id: 'inst-a' })];
  const r = await api('/poll-instantly', { method: 'POST' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /INSTANTLY_API_KEY/);
});

test('poll-instantly: marca enviado, rebotado o de baja según lo que diga Instantly', async () => {
  process.env.INSTANTLY_API_KEY = 'k';
  process.env.INSTANTLY_CAMPAIGN_ID = '5a1d6d4e-8a0b-4e9c-9a53-2f4c8e7f1b10';
  process.env.CAMPAIGN_PUBLIC_URL = 'https://campana.example.com';
  db.tables.new_business_leads = [
    lead('A', { status: 'queued', instantly_lead_id: 'inst-a' }),
    lead('B', { status: 'queued', instantly_lead_id: 'inst-b' }),
    lead('C', { status: 'emailed', instantly_lead_id: 'inst-c' }),
    lead('D', { status: 'new' }),                          // sin instantly_lead_id: no se pregunta por él
  ];
  instantlyHandler = async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.ids.sort(), ['inst-a', 'inst-b', 'inst-c']);
    const items = [
      { id: 'inst-a', status: 1, email_reply_count: 0, timestamp_last_contact: '2026-09-29T10:00:00.000Z' },
      { id: 'inst-b', status: -1, email_reply_count: 0 },
      { id: 'inst-c', status: -2, email_reply_count: 0 },
    ];
    return { ok: true, status: 200, json: async () => ({ items }) };
  };
  const r = await api('/poll-instantly', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { checked: 3, updated: 3, suppressed: 2, replied: 0 });
  const byId = Object.fromEntries(db.rows('new_business_leads').map(l => [l.id, l]));
  assert.deepEqual([byId.A.status, byId.A.emailed_at], ['emailed', '2026-09-29T10:00:00.000Z']);
  assert.equal(byId.B.status, 'bounced');
  assert.equal(byId.C.status, 'unsubscribed');              // "emailed" es previo a interactuar: la baja sí lo mueve
  assert.deepEqual(db.rows('email_suppressions').map(s => [s.email, s.reason]).sort(), [['b@gmail.com', 'bounced'], ['c@gmail.com', 'unsubscribed']]);
});

test('poll-instantly: la primera respuesta avisa por Telegram y guarda el consentimiento del funnel; la segunda no vuelve a avisar', async () => {
  process.env.INSTANTLY_API_KEY = 'k';
  process.env.INSTANTLY_CAMPAIGN_ID = '5a1d6d4e-8a0b-4e9c-9a53-2f4c8e7f1b10';
  process.env.CAMPAIGN_PUBLIC_URL = 'https://campana.example.com';
  db.tables.new_business_leads = [lead('A', { status: 'emailed', instantly_lead_id: 'inst-a', name: 'Taller Ramos LLC' })];
  instantlyHandler = async () => ({ ok: true, status: 200, json: async () => ({ items: [{ id: 'inst-a', status: 1, email_reply_count: 1, timestamp_last_reply: '2026-09-29T11:00:00.000Z' }] }) });

  const r = await api('/poll-instantly', { method: 'POST' });
  assert.deepEqual(r.body, { checked: 1, updated: 1, suppressed: 0, replied: 1 });
  const lead1 = db.rows('new_business_leads')[0];
  assert.deepEqual([lead1.status, lead1.replied_at], ['replied', '2026-09-29T11:00:00.000Z']);
  await new Promise(r2 => setTimeout(r2, 25));
  assert.equal(onReply.mock.callCount(), 1);
  assert.equal(onReply.mock.calls[0].arguments[0].name, 'Taller Ramos LLC');

  const again = await api('/poll-instantly', { method: 'POST' });
  assert.deepEqual(again.body, { checked: 0, updated: 0, suppressed: 0, replied: 0 });   // "replied" ya no se vuelve a preguntar
  await new Promise(r2 => setTimeout(r2, 25));
  assert.equal(onReply.mock.callCount(), 1);
});

test('poll-instantly: un lead que ya interactuó (engaged/requested) conserva su estado al recibir una respuesta', async () => {
  process.env.INSTANTLY_API_KEY = 'k';
  process.env.INSTANTLY_CAMPAIGN_ID = '5a1d6d4e-8a0b-4e9c-9a53-2f4c8e7f1b10';
  process.env.CAMPAIGN_PUBLIC_URL = 'https://campana.example.com';
  db.tables.new_business_leads = [lead('A', { status: 'requested', instantly_lead_id: 'inst-a', phone: '+18605550100' })];
  instantlyHandler = async () => ({ ok: true, status: 200, json: async () => ({ items: [{ id: 'inst-a', status: 1, email_reply_count: 1, timestamp_last_reply: '2026-09-29T11:00:00.000Z' }] }) });
  const r = await api('/poll-instantly', { method: 'POST' });
  assert.deepEqual(r.body, { checked: 1, updated: 1, suppressed: 0, replied: 1 });
  const l = db.rows('new_business_leads')[0];
  assert.deepEqual([l.status, l.phone, !!l.replied_at], ['requested', '+18605550100', true]);
});

test('poll-instantly: quien ya está fuera (baja, rebote, llamado, ganado…) no se vuelve a preguntar', async () => {
  process.env.INSTANTLY_API_KEY = 'k';
  process.env.INSTANTLY_CAMPAIGN_ID = '5a1d6d4e-8a0b-4e9c-9a53-2f4c8e7f1b10';
  process.env.CAMPAIGN_PUBLIC_URL = 'https://campana.example.com';
  db.tables.new_business_leads = ['unsubscribed', 'bounced', 'invalid_email', 'rejected', 'called', 'won', 'lost'].map((s, i) => lead(`L${i}`, { status: s, instantly_lead_id: `inst-${i}` }));
  let called = false;
  instantlyHandler = async () => { called = true; return { ok: true, status: 200, json: async () => ({ items: [] }) }; };
  const r = await api('/poll-instantly', { method: 'POST' });
  assert.deepEqual(r.body, { checked: 0, updated: 0, suppressed: 0, replied: 0 });
  assert.equal(called, false);
});

test('email-template: asunto, cuerpo y variables del texto único', async () => {
  const r = await api('/email-template');
  assert.equal(r.status, 200);
  assert.match(r.body.subject, /Enhorabuena por \{\{empresa\}\}/);
  assert.match(r.body.body, /\{\{calendario\}\}/);
  assert.ok(r.body.variables.includes('empresa'));
});
