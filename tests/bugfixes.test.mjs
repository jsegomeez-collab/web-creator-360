// Envío multicanal compartido, seguimientos del cron y pipeline automático (Supabase, Resend y WhatsApp simulados).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './helpers/fakeSupabase.mjs';

const src = (p) => new URL(`../src/${p}`, import.meta.url).href;

const db = createFakeDb();
let emails, waSent, waState, profile;
const reset = () => { db.reset(); emails = []; waSent = []; waState = 'open'; profile = {}; };
reset();
beforeEach(reset);

mock.module(src('db/supabase.js'), { exports: { default: db } });
mock.module(src('services/resend.js'), { exports: {
  sendOutreachEmail: async (business, site, n, lang) => { emails.push({ to: site.contact_email, n, lang, name: business.name }); },
  nextFollowUpDate: n => (n < 2 ? `FOLLOWUP+${n}` : null),
}});
mock.module(src('services/whatsapp.js'), { exports: {
  getConnectionState: async () => waState,
  sendText: async (phone, msg) => { waSent.push({ phone, msg }); },
  buildMessage: (b, s, lang, isFollowUp) => `MSG(${lang},${isFollowUp ? 'followup' : 'first'})`,
  formatPhone: p => p,
}});
mock.module(src('services/gemini.js'), { exports: { scrapeBusinessProfile: async () => profile } });
mock.module(src('services/claude.js'), { exports: { generateWebsite: async () => '<html></html>' } });
mock.module(src('services/vercel.js'), { exports: { deployToVercel: async () => 'https://x.vercel.app' } });

const { sendOutreach } = await import(src('services/outreach.js'));
const { runFollowUps } = await import(src('cron/jobs.js'));
const { runAutoPipeline } = await import(src('pipeline/auto.js'));

const biz = (extra = {}) => ({ id: 'b1', name: 'Coolfy Clima', phone: '672577986', ...extra });
const site = { id: 's1', slug: 'coolfy', preview_url: 'https://coolfy.vercel.app' };

// ─── sendOutreach ────────────────────────────────────────────────────────────
test('sendOutreach: solo email → canal "email"', async () => {
  const r = await sendOutreach(biz({ phone: null }), site, 'a@b.com', 'es', 0);
  assert.deepEqual([r.emailSent, r.waSent], [true, false]);
  assert.equal(db.writes('outreach_log', 'insert')[0].payload.channel, 'email');
  assert.equal(db.writes('outreach_log', 'insert')[0].payload.contact, 'a@b.com');
});

test('sendOutreach: email + WA conectado → "email+whatsapp" (contacto = email)', async () => {
  const r = await sendOutreach(biz(), site, 'a@b.com', 'es', 0);
  assert.deepEqual([r.emailSent, r.waSent], [true, true]);
  const ins = db.writes('outreach_log', 'insert')[0].payload;
  assert.equal(ins.channel, 'email+whatsapp');
  assert.equal(ins.contact, 'a@b.com');
  assert.equal(waSent.length, 1);
});

test('sendOutreach: sin email, WA conectado → "whatsapp" (contacto = teléfono)', async () => {
  const r = await sendOutreach(biz(), site, null, 'es', 0);
  assert.deepEqual([r.emailSent, r.waSent], [false, true]);
  const ins = db.writes('outreach_log', 'insert')[0].payload;
  assert.equal(ins.channel, 'whatsapp');
  assert.equal(ins.contact, '672577986');
  assert.equal(emails.length, 0);
});

test('sendOutreach: sin email y WA desconectado → lanza y NO marca la web como enviada', async () => {
  waState = 'close';
  await assert.rejects(() => sendOutreach(biz(), site, null, 'es', 0), /ningún canal.*whatsapp_desconectado/);
  assert.equal(db.writes('outreach_log', 'insert').length, 0);
  assert.equal(db.writes('generated_sites', 'update').length, 0);
  assert.equal(db.writes('businesses', 'update').length, 0);
});

test('sendOutreach: sin email y sin teléfono → lanza (sin_telefono)', async () => {
  await assert.rejects(() => sendOutreach(biz({ phone: null }), site, null, 'es', 0), /sin_telefono/);
  assert.equal(db.writes('outreach_log', 'insert').length, 0);
});

test('sendOutreach: email + WA desconectado → sigue siendo "email"', async () => {
  waState = 'close';
  const r = await sendOutreach(biz(), site, 'a@b.com', 'es', 0);
  assert.deepEqual([r.emailSent, r.waSent, r.waReason], [true, false, 'whatsapp_desconectado']);
  assert.equal(db.writes('outreach_log', 'insert')[0].payload.channel, 'email');
});

// ─── runFollowUps ────────────────────────────────────────────────────────────
const logRow = (channel, contact, extra = {}) => ({
  id: 'l1', business_id: 'b1', channel, contact, follow_up_number: 0,
  businesses: biz(), generated_sites: { ...site, status: 'sent' }, ...extra,
});
function seedFollowUp(row) {
  db.handlers.outreach_log = ctx => (ctx.op === 'select' ? [row] : null);
  db.handlers.business_web_data = () => ({ language: 'en' });
}

test('seguimiento por email: escribe a log.contact y avanza el log', async () => {
  seedFollowUp(logRow('email', 'a@b.com'));
  await runFollowUps();
  assert.deepEqual(emails, [{ to: 'a@b.com', n: 1, lang: 'en', name: 'Coolfy Clima' }]);
  assert.equal(waSent.length, 0);
  const upd = db.writes('outreach_log', 'update')[0];
  assert.equal(upd.payload.follow_up_number, 1);
  assert.equal(upd.payload.next_follow_up_at, 'FOLLOWUP+1');
});

test('seguimiento de log solo-WhatsApp: NO manda email, manda WA de seguimiento', async () => {
  seedFollowUp(logRow('whatsapp', '672577986'));
  await runFollowUps();
  assert.equal(emails.length, 0);
  assert.deepEqual(waSent, [{ phone: '672577986', msg: 'MSG(en,followup)' }]);
  assert.equal(db.writes('outreach_log', 'update')[0].payload.follow_up_number, 1);
});

test('seguimiento solo-WhatsApp con WA desconectado: se pospone, el log NO avanza', async () => {
  waState = 'close';
  seedFollowUp(logRow('whatsapp', '672577986'));
  await runFollowUps();
  assert.equal(emails.length + waSent.length, 0);
  assert.equal(db.writes('outreach_log', 'update').length, 0);
});

test('seguimiento "email+whatsapp": ambos canales; con WA caído sale el email y el log avanza', async () => {
  seedFollowUp(logRow('email+whatsapp', 'a@b.com'));
  await runFollowUps();
  assert.equal(emails[0].to, 'a@b.com');
  assert.equal(waSent.length, 1);
  db.reset(); emails = []; waSent = []; waState = 'close';
  seedFollowUp(logRow('email+whatsapp', 'a@b.com'));
  await runFollowUps();
  assert.equal(emails.length, 1);
  assert.equal(db.writes('outreach_log', 'update').length, 1);
});

test('seguimiento de log antiguo sin channel: se trata como email', async () => {
  seedFollowUp(logRow(null, 'a@b.com'));
  await runFollowUps();
  assert.equal(emails[0].to, 'a@b.com');
});

test('seguimiento: si el email falla, el log NO avanza', async () => {
  seedFollowUp(logRow('email', 'a@b.com'));
  const orig = emails.push;
  emails.push = () => { throw new Error('resend caído'); };
  await runFollowUps();
  emails.push = orig;
  assert.equal(db.writes('outreach_log', 'update').length, 0);
});

test('seguimiento: si la web ya no está en "sent" (p. ej. ya pagó → "active") se cancela y no se escribe', async () => {
  seedFollowUp(logRow('email', 'a@b.com', { generated_sites: { ...site, status: 'active' } }));
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

test('pipeline scrape: guarda el teléfono scrapeado en businesses', async () => {
  profile = { description: 'd', services: [], social_networks: [], hours: null, language: 'es', email: null, value_proposition: 'v', phone: '34672577986' };
  seedPipeline({ prospected: [{ id: 'b1', name: 'Coolfy', website: 'https://x.es' }] });
  const stats = await withFakeClock(() => runAutoPipeline());
  assert.equal(stats.scraped, 1);
  assert.deepEqual(db.writes('businesses', 'update')[0].payload, { status: 'scraped', phone: '34672577986' });
});

test('pipeline scrape: sin teléfono en el perfil NO pisa el de Google Places', async () => {
  profile = { description: 'd', services: [], social_networks: [], hours: null, language: 'es', email: null, value_proposition: 'v' };
  seedPipeline({ prospected: [{ id: 'b1', name: 'Coolfy', website: 'https://x.es' }] });
  await withFakeClock(() => runAutoPipeline());
  assert.deepEqual(db.writes('businesses', 'update')[0].payload, { status: 'scraped' });
});

test('pipeline outreach: sin email pero con teléfono y WA conectado → WhatsApp', async () => {
  seedPipeline({ previewSites: [{ ...site, business_id: 'b1' }], webData: { email: null, language: 'es' }, business: biz() });
  const stats = await withFakeClock(() => runAutoPipeline());
  assert.equal(stats.sent, 1);
  assert.equal(stats.skipped_no_email, 0);
  assert.equal(db.writes('outreach_log', 'insert')[0].payload.channel, 'whatsapp');
  assert.equal(waSent.length, 1);
  assert.equal(emails.length, 0);
});

test('pipeline outreach: email + teléfono → canal "email+whatsapp"', async () => {
  seedPipeline({ previewSites: [{ ...site, business_id: 'b1' }], webData: { email: 'a@b.com', language: 'es' }, business: biz() });
  const stats = await withFakeClock(() => runAutoPipeline());
  assert.equal(stats.sent, 1);
  assert.equal(db.writes('outreach_log', 'insert')[0].payload.channel, 'email+whatsapp');
  assert.equal(emails.length, 1);
  assert.equal(waSent.length, 1);
});

test('pipeline outreach: sin email y WA desconectado → omitido, la web sigue en preview', async () => {
  waState = 'close';
  seedPipeline({ previewSites: [{ ...site, business_id: 'b1' }], webData: { email: null, language: 'es' }, business: biz() });
  const stats = await withFakeClock(() => runAutoPipeline());
  assert.equal(stats.sent, 0);
  assert.equal(stats.skipped_no_email, 1);
  assert.equal(stats.errors, 0);
  assert.equal(db.writes('outreach_log', 'insert').length, 0);
  assert.equal(db.writes('generated_sites', 'update').length, 0);
});

test('pipeline outreach: sin email ni teléfono → omitido', async () => {
  seedPipeline({ previewSites: [{ ...site, business_id: 'b1' }], webData: { email: null, language: 'es' }, business: biz({ phone: null }) });
  const stats = await withFakeClock(() => runAutoPipeline());
  assert.equal(stats.skipped_no_email, 1);
  assert.equal(db.writes('outreach_log', 'insert').length, 0);
});
