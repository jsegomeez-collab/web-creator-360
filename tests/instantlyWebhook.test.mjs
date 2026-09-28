// Webhook de Instantly: solo Instantly puede llamarlo, y cada evento actualiza al lead correcto sin retroceder estados.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { createCampaignApp } from '../src/campaignApp.js';

const OWNER = 'owner-1';
const SECRET = 'un-secreto-largo-de-prueba';
const CAMPAIGN = '5a1d6d4e-8a0b-4e9c-9a53-2f4c8e7f1b10';

let server, base, db;
const mkLead = (id, over = {}) => ({ id, user_id: OWNER, email: `${id.toLowerCase()}@gmail.com`, status: 'queued', ...over });

before(async () => {
  db = createMemoryDb({ new_business_leads: [], email_suppressions: [] });
  server = await new Promise(r => { const s = createCampaignApp({ db, ownerId: OWNER, webhookSecret: SECRET, campaignId: CAMPAIGN }).listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

const seed = (leads, sup = []) => { db.tables.new_business_leads = leads; db.tables.email_suppressions = sup; };
const row = (id) => db.rows('new_business_leads').find(l => l.id === id);
const post = (event, headers = { 'x-webhook-secret': SECRET }) => fetch(`${base}/webhooks/instantly`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ campaign_id: CAMPAIGN, timestamp: '2026-09-29T14:00:00.000Z', ...event }),
});

// ─── seguridad ───────────────────────────────────────────────────────────────
test('sin secreto o con secreto incorrecto → 401 y no se toca nada', async () => {
  seed([mkLead('L1')]);
  for (const headers of [{}, { 'x-webhook-secret': 'incorrecto' }, { 'x-webhook-secret': SECRET + 'x' }, { 'x-webhook-secret': '' }]) {
    const r = await post({ event_type: 'email_sent', lead_email: 'l1@gmail.com' }, headers);
    assert.equal(r.status, 401);
  }
  assert.equal(row('L1').status, 'queued');
});

test('servidor sin secreto configurado → 503 (nunca acepta llamadas sin proteger)', async () => {
  const s = await new Promise(r => { const x = createCampaignApp({ db, ownerId: OWNER, webhookSecret: '', campaignId: null }).listen(0, () => r(x)); });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/webhooks/instantly`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': '' }, body: '{}' });
    assert.equal(r.status, 503);
  } finally { s.closeAllConnections?.(); s.close(); }
});

// ─── eventos ─────────────────────────────────────────────────────────────────
test('email_sent: queued → emailed con la fecha del evento', async () => {
  seed([mkLead('L1'), mkLead('L2', { status: 'new' })]);
  assert.equal((await post({ event_type: 'email_sent', lead_email: 'L1@Gmail.com' })).status, 200);
  await post({ event_type: 'email_sent', lead_email: 'l2@gmail.com' });
  assert.deepEqual([row('L1').status, row('L1').emailed_at], ['emailed', '2026-09-29T14:00:00.000Z']);
  assert.equal(row('L2').status, 'emailed');
});

test('email_sent no hace retroceder a quien ya interactuó', async () => {
  seed([mkLead('L1', { status: 'engaged' }), mkLead('L2', { status: 'replied' }), mkLead('L3', { status: 'won' })]);
  for (const id of ['l1', 'l2', 'l3']) await post({ event_type: 'email_sent', lead_email: `${id}@gmail.com` });
  assert.deepEqual([row('L1').status, row('L2').status, row('L3').status], ['engaged', 'replied', 'won']);
});

test('email_bounced: bounced + supresión; un lead ya enganchado conserva su estado pero el email queda suprimido', async () => {
  seed([mkLead('L1', { status: 'emailed' }), mkLead('L2', { status: 'engaged' })]);
  await post({ event_type: 'email_bounced', lead_email: 'l1@gmail.com' });
  await post({ event_type: 'email_bounced', lead_email: 'l2@gmail.com' });
  assert.deepEqual([row('L1').status, row('L2').status], ['bounced', 'engaged']);
  assert.deepEqual(db.rows('email_suppressions').map(s => [s.user_id, s.email, s.reason]), [[OWNER, 'l1@gmail.com', 'bounced'], [OWNER, 'l2@gmail.com', 'bounced']]);
});

test('lead_unsubscribed: unsubscribed + supresión (idempotente si llega dos veces)', async () => {
  seed([mkLead('L1', { status: 'emailed' })]);
  await post({ event_type: 'lead_unsubscribed', lead_email: 'l1@gmail.com' });
  await post({ event_type: 'lead_unsubscribed', lead_email: 'l1@gmail.com' });
  assert.equal(row('L1').status, 'unsubscribed');
  assert.deepEqual(db.rows('email_suppressions').map(s => s.reason), ['unsubscribed']);
});

test('reply_received: pasa a replied y guarda la fecha; si ya estaba enganchado solo guarda la fecha', async () => {
  seed([mkLead('L1', { status: 'emailed' }), mkLead('L2', { status: 'engaged' })]);
  await post({ event_type: 'reply_received', lead_email: 'l1@gmail.com', reply_text_snippet: 'Me interesa' });
  await post({ event_type: 'reply_received', lead_email: 'l2@gmail.com' });
  assert.deepEqual([row('L1').status, row('L1').replied_at], ['replied', '2026-09-29T14:00:00.000Z']);
  assert.deepEqual([row('L2').status, row('L2').replied_at], ['engaged', '2026-09-29T14:00:00.000Z']);
});

test('timestamp inválido o ausente: usa la hora actual en vez de romper', async () => {
  seed([mkLead('L1')]);
  const r = await post({ event_type: 'email_sent', lead_email: 'l1@gmail.com', timestamp: 'no-es-fecha' });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(Date.parse(row('L1').emailed_at) - Date.now()) < 5000);
});

// ─── lo que se ignora (siempre 200: Instantly no debe reintentar) ────────────
test('eventos sin efecto, leads desconocidos, otras campañas y cuerpos raros → 200 sin cambios', async () => {
  seed([mkLead('L1')]);
  for (const event of [
    { event_type: 'email_opened', lead_email: 'l1@gmail.com' },
    { event_type: 'link_clicked', lead_email: 'l1@gmail.com' },
    { event_type: 'email_sent', lead_email: 'desconocido@x.com' },
    { event_type: 'email_sent', lead_email: 'l1@gmail.com', campaign_id: '00000000-0000-4000-8000-000000000000' },
    { event_type: 'email_sent' },
    { lead_email: 'l1@gmail.com' },
    {},
  ]) {
    const r = await post(event);
    assert.equal(r.status, 200, JSON.stringify(event));
  }
  assert.equal(row('L1').status, 'queued');
  const nonJson = await fetch(`${base}/webhooks/instantly`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET }, body: '{roto' });
  assert.ok(nonJson.status >= 400 && nonJson.status < 500);
});

test('el lead de otro usuario con el mismo email no se toca', async () => {
  seed([mkLead('L1', { user_id: 'otro-usuario', status: 'queued' })]);
  await post({ event_type: 'email_sent', lead_email: 'l1@gmail.com' });
  assert.equal(row('L1').status, 'queued');
});

test('un fallo de la base de datos responde 500 (para que Instantly reintente) y no afirma nada', async () => {
  seed([mkLead('L1')]);
  db.failNext('new_business_leads', 'update', 'timeout');
  const r = await post({ event_type: 'email_sent', lead_email: 'l1@gmail.com' });
  assert.equal(r.status, 500);
  assert.equal(row('L1').status, 'queued');
  const again = await post({ event_type: 'email_sent', lead_email: 'l1@gmail.com' });      // el reintento sí funciona
  assert.equal(again.status, 200);
  assert.equal(row('L1').status, 'emailed');
});

// ─── el servidor público solo expone lo necesario ────────────────────────────
test('/health responde y nada más (sin dashboard ni API interna)', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  for (const p of ['/', '/index.html', '/app.js', '/api/dashboard/stats', '/api/outreach/batch', '/preview/x']) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
});

// ─── aviso de la primera respuesta ───────────────────────────────────────────
async function withReplyHook(onReply, fn) {
  const s = await new Promise(r => { const x = createCampaignApp({ db, ownerId: OWNER, webhookSecret: SECRET, campaignId: CAMPAIGN, onReply }).listen(0, () => r(x)); });
  const send = (event) => fetch(`http://127.0.0.1:${s.address().port}/webhooks/instantly`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
    body: JSON.stringify({ campaign_id: CAMPAIGN, timestamp: '2026-09-29T14:00:00.000Z', ...event }),
  });
  try { await fn(send); } finally { s.closeAllConnections?.(); s.close(); }
}
const tick = () => new Promise(r => setTimeout(r, 25));

test('la primera respuesta avisa una vez (con los datos del lead); las siguientes no', async () => {
  seed([mkLead('L1', { name: 'Taller Ramos LLC', city: 'New Britain', sector: 'auto', replied_at: null })]);
  const calls = [];
  await withReplyHook(async (lead) => { calls.push(lead); }, async (send) => {
    assert.equal((await send({ event_type: 'reply_received', lead_email: 'l1@gmail.com' })).status, 200);
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].id, calls[0].name, calls[0].email, calls[0].city, calls[0].sector], ['L1', 'Taller Ramos LLC', 'l1@gmail.com', 'New Britain', 'auto']);
    await send({ event_type: 'reply_received', lead_email: 'l1@gmail.com' });
    await tick();
    assert.equal(calls.length, 1);
  });
  assert.equal(row('L1').status, 'replied');
});

test('quien ya pidió la llamada y luego responde: se avisa, pero su estado no retrocede', async () => {
  seed([mkLead('L1', { status: 'requested' })]);
  const calls = [];
  await withReplyHook(async (lead) => { calls.push(lead.id); }, async (send) => {
    await send({ event_type: 'reply_received', lead_email: 'l1@gmail.com' });
    await tick();
  });
  assert.deepEqual(calls, ['L1']);
  assert.equal(row('L1').status, 'requested');
  assert.ok(row('L1').replied_at);
});

test('otros eventos y leads desconocidos no avisan; si el aviso falla, Instantly recibe 200 igualmente', async () => {
  seed([mkLead('L1')]);
  const calls = [];
  const orig = console.error; console.error = () => {};
  try {
    await withReplyHook(async (lead) => { calls.push(lead.id); throw new Error('telegram caído'); }, async (send) => {
      await send({ event_type: 'email_sent', lead_email: 'l1@gmail.com' });
      await send({ event_type: 'reply_received', lead_email: 'desconocido@gmail.com' });
      await tick();
      assert.deepEqual(calls, []);
      const r = await send({ event_type: 'reply_received', lead_email: 'l1@gmail.com' });
      assert.equal(r.status, 200);
      await tick();
      assert.deepEqual(calls, ['L1']);
    });
  } finally { console.error = orig; }
});
