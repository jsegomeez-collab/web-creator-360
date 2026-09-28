// Guardarraíles en el flujo actual (Google Places): los negocios de la campaña de LLCs nuevas no salen por aquí, y ningún
// flujo escribe a emails suprimidos. El comportamiento normal no cambia.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createFakeDb } from './helpers/fakeSupabase.mjs';

const src = (p) => new URL(`../src/${p}`, import.meta.url).href;
const db = createFakeDb();
let emails;
const reset = () => { db.reset(); emails = []; delete process.env.NEW_LEADS_OWNER_USER_ID; };
reset();
beforeEach(reset);

mock.module(src('db/supabase.js'), { exports: { default: db } });
mock.module(src('services/resend.js'), { exports: {
  sendOutreachEmail: async (business, site) => { emails.push({ to: site.contact_email, name: business.name }); },
  nextFollowUpDate: (n) => (n < 2 ? `FOLLOWUP+${n}` : null),
}});
mock.module(src('services/gemini.js'), { exports: { scrapeBusinessProfile: async () => ({}) } });
mock.module(src('services/claude.js'), { exports: { generateWebsite: async () => '<html></html>' } });
mock.module(src('services/vercel.js'), { exports: { deployToVercel: async () => 'https://x.vercel.app' } });

const { sendOutreach } = await import(src('services/outreach.js'));
const { runAutoPipeline } = await import(src('pipeline/auto.js'));
const { default: outreachRouter } = await import(src('routes/outreach.js'));
const { LEAD_BUSINESS_SOURCE } = await import(src('services/newLeads.js'));

const site = { id: 's1', slug: 'x', preview_url: 'https://x.vercel.app' };
const biz = (over = {}) => ({ id: 'b1', name: 'Coolfy Clima', source: 'places', ...over });
const wrote = (table, op) => db.writes(table, op);

// ─── sendOutreach ────────────────────────────────────────────────────────────
test('negocio de la campaña: NO se envía nada por este camino y no se toca su estado', async () => {
  await assert.rejects(() => sendOutreach(biz({ source: LEAD_BUSINESS_SOURCE }), site, 'a@b.com', 'es', 0), /campaña de LLCs nuevas/);
  assert.equal(emails.length, 0);
  assert.equal(wrote('outreach_log', 'insert').length, 0);
  assert.equal(wrote('generated_sites', 'update').length, 0);
});

test('flujo normal sin supresiones: no cambia', async () => {
  process.env.NEW_LEADS_OWNER_USER_ID = 'owner-1';
  db.handlers.email_suppressions = () => [];
  await sendOutreach(biz(), site, 'a@b.com', 'es', 0);
  assert.equal(emails.length, 1);
  assert.equal(wrote('outreach_log', 'insert')[0].payload.channel, 'email');
});

test('email suprimido (baja o rebote): no se escribe y no se registra nada', async () => {
  process.env.NEW_LEADS_OWNER_USER_ID = 'owner-1';
  db.handlers.email_suppressions = (ctx) => (ctx.filters.email__in?.includes('a@b.com') ? [{ email: 'a@b.com', reason: 'unsubscribed' }] : []);
  await assert.rejects(() => sendOutreach(biz(), site, 'A@B.com', 'es', 0), /supresiones/);
  assert.equal(emails.length, 0);
  assert.equal(wrote('outreach_log', 'insert').length, 0);
  assert.equal(wrote('generated_sites', 'update').length, 0);
});

test('la consulta de supresiones va acotada al usuario del negocio (o al dueño por defecto)', async () => {
  process.env.NEW_LEADS_OWNER_USER_ID = 'owner-1';
  db.handlers.email_suppressions = () => [];
  await sendOutreach(biz({ user_id: 'user-del-negocio' }), site, 'a@b.com', 'es', 0);
  assert.equal(db.calls.find(c => c.table === 'email_suppressions').filters.user_id, 'user-del-negocio');
  db.calls.length = 0;
  await sendOutreach(biz(), site, 'a@b.com', 'es', 0);
  assert.equal(db.calls.find(c => c.table === 'email_suppressions').filters.user_id, 'owner-1');
});

test('sin usuario dueño ni user_id no hay con quién comparar: no consulta y envía como siempre', async () => {
  await sendOutreach(biz(), site, 'a@b.com', 'es', 0);
  assert.equal(db.calls.filter(c => c.table === 'email_suppressions').length, 0);
  assert.equal(emails.length, 1);
});

test('si la tabla de supresiones falla, el flujo antiguo sigue funcionando (falla abierto)', async () => {
  process.env.NEW_LEADS_OWNER_USER_ID = 'owner-1';
  db.handlers.email_suppressions = () => ({ __error: 'relation does not exist' });
  const orig = console.warn; console.warn = () => {};
  try { await sendOutreach(biz(), site, 'a@b.com', 'es', 0); } finally { console.warn = orig; }
  assert.equal(emails.length, 1);
});

// ─── pipeline automático ─────────────────────────────────────────────────────
const realSetTimeout = globalThis.setTimeout;
async function withFakeClock(fn) {
  globalThis.setTimeout = (cb) => { cb(); return 0; };
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-28T10:00:00') });
  try { return await fn(); } finally { globalThis.setTimeout = realSetTimeout; mock.timers.reset(); }
}
function seedPipeline({ previewSites, leadBusinessIds = [], businesses = {} }) {
  db.handlers.businesses = (ctx) => {
    if (ctx.op !== 'select') return null;
    if (ctx.filters.source === LEAD_BUSINESS_SOURCE) return leadBusinessIds.map(id => ({ id }));
    if (ctx.filters.status) return [];
    if (ctx.filters.id) return businesses[ctx.filters.id] ? [businesses[ctx.filters.id]] : [];
    return [];
  };
  db.handlers.generated_sites = (ctx) => (ctx.op === 'select' && ctx.filters.status === 'preview' ? previewSites : null);
  db.handlers.outreach_log = (ctx) => (ctx.op === 'select' ? [] : null);
  db.handlers.business_web_data = () => ({ email: 'a@b.com', language: 'es' });
}

test('pipeline: las demos de la campaña no se envían y NO bloquean el lote de los demás (aunque haya muchas)', async () => {
  const lead = Array.from({ length: 10 }, (_, i) => ({ id: `s-l${i}`, slug: `l${i}`, preview_url: 'https://x', business_id: `b-l${i}` }));
  seedPipeline({
    previewSites: [...lead, { id: 's-ok', slug: 'ok', preview_url: 'https://ok', business_id: 'b-ok' }],
    leadBusinessIds: lead.map(s => s.business_id),
    businesses: { 'b-ok': biz({ id: 'b-ok' }) },
  });
  const stats = await withFakeClock(() => runAutoPipeline());
  assert.equal(stats.sent, 1);
  assert.equal(stats.errors, 0);
  assert.deepEqual(wrote('outreach_log', 'insert').map(c => c.payload.site_id), ['s-ok']);
});

// ─── envío por lotes manual (dashboard) ──────────────────────────────────────
test('/api/outreach/batch: se salta los negocios de la campaña (no los lista, no los envía)', async () => {
  db.handlers.generated_sites = (ctx) => (ctx.op === 'select' ? [
    { id: 's-lead', slug: 'lead', preview_url: 'https://l', business_id: 'b-lead' },
    { id: 's-ok', slug: 'ok', preview_url: 'https://ok', business_id: 'b-ok' },
  ] : null);
  db.handlers.business_web_data = () => ({ email: 'dueno@gmail.com', language: 'es' });
  db.handlers.businesses = (ctx) => (ctx.op === 'select' ? [ctx.filters.id === 'b-lead' ? biz({ id: 'b-lead', source: LEAD_BUSINESS_SOURCE }) : biz({ id: 'b-ok' })] : null);
  db.handlers.outreach_log = (ctx) => (ctx.op === 'select' ? [] : null);

  const app = express(); app.use(express.json()); app.use('/api/outreach', outreachRouter);
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/outreach/batch`, { method: 'POST' });
    const events = (await res.text()).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(events[0].total, 1);                                         // solo el negocio normal
    const ok = events.filter(e => e.status === 'ok');
    assert.deepEqual(ok.map(e => [e.slug, e.email]), [['ok', 'dueno@gmail.com']]);
    assert.equal(emails.length, 1);
  } finally { server.closeAllConnections?.(); server.close(); }
});

test('/api/outreach/:siteId sin email → 400 claro; con email → success', async () => {
  db.handlers.generated_sites = (ctx) => (ctx.op === 'select' ? { ...site, businesses: biz() } : null);
  db.handlers.business_web_data = () => ({ email: null, language: 'es' });
  db.handlers.outreach_log = (ctx) => (ctx.op === 'select' ? [] : null);
  const app = express(); app.use(express.json()); app.use('/api/outreach', outreachRouter);
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/outreach/s1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const no = await post({});
    assert.equal(no.status, 400);
    assert.match((await no.json()).error, /Sin email/);
    const yes = await post({ email: 'nuevo@negocio.com' });
    assert.deepEqual(await yes.json(), { success: true, email: 'nuevo@negocio.com' });
    assert.deepEqual(emails.map(e => e.to), ['nuevo@negocio.com']);
  } finally { server.closeAllConnections?.(); server.close(); }
});
