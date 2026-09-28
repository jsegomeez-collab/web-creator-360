// Enlace {{calendario}} de cada lead: registra el interés y redirige a tu calendario; ignora escáneres y no falla si la BD falla.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { createCampaignApp } from '../src/campaignApp.js';
import { isProbablyBot } from '../src/routes/calendarLink.js';

const OWNER = 'owner-1';
const CAL = 'https://cal.example.com/jose/15min';
const TOK = (n) => `TOKEN${String(n).padStart(19, '0')}`;
const HUMAN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

let server, base, db;
const lead = (n, over = {}) => ({ id: `L${n}`, user_id: OWNER, email: `Dueno${n}@Gmail.com`, status: 'emailed', link_token: TOK(n), engaged_at: null, ...over });
before(async () => {
  db = createMemoryDb({ new_business_leads: [] });
  server = await new Promise(r => { const s = createCampaignApp({ db, ownerId: OWNER, webhookSecret: 's', campaignId: null, calendarUrl: CAL }).listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

const seed = (leads) => { db.tables.new_business_leads = leads; };
const row = (id) => db.rows('new_business_leads').find(l => l.id === id);
let ip = 10;
const hit = (path, { ua = HUMAN, method = 'GET' } = {}) => fetch(base + path, { method, redirect: 'manual', headers: { 'user-agent': ua, 'x-forwarded-for': `10.2.0.${ip++}` } });

test('un clic normal: redirige al calendario con su email y marca al lead como "engaged"', async () => {
  seed([lead(1)]);
  const r = await hit(`/c/${TOK(1)}`);
  assert.equal(r.status, 302);
  const to = new URL(r.headers.get('location'));
  assert.equal(`${to.origin}${to.pathname}`, CAL);
  assert.equal(to.searchParams.get('email'), 'Dueno1@Gmail.com');
  assert.equal(to.searchParams.get('utm_content'), TOK(1));        // Calendly lo devuelve al reservar: así se sabe qué lead agendó
  assert.equal(to.searchParams.get('utm_source'), 'instantly');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(r.headers.get('cache-control'), /no-store/);
  const l = row('L1');
  assert.equal(l.status, 'engaged');
  assert.ok(Math.abs(Date.parse(l.engaged_at) - Date.now()) < 5000);
});

test('estados previos al interés (new, queued, emailed) pasan a engaged', async () => {
  for (const status of ['new', 'queued', 'emailed']) {
    seed([lead(1, { status })]);
    await hit(`/c/${TOK(1)}`);
    assert.equal(row('L1').status, 'engaged', status);
  }
});

test('quien ya avanzó (engaged, replied, called, won, lost…) NO cambia de estado ni se pisa su fecha', async () => {
  for (const status of ['engaged', 'booked', 'replied', 'called', 'won', 'lost', 'unsubscribed', 'bounced']) {
    seed([lead(1, { status, engaged_at: '2026-09-01T00:00:00.000Z' })]);
    const r = await hit(`/c/${TOK(1)}`);
    assert.equal(r.status, 302, status);                       // el calendario se abre igualmente
    assert.equal(row('L1').status, status, status);
    assert.equal(row('L1').engaged_at, '2026-09-01T00:00:00.000Z');
  }
});

test('escáneres de correo y vistas previas (HEAD, bots, sin user-agent): redirigen pero NO registran interés', async () => {
  seed([lead(1)]);
  for (const ua of ['', 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Microsoft Office Protocol Discovery', 'python-requests/2.31', 'Proofpoint URL Defense', 'Slackbot-LinkExpanding', 'WhatsApp/2.23', 'curl/8.0']) {
    const r = await hit(`/c/${TOK(1)}`, { ua });
    assert.equal(r.status, 302, ua);
  }
  const head = await hit(`/c/${TOK(1)}`, { method: 'HEAD' });
  assert.equal(head.status, 302);
  assert.equal(row('L1').status, 'emailed');
  assert.equal(row('L1').engaged_at, null);
});

test('isProbablyBot', () => {
  assert.equal(isProbablyBot(HUMAN), false);
  assert.equal(isProbablyBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1'), false);
  assert.equal(isProbablyBot(undefined), true);
  assert.equal(isProbablyBot('GoogleImageProxy'), true);
});

test('respeta los parámetros que ya tuviera tu enlace de calendario', async () => {
  const s = await new Promise(r => { const x = createCampaignApp({ db, ownerId: OWNER, webhookSecret: 's', campaignId: null, calendarUrl: 'https://calendly.com/jose/15min?hide_gdpr_banner=1' }).listen(0, () => r(x)); });
  try {
    seed([lead(1)]);
    const r = await fetch(`http://127.0.0.1:${s.address().port}/c/${TOK(1)}`, { redirect: 'manual', headers: { 'user-agent': HUMAN } });
    const to = new URL(r.headers.get('location'));
    assert.equal(to.searchParams.get('hide_gdpr_banner'), '1');
    assert.equal(to.searchParams.get('email'), 'Dueno1@Gmail.com');
  } finally { s.closeAllConnections?.(); s.close(); }
});

test('token inválido o inexistente → 404 (no redirige a ningún sitio)', async () => {
  seed([lead(1)]);
  for (const bad of ['corto', 'x'.repeat(25), `${TOK(1).slice(0, 23)}!`, TOK(99)]) {
    const r = await hit(`/c/${bad}`);
    assert.equal(r.status, 404, bad);
    assert.equal(r.headers.get('location'), null);
  }
});

test('un lead de otro usuario no se puede usar', async () => {
  seed([lead(1, { user_id: 'otro' })]);
  assert.equal((await hit(`/c/${TOK(1)}`)).status, 404);
});

test('si la base de datos falla, el calendario se abre igualmente (solo se pierde el seguimiento)', async () => {
  seed([lead(1)]);
  db.failNext('new_business_leads', 'select', 'caída');
  const orig = console.error; console.error = () => {};
  let r;
  try { r = await hit(`/c/${TOK(1)}`); } finally { console.error = orig; }
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.get('location')).searchParams.get('email'), null);    // sin lead no hay email que precargar
  assert.equal(row('L1').status, 'emailed');
});

test('si falla solo el guardado del interés, igualmente redirige', async () => {
  seed([lead(1)]);
  db.failNext('new_business_leads', 'update', 'timeout');
  const orig = console.error; console.error = () => {};
  let r;
  try { r = await hit(`/c/${TOK(1)}`); } finally { console.error = orig; }
  assert.equal(r.status, 302);
});

test('limitador: demasiadas peticiones desde una IP → 429', async () => {
  seed([lead(1)]);
  const codes = [];
  for (let i = 0; i < 65; i++) codes.push((await fetch(`${base}/c/${TOK(1)}`, { redirect: 'manual', headers: { 'user-agent': HUMAN, 'x-forwarded-for': '9.9.9.9' } })).status);
  assert.equal(codes[0], 302);
  assert.equal(codes.at(-1), 429);
});
