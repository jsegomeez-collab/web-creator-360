// Guardado de leads: tokens, marca de agua de la ingesta, deduplicado (existentes, supresiones, emails repetidos) e inserción.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './helpers/fakeSupabase.mjs';
import { newFormToken, getWatermark, recordRun, filterNewLeads, insertLeads } from '../src/services/newLeads.js';

const db = createFakeDb();
beforeEach(() => db.reset());

const OWNER = '11111111-1111-4111-8111-111111111111';
const lead = (n, extra = {}) => ({
  external_id: String(n), name: `Negocio ${n} LLC`, email: `e${n}@gmail.com`, city: 'Hartford', zip: '06103', address: '1 Main St',
  registered_at: '2026-09-14', naics_code: 'Janitorial Services (561720)', sector: 'limpieza', priority: 'A',
  latino_signal: true, latino_strong: false, minority_owned: false, notes: 'señal latina: email: rivera', ...extra,
});

test('newFormToken: 24 caracteres URL-safe y no se repite', () => {
  const tokens = new Set(Array.from({ length: 2000 }, newFormToken));
  assert.equal(tokens.size, 2000);
  for (const t of [...tokens].slice(0, 50)) assert.match(t, /^[A-Za-z0-9_-]{24}$/);
});

test('getWatermark: devuelve la fecha más reciente de la última ingesta correcta (o null)', async () => {
  db.handlers.lead_ingest_runs = () => [{ newest_registration: '2026-09-27' }];
  assert.equal(await getWatermark(db, OWNER, 'ct_registry'), '2026-09-27');
  const f = db.calls.at(-1).filters;
  assert.deepEqual([f.user_id, f.source, f.ok], [OWNER, 'ct_registry', true]);
  db.handlers.lead_ingest_runs = () => [];
  assert.equal(await getWatermark(db, OWNER, 'ct_registry'), null);
  db.handlers.lead_ingest_runs = () => ({ __error: 'relation "lead_ingest_runs" does not exist' });
  await assert.rejects(() => getWatermark(db, OWNER, 'ct_registry'), /leer la última ingesta.*does not exist/);
});

test('recordRun inserta la fila de la ingesta y propaga errores', async () => {
  await recordRun(db, { user_id: OWNER, source: 'ct_registry', fetched: 10 });
  assert.equal(db.writes('lead_ingest_runs', 'insert')[0].payload.fetched, 10);
  db.handlers.lead_ingest_runs = () => ({ __error: 'boom' });
  await assert.rejects(() => recordRun(db, {}), /guardar la ingesta: boom/);
});

// ─── filterNewLeads ──────────────────────────────────────────────────────────
function seedDedupe({ suppressed = [], existingIds = [], existingEmails = [] } = {}) {
  db.handlers.email_suppressions = ctx => (suppressed.length ? (ctx.filters.email__in || []).filter(e => suppressed.includes(e)).map(email => ({ email })) : []);
  db.handlers.new_business_leads = ctx => {
    if (ctx.filters.external_id__in) return existingIds.filter(id => ctx.filters.external_id__in.includes(id)).map(external_id => ({ external_id, email: `x${external_id}@x.com` }));
    if (ctx.filters.email__in) return existingEmails.filter(e => ctx.filters.email__in.includes(e)).map(email => ({ email }));
    return [];
  };
}

test('filterNewLeads: pasa todo lo nuevo', async () => {
  seedDedupe();
  const { fresh, skipped } = await filterNewLeads(db, OWNER, 'ct_registry', [lead(1), lead(2)]);
  assert.equal(fresh.length, 2);
  assert.deepEqual(skipped, { existing: 0, suppressed: 0, emailTaken: 0, batchDuplicate: 0 });
});

test('filterNewLeads: descarta existentes, suprimidos, email ya asignado y repetidos del lote (se queda el más reciente)', async () => {
  seedDedupe({ suppressed: ['e2@gmail.com'], existingIds: ['1'], existingEmails: ['e3@gmail.com'] });
  const batch = [
    lead(1),                                  // ya existe
    lead(2),                                  // email suprimido
    lead(3),                                  // email de otro lead
    lead(4),                                  // ok (el más reciente con ese email)
    lead(5, { email: 'e4@gmail.com' }),       // mismo email que el 4 → repetido del lote
    lead(6),                                  // ok
  ];
  const { fresh, skipped } = await filterNewLeads(db, OWNER, 'ct_registry', batch);
  assert.deepEqual(fresh.map(l => l.external_id), ['4', '6']);
  assert.deepEqual(skipped, { existing: 1, suppressed: 1, emailTaken: 1, batchDuplicate: 1 });
});

test('filterNewLeads: todas las consultas van acotadas al usuario', async () => {
  seedDedupe();
  await filterNewLeads(db, OWNER, 'ct_registry', [lead(1)]);
  assert.ok(db.calls.length >= 3);
  for (const c of db.calls) assert.equal(c.filters.user_id, OWNER, `${c.table} sin filtro user_id`);
});

test('filterNewLeads: trocea las listas largas para no romper la URL', async () => {
  seedDedupe();
  const many = Array.from({ length: 400 }, (_, i) => lead(i));
  await filterNewLeads(db, OWNER, 'ct_registry', many);
  const sizes = db.calls.map(c => (c.filters.external_id__in || c.filters.email__in || []).length);
  assert.ok(sizes.every(s => s <= 150), `listas de ${Math.max(...sizes)}`);
});

test('filterNewLeads: sin candidatos no consulta nada; un error de BD se propaga con contexto', async () => {
  assert.deepEqual(await filterNewLeads(db, OWNER, 'ct_registry', []), { fresh: [], skipped: { existing: 0, suppressed: 0, emailTaken: 0, batchDuplicate: 0 } });
  assert.equal(db.calls.length, 0);
  db.handlers.email_suppressions = () => ({ __error: 'no existe la tabla' });
  await assert.rejects(() => filterNewLeads(db, OWNER, 'ct_registry', [lead(1)]), /consultar supresiones/);
});

// ─── insertLeads ─────────────────────────────────────────────────────────────
test('insertLeads: cada fila lleva user_id, source, token único, status y los campos del lead', async () => {
  const n = await insertLeads(db, OWNER, 'ct_registry', [lead(1), lead(2)]);
  assert.equal(n, 2);
  const up = db.writes('new_business_leads', 'upsert')[0];
  assert.deepEqual(up.options, { onConflict: 'user_id,source,external_id', ignoreDuplicates: true });
  const [a, b] = up.payload;
  assert.deepEqual([a.user_id, a.source, a.external_id, a.status, a.email, a.sector, a.priority], [OWNER, 'ct_registry', '1', 'new', 'e1@gmail.com', 'limpieza', 'A']);
  assert.notEqual(a.form_token, b.form_token);
  assert.match(a.form_token, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(a.latino_signal, true);
  assert.equal('sequence_step' in a, false);           // lo demás lo pone el default de la tabla
});

test('insertLeads: statusOf permite marcar "invalid_email"', async () => {
  await insertLeads(db, OWNER, 'ct_registry', [lead(1), lead(2)], l => (l.external_id === '2' ? 'invalid_email' : 'new'));
  assert.deepEqual(db.writes('new_business_leads', 'upsert')[0].payload.map(r => r.status), ['new', 'invalid_email']);
});

test('insertLeads: inserta en trozos de 200 y no hace nada con una lista vacía', async () => {
  assert.equal(await insertLeads(db, OWNER, 'ct_registry', []), 0);
  assert.equal(db.writes('new_business_leads', 'upsert').length, 0);
  await insertLeads(db, OWNER, 'ct_registry', Array.from({ length: 450 }, (_, i) => lead(i)));
  assert.deepEqual(db.writes('new_business_leads', 'upsert').map(c => c.payload.length), [200, 200, 50]);
});

test('insertLeads: un error de BD se propaga', async () => {
  db.handlers.new_business_leads = () => ({ __error: 'column "latino_strong" does not exist' });
  await assert.rejects(() => insertLeads(db, OWNER, 'ct_registry', [lead(1)]), /insertar leads.*latino_strong/);
});
