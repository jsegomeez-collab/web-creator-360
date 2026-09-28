// Instantly: configuración, subida de leads a la campaña (dry-run y real), reintentos y creación del webhook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { loadInstantlyConfig, buildInstantlyLead, leadLinkUrl, pushLeads, API } from '../src/services/instantly.js';

const OWNER = 'owner-1';
const CAMPAIGN = '5a1d6d4e-8a0b-4e9c-9a53-2f4c8e7f1b10';
const goodEnv = { INSTANTLY_API_KEY: 'key-123', INSTANTLY_CAMPAIGN_ID: CAMPAIGN, CAMPAIGN_PUBLIC_URL: 'https://campana.example.com/' };
const config = () => loadInstantlyConfig(goodEnv, { dryRun: false });
const noSleep = async () => {};

const mkLead = (i, over = {}) => ({
  id: `L${i}`, user_id: OWNER, source: 'ct_registry', external_id: `E${i}`, name: `Negocio ${i} LLC`, email: `l${i}@gmail.com`,
  city: 'Hartford', sector: 'limpieza', latino_strong: i % 2 === 1, registered_at: `2026-09-${String(28 - i).padStart(2, '0')}`,   // L1 = el más reciente
  status: 'new', notes: `señal latina ${i}`, link_token: `TOKEN${String(i).padStart(19, '0')}`, ...over,
});
const dbWith = (leads) => createMemoryDb({ new_business_leads: leads });
const lead = (db, id) => db.rows('new_business_leads').find(l => l.id === id);

// fetch simulado de Instantly: `respond(body, n)` decide la respuesta de cada petición
function fakeInstantly(respond) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method, headers: opts.headers, body });
    const r = await respond(body, calls.length);
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, statusText: 'x', json: async () => r.json ?? {} };
  };
  return { fetchImpl, calls };
}
const acceptAll = (body) => ({ json: { status: 'success', created_leads: body.leads.map((l, index) => ({ id: `inst-${l.email}`, index, email: l.email })) } });

// ─── configuración ───────────────────────────────────────────────────────────
test('config real completa: URL sin barra final', () => {
  const c = config();
  assert.deepEqual([c.apiKey, c.campaignId, c.publicUrl, c.warnings], ['key-123', CAMPAIGN, 'https://campana.example.com', []]);
  assert.equal(leadLinkUrl(c, 'TOK'), 'https://campana.example.com/c/TOK');
});

test('config real: se niega si falta la clave, la campaña, o la URL pública https', () => {
  const bad = (over, re) => assert.throws(() => loadInstantlyConfig({ ...goodEnv, ...over }, { dryRun: false }), re);
  bad({ INSTANTLY_API_KEY: '' }, /INSTANTLY_API_KEY/);
  bad({ INSTANTLY_CAMPAIGN_ID: 'no-es-uuid' }, /INSTANTLY_CAMPAIGN_ID/);
  for (const url of ['', 'http://campana.example.com', 'https://localhost:3002', 'http://127.0.0.1:3002']) bad({ CAMPAIGN_PUBLIC_URL: url }, /CAMPAIGN_PUBLIC_URL/);
});

test('config en dry-run: usa marcadores y lista lo que faltaría', () => {
  const c = loadInstantlyConfig({}, { dryRun: true });
  assert.equal(c.warnings.length, 3);
  assert.equal(c.publicUrl, 'http://localhost:3002');
});

test('buildInstantlyLead: email, empresa y variables con el enlace propio del lead', () => {
  const l = buildInstantlyLead(mkLead(1), config());
  assert.equal(l.email, 'l1@gmail.com');
  assert.equal(l.company_name, 'Negocio 1 LLC');
  assert.deepEqual(l.custom_variables, {
    empresa: 'Negocio 1 LLC', ciudad: 'Hartford', latina: ' y por aportar a nuestra comunidad latina', sector_de: ' de limpieza',
    calendario: 'https://campana.example.com/c/TOKEN0000000000000000001',
  });
});

// ─── pushLeads: dry-run ──────────────────────────────────────────────────────
test('dry-run: no llama a Instantly ni cambia nada, solo lo escribe en el log', async () => {
  const db = dbWith([mkLead(1), mkLead(2)]);
  const before = JSON.stringify(db.rows('new_business_leads'));
  const { fetchImpl, calls } = fakeInstantly(acceptAll);
  const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  let r;
  try { r = await pushLeads({ db, ownerId: OWNER, config: loadInstantlyConfig({}, { dryRun: true }), dryRun: true, fetchImpl }); } finally { console.log = orig; }
  assert.deepEqual(r, { dryRun: true, pushed: 2, rejected: 0 });
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(db.rows('new_business_leads')), before);
  assert.ok(lines[0].startsWith('[dry-run] instantly.push {') && lines[0].includes('"leads":2'));
});

// ─── pushLeads: real ─────────────────────────────────────────────────────────
test('real: sube los leads "new" más recientes primero, con la clave, la campaña y las variables', async () => {
  const db = dbWith([mkLead(3), mkLead(1), mkLead(2), mkLead(9, { status: 'emailed' }), mkLead(8, { user_id: 'otro' })]);
  const { fetchImpl, calls } = fakeInstantly(acceptAll);
  const r = await pushLeads({ db, ownerId: OWNER, config: config(), limit: 2, dryRun: false, fetchImpl, sleep: noSleep });
  assert.deepEqual(r, { dryRun: false, pushed: 2, rejected: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API}/leads/add`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, 'Bearer key-123');
  assert.equal(calls[0].body.campaign_id, CAMPAIGN);
  assert.equal(calls[0].body.skip_if_in_workspace, true);
  assert.deepEqual(calls[0].body.leads.map(l => l.email), ['l1@gmail.com', 'l2@gmail.com']);      // los 2 más recientes (limit 2)
  assert.equal(calls[0].body.leads[0].custom_variables.calendario, 'https://campana.example.com/c/TOKEN0000000000000000001');
});

test('filtros: source, sector, priority y batch limitan qué "new" se envía', async () => {
  const seed = () => [
    mkLead(1, { source: 'csv_import', import_batch: 'a.csv · 2026-09-29 10:00' }),
    mkLead(2, { source: 'csv_import', import_batch: 'b.csv · 2026-09-29 11:00' }),
    mkLead(3, { source: 'ct_registry', sector: 'auto', priority: 'A' }),
    mkLead(4, { source: 'ct_registry', sector: 'limpieza', priority: 'B' }),
  ];
  // cada caso con su propia base de datos: un envío real cambia el estado, y no debe contaminar el siguiente caso
  const only = async (filters) => {
    const { fetchImpl, calls } = fakeInstantly(acceptAll);
    await pushLeads({ db: dbWith(seed()), ownerId: OWNER, config: config(), filters, dryRun: false, fetchImpl, sleep: noSleep });
    return (calls[0]?.body.leads ?? []).map(l => l.email).sort();
  };
  assert.deepEqual(await only({ source: 'csv_import' }), ['l1@gmail.com', 'l2@gmail.com']);
  assert.deepEqual(await only({ batch: 'b.csv · 2026-09-29 11:00' }), ['l2@gmail.com']);
  assert.deepEqual(await only({ source: 'ct_registry', sector: 'auto' }), ['l3@gmail.com']);
  assert.deepEqual(await only({ priority: 'B' }), ['l4@gmail.com']);
  assert.deepEqual(await only({ sector: 'no-existe' }), []);
  assert.deepEqual((await only({})).length, 4);                    // sin filtros: todos
});

test('los aceptados pasan a "queued" con su id de Instantly; solo cambian los enviados', async () => {
  const db = dbWith([mkLead(1), mkLead(2), mkLead(3, { status: 'emailed' })]);
  const { fetchImpl } = fakeInstantly(acceptAll);
  await pushLeads({ db, ownerId: OWNER, config: config(), dryRun: false, fetchImpl, sleep: noSleep, now: new Date('2026-09-28T15:00:00Z') });
  const l1 = lead(db, 'L1');
  assert.deepEqual([l1.status, l1.instantly_lead_id, l1.pushed_at], ['queued', 'inst-l1@gmail.com', '2026-09-28T15:00:00.000Z']);
  assert.equal(lead(db, 'L2').status, 'queued');
  assert.equal(lead(db, 'L3').status, 'emailed');                    // intacto
});

test('los que Instantly no crea (duplicados, bloqueados, inválidos) pasan a "rejected" con nota, y no se reenvían', async () => {
  const db = dbWith([mkLead(1), mkLead(2), mkLead(3)]);
  const { fetchImpl } = fakeInstantly((body) => ({ json: { created_leads: [{ id: 'inst-1', index: 0, email: 'l1@gmail.com' }, { id: 'inst-3', index: 2, email: 'l3@gmail.com' }] } }));
  const r = await pushLeads({ db, ownerId: OWNER, config: config(), dryRun: false, fetchImpl, sleep: noSleep });
  assert.deepEqual([r.pushed, r.rejected], [2, 1]);
  assert.equal(lead(db, 'L2').status, 'rejected');
  assert.ok(lead(db, 'L2').notes.startsWith('señal latina 2 · Instantly no lo aceptó'));
  assert.deepEqual([lead(db, 'L1').status, lead(db, 'L3').status], ['queued', 'queued']);
  // una segunda subida no vuelve a enviar a ninguno (ya no están en "new")
  const again = fakeInstantly(acceptAll);
  const r2 = await pushLeads({ db, ownerId: OWNER, config: config(), dryRun: false, fetchImpl: again.fetchImpl, sleep: noSleep });
  assert.equal(r2.pushed, 0);
  assert.equal(again.calls.length, 0);
});

test('si created_leads no trae "index", casa por email', async () => {
  const db = dbWith([mkLead(1), mkLead(2)]);
  const { fetchImpl } = fakeInstantly(() => ({ json: { created_leads: [{ id: 'inst-2', email: 'L2@gmail.com' }] } }));
  await pushLeads({ db, ownerId: OWNER, config: config(), dryRun: false, fetchImpl, sleep: noSleep });
  assert.deepEqual([lead(db, 'L1').status, lead(db, 'L2').status, lead(db, 'L2').instantly_lead_id], ['rejected', 'queued', 'inst-2']);
});

test('trocea en peticiones de máximo 1000 leads', async () => {
  const db = dbWith(Array.from({ length: 2500 }, (_, i) => mkLead(i + 1, { registered_at: '2026-09-01' })));
  const { fetchImpl, calls } = fakeInstantly(acceptAll);
  const r = await pushLeads({ db, ownerId: OWNER, config: config(), limit: 5000, dryRun: false, fetchImpl, sleep: noSleep });
  assert.equal(r.pushed, 2500);
  assert.deepEqual(calls.map(c => c.body.leads.length), [1000, 1000, 500]);
});

test('sin leads nuevos no llama a Instantly', async () => {
  const db = dbWith([mkLead(1, { status: 'emailed' })]);
  const { fetchImpl, calls } = fakeInstantly(acceptAll);
  assert.deepEqual(await pushLeads({ db, ownerId: OWNER, config: config(), dryRun: false, fetchImpl }), { dryRun: false, pushed: 0, rejected: 0 });
  assert.equal(calls.length, 0);
});

test('valida el límite', async () => {
  const db = dbWith([mkLead(1)]);
  for (const limit of [0, -1, 2.5, 5001, NaN]) await assert.rejects(() => pushLeads({ db, ownerId: OWNER, config: config(), limit, dryRun: false }), /limit/);
});

// ─── errores y reintentos ────────────────────────────────────────────────────
test('429 y 5xx se reintentan y luego funciona', async () => {
  const db = dbWith([mkLead(1)]);
  const { fetchImpl, calls } = fakeInstantly((body, n) => (n === 1 ? { status: 429 } : n === 2 ? { status: 503 } : acceptAll(body)));
  const r = await pushLeads({ db, ownerId: OWNER, config: config(), dryRun: false, fetchImpl, sleep: noSleep });
  assert.equal(r.pushed, 1);
  assert.equal(calls.length, 3);
});

test('401: error claro con la pista de la clave, y NINGÚN lead cambia de estado', async () => {
  const db = dbWith([mkLead(1), mkLead(2)]);
  const { fetchImpl, calls } = fakeInstantly(() => ({ status: 401, json: { message: 'Invalid API key' } }));
  await assert.rejects(() => pushLeads({ db, ownerId: OWNER, config: config(), dryRun: false, fetchImpl, sleep: noSleep }), /Instantly respondió 401: Invalid API key.*INSTANTLY_API_KEY/);
  assert.equal(calls.length, 1);                                      // un 401 no se reintenta
  assert.deepEqual(db.rows('new_business_leads').map(l => l.status), ['new', 'new']);
});

test('error persistente de Instantly o de red: se lanza y no se toca ningún estado', async () => {
  const db = dbWith([mkLead(1)]);
  const persistent = fakeInstantly(() => ({ status: 500, json: { error: 'boom' } }));
  await assert.rejects(() => pushLeads({ db, ownerId: OWNER, config: config(), dryRun: false, fetchImpl: persistent.fetchImpl, sleep: noSleep }), /respondió 500/);
  const down = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(() => pushLeads({ db, ownerId: OWNER, config: config(), dryRun: false, fetchImpl: down, sleep: noSleep }), /No se pudo conectar con Instantly: ECONNRESET/);
  assert.equal(lead(db, 'L1').status, 'new');
});

test('si Instantly acepta pero falla el guardado local, avisa claramente de no reenviar', async () => {
  const db = dbWith([mkLead(1)]);
  db.failNext('new_business_leads', 'update', 'timeout');
  const { fetchImpl } = fakeInstantly(acceptAll);
  await assert.rejects(() => pushLeads({ db, ownerId: OWNER, config: config(), dryRun: false, fetchImpl, sleep: noSleep }), /Instantly aceptó los leads pero no se pudo guardar.*No vuelvas a enviar/);
});
