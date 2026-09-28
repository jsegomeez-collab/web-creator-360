// Envío por email compartido, seguimientos del cron y pipeline automático (Supabase y Resend simulados).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './helpers/fakeSupabase.mjs';

const src = (p) => new URL(`../src/${p}`, import.meta.url).href;

const db = createFakeDb();
let emails, profile, emailFails;
const reset = () => { db.reset(); emails = []; profile = {}; emailFails = false; delete process.env.NEW_LEADS_OWNER_USER_ID; };
reset();
beforeEach(reset);

mock.module(src('db/supabase.js'), { exports: { default: db } });
mock.module(src('services/resend.js'), { exports: {
  sendOutreachEmail: async (business, site, n, lang) => {
    if (emailFails) throw new Error('Resend: dominio sin verificar');
    emails.push({ to: site.contact_email, n, lang, name: business.name });
  },
  nextFollowUpDate: n => (n < 2 ? `FOLLOWUP+${n}` : null),
}});
mock.module(src('services/gemini.js'), { exports: { scrapeBusinessProfile: async () => profile } });
mock.module(src('services/claude.js'), { exports: { generateWebsite: async () => '<html></html>' } });
mock.module(src('services/vercel.js'), { exports: { deployToVercel: async () => 'https://x.vercel.app' } });

const { sendOutreach } = await import(src('services/outreach.js'));
const { runFollowUps } = await import(src('cron/jobs.js'));
const { runAutoPipeline } = await import(src('pipeline/auto.js'));

const biz = (extra = {}) => ({ id: 'b1', name: 'Coolfy Clima', ...extra });
const site = { id: 's1', slug: 'coolfy', preview_url: 'https://coolfy.vercel.app' };

// ─── sendOutreach ────────────────────────────────────────────────────────────
test('sendOutreach: envía el email, lo registra y marca web y negocio', async () => {
  await sendOutreach(biz(), site, 'a@b.com', 'es', 0);
  assert.deepEqual(emails, [{ to: 'a@b.com', n: 0, lang: 'es', name: 'Coolfy Clima' }]);
  const ins = db.writes('outreach_log', 'insert')[0].payload;
  assert.deepEqual([ins.channel, ins.contact, ins.follow_up_number, ins.next_follow_up_at], ['email', 'a@b.com', 0, 'FOLLOWUP+0']);
  assert.deepEqual(db.writes('generated_sites', 'update')[0].payload, { status: 'sent' });
  assert.deepEqual(db.writes('businesses', 'update')[0].payload, { status: 'active' });
});

test('sendOutreach: sin email lanza y NO marca la web como enviada', async () => {
  await assert.rejects(() => sendOutreach(biz(), site, null, 'es', 0), /Sin email/);
  assert.equal(emails.length, 0);
  assert.equal(db.writes('outreach_log', 'insert').length, 0);
  assert.equal(db.writes('generated_sites', 'update').length, 0);
});

test('sendOutreach: si Resend rechaza el email, lanza y no se registra ni se marca nada', async () => {
  emailFails = true;
  await assert.rejects(() => sendOutreach(biz(), site, 'a@b.com', 'es', 0), /dominio sin verificar/);
  assert.equal(db.writes('outreach_log', 'insert').length, 0);
  assert.equal(db.writes('generated_sites', 'update').length, 0);
  assert.equal(db.writes('businesses', 'update').length, 0);
});

// ─── runFollowUps ────────────────────────────────────────────────────────────
const logRow = (contact, extra = {}) => ({
  id: 'l1', business_id: 'b1', channel: 'email', contact, follow_up_number: 0,
  businesses: biz(), generated_sites: { ...site, status: 'sent' }, ...extra,
});
function seedFollowUp(row) {
  db.handlers.outreach_log = ctx => (ctx.op === 'select' ? [row] : null);
  db.handlers.business_web_data = () => ({ language: 'en' });
}

test('seguimiento: escribe a log.contact y avanza el log', async () => {
  seedFollowUp(logRow('a@b.com'));
  await runFollowUps();
  assert.deepEqual(emails, [{ to: 'a@b.com', n: 1, lang: 'en', name: 'Coolfy Clima' }]);
  const upd = db.writes('outreach_log', 'update')[0];
  assert.equal(upd.payload.follow_up_number, 1);
  assert.equal(upd.payload.next_follow_up_at, 'FOLLOWUP+1');
});

test('seguimiento: si el email falla, el log NO avanza', async () => {
  seedFollowUp(logRow('a@b.com'));
  const orig = emails.push;
  emails.push = () => { throw new Error('resend caído'); };
  await runFollowUps();
  emails.push = orig;
  assert.equal(db.writes('outreach_log', 'update').length, 0);
});

test('seguimiento: si la web ya no está en "sent" (p. ej. ya pagó → "active") se cancela y no se escribe', async () => {
  seedFollowUp(logRow('a@b.com', { generated_sites: { ...site, status: 'active' } }));
  await runFollowUps();
  assert.equal(emails.length, 0);
  assert.deepEqual(db.writes('outreach_log', 'update')[0].payload, { next_follow_up_at: null });
});

test('seguimiento: si el email se dio de baja o rebotó entretanto, se cancelan los seguimientos', async () => {
  process.env.NEW_LEADS_OWNER_USER_ID = 'owner-1';
  db.handlers.email_suppressions = () => [{ email: 'a@b.com', reason: 'unsubscribed' }];
  seedFollowUp(logRow('a@b.com'));
  await runFollowUps();
  assert.equal(emails.length, 0);
  assert.deepEqual(db.writes('outreach_log', 'update')[0].payload, { next_follow_up_at: null });
});

// ─── runAutoPipeline ─────────────────────────────────────────────────────────
// sleep() de 3 s → inmediato y reloj fijo en lunes 10:00. Solo durante estas pruebas: hacerlo global rompería fetch/http.
async function withFakeClock(fn) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => { cb(); return 0; };
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-28T10:00:00') });
  try { return await fn(); } finally { globalThis.setTimeout = realSetTimeout; mock.timers.reset(); }
}

function seedPipeline({ prospected = [], previewSites = [], webData = null, business = null }) {
  db.handlers.businesses = ctx => {
    if (ctx.op !== 'select') return null;
    if (ctx.filters.status === 'prospected') return prospected;
    if (ctx.filters.status === 'scraped') return [];
    if (ctx.filters.id) return business ? [business] : [];
    return [];
  };
  db.handlers.generated_sites = ctx => (ctx.op === 'select' && ctx.filters.status === 'preview' ? previewSites : null);
  db.handlers.outreach_log = ctx => (ctx.op === 'select' ? [] : null);
  db.handlers.business_web_data = () => webData;
}

test('pipeline scrape: guarda el perfil y pasa el negocio a "scraped" sin tocar su teléfono de Google Places', async () => {
  profile = { description: 'd', services: [], social_networks: [], hours: null, language: 'es', email: 'x@y.com', value_proposition: 'v' };
  seedPipeline({ prospected: [{ id: 'b1', name: 'Coolfy', website: 'https://x.es' }] });
  const stats = await withFakeClock(() => runAutoPipeline());
  assert.equal(stats.scraped, 1);
  assert.deepEqual(db.writes('businesses', 'update')[0].payload, { status: 'scraped' });
  assert.equal(db.writes('business_web_data', 'upsert')[0].payload.email, 'x@y.com');
});

test('pipeline outreach: con email → se envía', async () => {
  seedPipeline({ previewSites: [{ ...site, business_id: 'b1' }], webData: { email: 'a@b.com', language: 'es' }, business: biz() });
  const stats = await withFakeClock(() => runAutoPipeline());
  assert.equal(stats.sent, 1);
  assert.equal(stats.errors, 0);
  assert.equal(db.writes('outreach_log', 'insert')[0].payload.channel, 'email');
  assert.equal(emails.length, 1);
});

test('pipeline outreach: sin email → omitido y la web sigue en preview', async () => {
  seedPipeline({ previewSites: [{ ...site, business_id: 'b1' }], webData: { email: null, language: 'es' }, business: biz() });
  const stats = await withFakeClock(() => runAutoPipeline());
  assert.equal(stats.sent, 0);
  assert.equal(stats.skipped_no_email, 1);
  assert.equal(stats.errors, 0);
  assert.equal(db.writes('outreach_log', 'insert').length, 0);
  assert.equal(db.writes('generated_sites', 'update').length, 0);
});
