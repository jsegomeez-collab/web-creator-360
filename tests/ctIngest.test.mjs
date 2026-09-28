// Una ingesta completa: ventana de fechas, filtros, deduplicado, verificación de emails, guardado y modo dry-run.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './helpers/fakeSupabase.mjs';
import { runCtIngest, daysAgo, shiftDate, FIRST_RUN_DAYS } from '../src/services/ctIngest.js';
import { clearDomainCache } from '../src/services/emailVerify.js';

const db = createFakeDb();
beforeEach(() => { db.reset(); clearDomainCache(); });

const OWNER = '11111111-1111-4111-8111-111111111111';
const TODAY = new Date('2026-09-28T15:00:00Z');

const row = (n, o = {}) => ({
  name: `Limpieza ${n} LLC`, accountnumber: String(n), status: 'Active', date_registration: '2026-09-14T00:00:00.000',
  business_email_address: `dueno${n}@gmail.com`, category_survey_email_address: '', naics_code: 'Janitorial Services (561720)',
  minority_owned_organization: false, billingstreet: '1 Main St', billingcity: 'HARTFORD', billingpostalcode: '06103', ...o,
});

// Resolver falso: gmail.com tiene MX; cualquier otro dominio no existe
const mx = [{ exchange: 'mx.google.com', priority: 10 }];
const resolver = {
  resolveMx: async (d) => { if (d === 'gmail.com') return mx; throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); },
  resolve4: async () => { throw Object.assign(new Error('x'), { code: 'ENODATA' }); },
  resolve6: async () => { throw Object.assign(new Error('x'), { code: 'ENODATA' }); },
};
const verifyOptions = { resolver, provider: async () => null };
const base = { today: TODAY, verifyOptions, fetchOptions: { sleep: async () => {} } };   // sin esperas reales en los reintentos

// BD "vacía" por defecto: sin ingestas previas, sin leads ni supresiones
function seedEmptyDb() {
  db.handlers.lead_ingest_runs = () => [];
  db.handlers.email_suppressions = () => [];
  db.handlers.new_business_leads = () => [];
}

test('fechas: daysAgo y shiftDate', () => {
  assert.equal(daysAgo(90, TODAY), '2026-06-30');
  assert.equal(daysAgo(0, TODAY), '2026-09-28');
  assert.equal(shiftDate('2026-09-27', -2), '2026-09-25');
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
});

// ─── dry-run ─────────────────────────────────────────────────────────────────
test('dry-run sin base de datos: cuenta leads por sector y prioridad y NO escribe nada', async () => {
  const rows = [row(1), row(2, { name: 'Acme LLC', business_email_address: 'jose.garcia@gmail.com', naics_code: 'Foo (999999)' }), row(3, { business_email_address: '' })];
  const r = await runCtIngest({ ...base, dryRun: true, rows });
  assert.equal(r.dryRun, true);
  assert.equal(r.fetched, 3);
  assert.equal(r.summary.total, 2);
  assert.deepEqual(r.summary.byPriority, { A: 1, B: 1 });
  assert.deepEqual(r.summary.bySector, { limpieza: 1, otro: 1 });
  assert.equal(r.inserted, 0);
  assert.ok(r.notes.some(n => /Sin base de datos/.test(n)));
  assert.equal(db.calls.length, 0);
});

test('dry-run con base de datos: lee (deduplica) pero jamás escribe', async () => {
  seedEmptyDb();
  db.handlers.new_business_leads = ctx => (ctx.filters.external_id__in ? [{ external_id: '1', email: 'x@x.com' }] : []);
  const r = await runCtIngest({ ...base, db, ownerId: OWNER, dryRun: true, rows: [row(1), row(2)] });
  assert.equal(r.summary.total, 1);                     // el 1 ya existía
  assert.equal(r.skipped.existing, 1);
  assert.ok(db.calls.length > 0);
  assert.ok(db.calls.every(c => c.op === 'select'), 'en dry-run solo se permiten lecturas');
});

test('dry-run: si la base de datos falla (SQL sin ejecutar) avisa y sigue en vez de romper', async () => {
  db.handlers.lead_ingest_runs = () => ({ __error: 'relation "lead_ingest_runs" does not exist' });
  db.handlers.email_suppressions = () => ({ __error: 'relation "email_suppressions" does not exist' });
  const r = await runCtIngest({ ...base, db, ownerId: OWNER, dryRun: true, rows: [row(1)] });
  assert.equal(r.summary.total, 1);
  assert.ok(r.notes.length >= 2 && r.notes.some(n => /última ingesta/.test(n)) && r.notes.some(n => /base de datos/.test(n)));
  assert.ok(db.calls.every(c => c.op === 'select'));
});

// ─── ventana ─────────────────────────────────────────────────────────────────
test('ventana: primera ejecución = últimos 90 días; --days manda; incremental = última fecha − 2 días', async () => {
  seedEmptyDb();
  assert.equal(FIRST_RUN_DAYS, 90);
  assert.equal((await runCtIngest({ ...base, db, ownerId: OWNER, dryRun: true, rows: [] })).since, '2026-06-30');
  assert.equal((await runCtIngest({ ...base, db, ownerId: OWNER, dryRun: true, days: 14, rows: [] })).since, '2026-09-14');
  db.handlers.lead_ingest_runs = () => [{ newest_registration: '2026-09-25' }];
  const inc = await runCtIngest({ ...base, db, ownerId: OWNER, dryRun: true, rows: [] });
  assert.equal(inc.since, '2026-09-23');
  assert.equal(inc.watermark, '2026-09-25');
  // --days ignora la marca de agua
  assert.equal((await runCtIngest({ ...base, db, ownerId: OWNER, dryRun: true, days: 5, rows: [] })).since, '2026-09-23');
});

test('descarga con fetch simulado: usa "since" en la consulta', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => [] }; };
  await runCtIngest({ ...base, dryRun: true, days: 30, fetchImpl });
  assert.equal(urls.length, 1);
  assert.ok(new URL(urls[0]).searchParams.get('$where').includes("date_registration >= '2026-08-29T00:00:00'"));
});

// ─── ejecución real ──────────────────────────────────────────────────────────
test('ejecución real: exige base de datos y NEW_LEADS_OWNER_USER_ID', async () => {
  await assert.rejects(() => runCtIngest({ ...base, rows: [row(1)] }), /NEW_LEADS_OWNER_USER_ID/);
  await assert.rejects(() => runCtIngest({ ...base, db, rows: [row(1)] }), /NEW_LEADS_OWNER_USER_ID/);
  await assert.rejects(() => runCtIngest({ ...base, ownerId: OWNER, rows: [row(1)] }), /NEW_LEADS_OWNER_USER_ID/);
});

test('ejecución real: inserta leads "new" con user_id y guarda la ingesta con la fecha más reciente de TODAS las filas', async () => {
  seedEmptyDb();
  const rows = [
    row(1, { date_registration: '2026-09-20T00:00:00.000' }),
    row(2, { date_registration: '2026-09-27T00:00:00.000', business_email_address: '' }),   // descartada, pero avanza la marca
  ];
  const r = await runCtIngest({ ...base, db, ownerId: OWNER, rows });
  assert.equal(r.inserted, 1);
  const up = db.writes('new_business_leads', 'upsert')[0].payload;
  assert.equal(up.length, 1);
  assert.deepEqual([up[0].user_id, up[0].status, up[0].external_id, up[0].sector], [OWNER, 'new', '1', 'limpieza']);
  const run = db.writes('lead_ingest_runs', 'insert')[0].payload;
  assert.equal(run.user_id, OWNER);
  assert.equal(run.newest_registration, '2026-09-27');
  assert.equal(run.fetched, 2);
  assert.equal(run.inserted, 1);
  assert.equal(run.ok, true);
  assert.equal(run.stats.noEmail, 1);
});

test('emails de dominios que no reciben correo → se guardan como "invalid_email" y no entran en la cola', async () => {
  seedEmptyDb();
  const rows = [row(1), row(2, { business_email_address: 'dueno2@dominio-inventado-xyz.com' })];
  const r = await runCtIngest({ ...base, db, ownerId: OWNER, rows });
  assert.equal(r.summary.total, 1);
  assert.equal(r.invalid.length, 1);
  assert.deepEqual(r.invalidReasons, { no_mx: 1 });
  assert.equal(r.stats.invalidEmail, 1);
  const up = db.writes('new_business_leads', 'upsert')[0].payload;
  assert.deepEqual(up.map(u => [u.external_id, u.status]), [['1', 'new'], ['2', 'invalid_email']]);
});

test('--no-mx (verify:false) no consulta DNS', async () => {
  seedEmptyDb();
  let dnsCalls = 0;
  const spy = { ...resolver, resolveMx: async (d) => { dnsCalls++; return resolver.resolveMx(d); } };
  const r = await runCtIngest({ ...base, verifyOptions: { resolver: spy }, verify: false, db, ownerId: OWNER, rows: [row(1, { business_email_address: 'x@dominio-inventado-xyz.com' })] });
  assert.equal(dnsCalls, 0);
  assert.equal(r.invalid.length, 0);
});

test('deduplicado: leads ya guardados y emails en supresiones no se vuelven a insertar', async () => {
  seedEmptyDb();
  db.handlers.email_suppressions = ctx => (ctx.filters.email__in || []).filter(e => e === 'dueno2@gmail.com').map(email => ({ email }));
  db.handlers.new_business_leads = ctx => (ctx.filters.external_id__in ? [{ external_id: '1', email: 'dueno1@gmail.com' }] : (ctx.filters.email__in ? [{ email: 'dueno1@gmail.com' }] : []));
  const r = await runCtIngest({ ...base, db, ownerId: OWNER, rows: [row(1), row(2), row(3)] });
  assert.equal(r.inserted, 1);
  assert.deepEqual(db.writes('new_business_leads', 'upsert')[0].payload.map(u => u.external_id), ['3']);
  assert.equal(r.skipped.existing, 1);
  assert.equal(r.skipped.suppressed, 1);
});

test('ejecución real: si la descarga falla deja constancia (ok:false, sin mover la marca) y relanza el error', async () => {
  seedEmptyDb();
  const fetchImpl = async () => { throw new Error('sin red'); };
  await assert.rejects(() => runCtIngest({ ...base, db, ownerId: OWNER, days: 7, fetchImpl }), /sin red/);
  const run = db.writes('lead_ingest_runs', 'insert')[0].payload;
  assert.equal(run.ok, false);
  assert.match(run.error, /sin red/);
  assert.equal(db.writes('new_business_leads', 'upsert').length, 0);
  assert.equal('newest_registration' in run, false);
});

test('en dry-run un fallo NO deja rastro en la base de datos', async () => {
  seedEmptyDb();
  const fetchImpl = async () => { throw new Error('sin red'); };
  await assert.rejects(() => runCtIngest({ ...base, db, ownerId: OWNER, dryRun: true, days: 7, fetchImpl }), /sin red/);
  assert.equal(db.writes('lead_ingest_runs', 'insert').length, 0);
});

test('ejecución real: si la BD falla al deduplicar se aborta (no se inserta a ciegas)', async () => {
  seedEmptyDb();
  db.handlers.email_suppressions = () => ({ __error: 'relation "email_suppressions" does not exist' });
  await assert.rejects(() => runCtIngest({ ...base, db, ownerId: OWNER, rows: [row(1)] }), /consultar supresiones/);
  assert.equal(db.writes('new_business_leads', 'upsert').length, 0);
});

test('summary: rango de fechas, señal fuerte y minoría', async () => {
  const rows = [
    row(1, { date_registration: '2026-09-10T00:00:00.000', minority_owned_organization: true }),
    row(2, { date_registration: '2026-09-25T00:00:00.000', name: 'Acme LLC', business_email_address: 'a.ramos@gmail.com' }),
  ];
  const { summary } = await runCtIngest({ ...base, dryRun: true, rows });
  assert.equal(summary.oldest, '2026-09-10');
  assert.equal(summary.newest, '2026-09-25');
  assert.equal(summary.latinoStrong, 1);
  assert.equal(summary.minorityOwned, 1);
});
