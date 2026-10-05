// Supabase devuelve como mucho 1000 filas por consulta (su "Max rows"), pida lo que pida .limit(). Con más de 1000 leads
// los contadores, la búsqueda, el envío y la comprobación de Instantly se quedaban cortos sin avisar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { selectAll } from '../src/lib/selectAll.js';
import { createLeadsRouter } from '../src/routes/leads.js';
import { pushLeads } from '../src/services/instantly.js';
import { pollInstantlyEvents } from '../src/services/instantlyPoll.js';

const OWNER = 'owner-1';
const CAP = 1000;
const N = 2345;
const pad = (i) => String(i).padStart(5, '0');
const leadRows = (n, o = {}) => Array.from({ length: n }, (_, i) => ({
  id: `lead-${pad(i)}`, user_id: OWNER, source: i % 2 ? 'csv_import' : 'ct_registry', external_id: pad(i), name: `Empresa ${pad(i)}`,
  email: `e${pad(i)}@gmail.com`, city: i === N - 1 ? 'Bridgeport' : 'Hartford', sector: 'limpieza', priority: 'A', status: 'new',
  registered_at: '2026-09-14', import_batch: i % 2 ? 'grande.csv · 2026-09-29 10:00' : null, link_token: `t${pad(i)}`, ...o,
}));

test('selectAll: lee todas las páginas aunque cada respuesta se corte en 1000', async () => {
  const db = createMemoryDb({ t: Array.from({ length: N }, (_, i) => ({ id: pad(i) })) }, { maxRows: CAP });
  assert.equal((await db.from('t').select('id').limit(50000)).data.length, CAP);   // el problema, tal cual
  const rows = await selectAll(() => db.from('t').select('id').order('id'));
  assert.equal(rows.length, N);
  assert.equal(new Set(rows.map(r => r.id)).size, N, 'sin filas repetidas ni saltadas');
});

test('selectAll: funciona aunque el tope del proyecto sea menor que el tamaño de página', async () => {
  const db = createMemoryDb({ t: Array.from({ length: 1234 }, (_, i) => ({ id: pad(i) })) }, { maxRows: 300 });
  assert.equal((await selectAll(() => db.from('t').select('id').order('id'))).length, 1234);
});

test('selectAll: `max` para antes, y un error de la base de datos se propaga', async () => {
  const db = createMemoryDb({ t: Array.from({ length: N }, (_, i) => ({ id: pad(i) })) }, { maxRows: CAP });
  assert.equal((await selectAll(() => db.from('t').select('id').order('id'), { max: 1500 })).length, 1500);
  db.failNext('t', 'select', 'boom');
  await assert.rejects(selectAll(() => db.from('t').select('id').order('id')), /boom/);
});

let db, server, base;
const api = (path) => fetch(`${base}/api/leads${path}`).then(r => r.json());

before(async () => {
  db = createMemoryDb({ new_business_leads: leadRows(N) }, { maxRows: CAP });
  const app = express();
  app.use(express.json());
  app.use('/api/leads', createLeadsRouter({ db, ownerId: OWNER }));
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

test('GET /stats cuenta todos los leads, no solo los 1000 primeros', async () => {
  const s = await api('/stats');
  assert.equal(s.total, N);
  assert.equal(s.byStatus.new, N);
});

test('GET / devuelve el total real y encuentra un lead que está más allá de la fila 1000', async () => {
  assert.equal((await api('/?limit=1')).total, N);
  const found = await api('/?q=bridgeport');
  assert.equal(found.total, 1);
  assert.equal(found.leads[0].id, `lead-${pad(N - 1)}`);
  assert.equal((await api(`/?limit=50&offset=${N - 5}`)).leads.length, 5, 'las últimas páginas también existen');
});

test('GET /import-batches cuenta todos los leads de una importación grande', async () => {
  assert.deepEqual(await api('/import-batches'), [{ batch: 'grande.csv · 2026-09-29 10:00', count: Math.floor(N / 2) }]);
});

test('pushLeads: con un límite mayor que 1000 envía de verdad ese número', async () => {
  const pdb = createMemoryDb({ new_business_leads: leadRows(1500) }, { maxRows: CAP });
  const config = { apiKey: 'k', campaignId: '00000000-0000-4000-8000-000000000000', publicUrl: 'https://c.example.com' };
  const r = await pushLeads({ db: pdb, ownerId: OWNER, config, limit: 1200, dryRun: true });
  assert.equal(r.pushed, 1200);
});

test('pollInstantlyEvents: revisa todos los leads enviados, también los que pasan de 1000', async () => {
  const pdb = createMemoryDb({ new_business_leads: leadRows(1500, { status: 'queued' }).map(l => ({ ...l, instantly_lead_id: `i-${l.id}` })) }, { maxRows: CAP });
  const fetchImpl = async (url, opts) => {
    const { ids } = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ items: ids.map(id => ({ id, status: 1, timestamp_last_contact: '2026-09-29T12:00:00.000Z' })) }) };
  };
  const r = await pollInstantlyEvents({ db: pdb, ownerId: OWNER, config: { apiKey: 'k' }, fetchImpl, sleep: async () => {} });
  assert.equal(r.checked, 1500);
  assert.equal(r.updated, 1500);
  assert.ok(pdb.rows('new_business_leads').every(l => l.status === 'emailed'));
});
