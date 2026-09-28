// Baja de un clic (/u/:token): efecto real, idempotente, a prueba de escáneres de correo y sin falsas confirmaciones.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { unsubscribeRouter } from '../src/routes/unsubscribe.js';
import { createLimiter } from '../src/lib/rateLimit.js';
import { runSendCycle } from '../src/services/leadSequence.js';

const OWNER = 'owner-1';
const TOK = (n) => `TOKEN${String(n).padStart(19, '0')}`;      // 24 caracteres
const lead = (n, over = {}) => ({ id: `L${n}`, user_id: OWNER, name: `Negocio ${n}`, email: `Dueno${n}@Gmail.com`, status: 'emailed', sequence_step: 1, next_send_at: '2026-10-01T13:00:00.000Z', form_token: TOK(n), ...over });

let server, base, db;
before(async () => {
  db = createMemoryDb({ new_business_leads: [], email_suppressions: [] });
  const app = express();
  app.set('trust proxy', true);
  app.use(unsubscribeRouter(db, { limiter: createLimiter({ max: 1000, windowMs: 60_000 }) }));
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

const seed = (leads, sup = []) => { db.tables.new_business_leads = leads; db.tables.email_suppressions = sup; };
const row = (id) => db.rows('new_business_leads').find(l => l.id === id);
const get = (path, opts = {}) => fetch(base + path, { headers: { 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}` }, ...opts });

test('GET /u/:token: da de baja al instante (un clic), suprime el email en minúsculas y para la secuencia', async () => {
  seed([lead(1)]);
  const r = await get(`/u/${TOK(1)}`);
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.ok(html.includes('Listo, te hemos dado de baja'));
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.deepEqual([row('L1').status, row('L1').next_send_at], ['unsubscribed', null]);
  assert.deepEqual(db.rows('email_suppressions').map(s => [s.user_id, s.email, s.reason]), [[OWNER, 'dueno1@gmail.com', 'unsubscribed']]);
});

test('es idempotente: repetir el enlace no duplica ni da error', async () => {
  seed([lead(1)]);
  await get(`/u/${TOK(1)}`);
  const again = await get(`/u/${TOK(1)}`);
  assert.equal(again.status, 200);
  assert.equal(db.rows('email_suppressions').length, 1);
});

test('POST (one-click de List-Unsubscribe, RFC 8058, con cuerpo del formulario) hace lo mismo', async () => {
  seed([lead(2)]);
  const r = await fetch(`${base}/u/${TOK(2)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '10.0.0.9' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(r.status, 200);
  assert.equal(row('L2').status, 'unsubscribed');
  assert.equal(db.rows('email_suppressions').length, 1);
});

test('HEAD (escáneres y vistas previas de enlaces) NO da de baja a nadie', async () => {
  seed([lead(1)]);
  const r = await fetch(`${base}/u/${TOK(1)}`, { method: 'HEAD', headers: { 'x-forwarded-for': '10.0.0.10' } });
  assert.equal(r.status, 200);
  assert.equal(row('L1').status, 'emailed');
  assert.equal(db.rows('email_suppressions').length, 0);
});

test('token inválido o inexistente → 404 sin tocar nada', async () => {
  seed([lead(1)]);
  for (const bad of ['corto', 'x'.repeat(25), `${TOK(1).slice(0, 23)}!`, '..%2F..%2Fetc', TOK(99)]) {
    const r = await get(`/u/${bad}`);
    assert.equal(r.status, 404, bad);
  }
  assert.equal(row('L1').status, 'emailed');
  assert.equal(db.rows('email_suppressions').length, 0);
});

test('un lead que ya convirtió (rellenó el formulario) conserva su estado pero queda suprimido', async () => {
  seed([lead(1, { status: 'form_submitted' }), lead(2, { status: 'won' })]);
  await get(`/u/${TOK(1)}`); await get(`/u/${TOK(2)}`);
  assert.deepEqual([row('L1').status, row('L2').status], ['form_submitted', 'won']);
  assert.equal(db.rows('email_suppressions').length, 2);
});

test('todos los estados previos a la conversión pasan a unsubscribed', async () => {
  for (const status of ['new', 'queued', 'emailed', 'replied', 'sequence_finished']) {
    seed([lead(1, { status })]);
    await get(`/u/${TOK(1)}`);
    assert.equal(row('L1').status, 'unsubscribed', status);
  }
});

test('solo afecta al lead del token (y al usuario dueño): los demás siguen igual', async () => {
  seed([lead(1), lead(2), lead(3, { user_id: 'otro-usuario', email: 'dueno1@gmail.com' })]);
  await get(`/u/${TOK(1)}`);
  assert.equal(row('L2').status, 'emailed');
  assert.equal(row('L3').status, 'emailed');
  assert.deepEqual(db.rows('email_suppressions').map(s => s.user_id), [OWNER]);
});

test('si no se puede guardar, NO confirma la baja (responde 500 y no dice "te hemos dado de baja")', async () => {
  seed([lead(1)]);
  db.failNext('email_suppressions', 'upsert', 'boom');
  const r = await get(`/u/${TOK(1)}`);
  const html = await r.text();
  assert.equal(r.status, 500);
  assert.ok(!html.includes('te hemos dado de baja'));
  assert.equal(row('L1').status, 'emailed');
});

test('limitador: demasiadas peticiones desde la misma IP → 429', async () => {
  const app = express(); app.set('trust proxy', true);
  app.use(unsubscribeRouter(db, { limiter: createLimiter({ max: 2, windowMs: 60_000 }) }));
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); });
  try {
    seed([lead(1)]);
    const url = `http://127.0.0.1:${s.address().port}/u/${TOK(1)}`;
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await fetch(url, { headers: { 'x-forwarded-for': '9.9.9.9' } })).status);
    assert.deepEqual(codes, [200, 200, 429, 429]);
  } finally { s.closeAllConnections?.(); s.close(); }
});

test('INTEGRACIÓN: tras darse de baja, el ciclo de envío ya no le escribe (ni el seguimiento que tenía vencido)', async () => {
  seed([lead(1, { mailbox: 'a', first_message_id: '<x@t>', first_subject: 'S', last_sent_at: '2026-09-28T14:00:00.000Z' })]);
  await get(`/u/${TOK(1)}`);
  const sent = [];
  const mailer = { async send(mbx, m) { sent.push(m); return { messageId: '<n@t>' }; }, close() {} };
  const r = await runSendCycle({
    db, ownerId: OWNER, mailboxes: [{ id: 'a', dailyLimit: 30 }], mailer, now: new Date('2026-10-01T13:00:00Z'), dryRun: false, pause: async () => {}, log: () => {},
    config: { baseUrl: 'https://app.example.com', companyName: 'X', companyAddress: 'Y', senderName: 'Jose' },
  });
  assert.equal(sent.length, 0);
  assert.equal(r.sent, 0);
});
