// La página de cada lead (enlace del email): registra que la abrió, pide su teléfono, guarda la solicitud con su consentimiento
// y avisa una sola vez; ignora escáneres y no rompe si falla la base de datos o el aviso.
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { createCampaignApp } from '../src/campaignApp.js';
import { isProbablyBot } from '../src/routes/leadLink.js';
import { CONSENT_TEXT } from '../src/services/callRequests.js';

const OWNER = 'owner-1';
const TOK = (n) => `TOKEN${String(n).padStart(19, '0')}`;
const HUMAN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const tick = () => new Promise(r => setTimeout(r, 25));

let server, base, db, onRequested;
const lead = (n, over = {}) => ({ id: `L${n}`, user_id: OWNER, name: `Limpieza ${n} LLC`, email: `dueno${n}@gmail.com`, city: 'Hartford', sector: 'limpieza', status: 'emailed', link_token: TOK(n), engaged_at: null, ...over });
const seed = (leads) => { db.tables.new_business_leads = leads; };
const row = (id) => db.rows('new_business_leads').find(l => l.id === id);
const quiet = async (fn) => { const orig = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = orig; } };

before(async () => {
  db = createMemoryDb({ new_business_leads: [] });
  onRequested = mock.fn(async () => {});
  server = await new Promise(r => { const s = createCampaignApp({ db, ownerId: OWNER, onRequested: (...a) => onRequested(...a) }).listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });
beforeEach(() => { onRequested.mock.resetCalls(); });

let ip = 10;
const get = (path, { ua = HUMAN, method = 'GET' } = {}) => fetch(base + path, { method, headers: { 'user-agent': ua, 'x-forwarded-for': `10.2.0.${ip++}` } });
const post = (path, form, { ip: from = `10.3.0.${ip++}` } = {}) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': from }, body: new URLSearchParams(form).toString(),
});
const valid = (over = {}) => ({ phone: '860 555 0100', name: 'Ana', when: 'Mañana por la tarde', consent: 'on', ...over });

// ─── abrir la página ─────────────────────────────────────────────────────────
test('un clic normal: muestra el formulario con el nombre de su empresa y marca al lead como "engaged"', async () => {
  seed([lead(1, { name: 'LIMPIEZA RIVERA LLC' })]);
  const r = await get(`/c/${TOK(1)}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Limpieza Rivera LLC/);                                    // nombre legible, no en mayúsculas
  assert.match(html, /name="phone"/);
  assert.match(html, /<option selected>Lo antes posible<\/option>/);
  assert.ok(html.includes('Mañana por la tarde') && html.includes(CONSENT_TEXT));
  assert.doesNotMatch(html, /name="consent"[^>]*checked/);                       // el consentimiento es un acto activo: sin marcar
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  const l = row('L1');
  assert.equal(l.status, 'engaged');
  assert.ok(Math.abs(Date.parse(l.engaged_at) - Date.now()) < 5000);
});

test('estados previos al interés (new, queued, emailed) pasan a engaged', async () => {
  for (const status of ['new', 'queued', 'emailed']) {
    seed([lead(1, { status })]);
    await get(`/c/${TOK(1)}`);
    assert.equal(row('L1').status, 'engaged', status);
  }
});

test('quien ya avanzó (engaged, requested, replied, called, won, lost…) NO cambia de estado ni se pisa su fecha', async () => {
  for (const status of ['engaged', 'requested', 'replied', 'called', 'won', 'lost', 'unsubscribed', 'bounced']) {
    seed([lead(1, { status, engaged_at: '2026-09-01T00:00:00.000Z' })]);
    const r = await get(`/c/${TOK(1)}`);
    assert.equal(r.status, 200, status);
    assert.equal(row('L1').status, status, status);
    assert.equal(row('L1').engaged_at, '2026-09-01T00:00:00.000Z');
  }
});

test('si ya pidió la llamada, la página muestra su teléfono y su elección', async () => {
  seed([lead(1, { status: 'requested', phone: '+18605550100', contact_name: 'Ana', preferred_time: 'Hoy, más tarde' })]);
  const html = await (await get(`/c/${TOK(1)}`)).text();
  assert.ok(html.includes('value="+18605550100"') && html.includes('value="Ana"') && html.includes('<option selected>Hoy, más tarde</option>'));
});

test('escáneres de correo y vistas previas (HEAD, bots, sin user-agent): ven la página pero NO registran interés', async () => {
  seed([lead(1)]);
  for (const ua of ['', 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Microsoft Office Protocol Discovery', 'python-requests/2.31', 'Proofpoint URL Defense', 'Slackbot-LinkExpanding', 'WhatsApp/2.23', 'curl/8.0']) {
    assert.equal((await get(`/c/${TOK(1)}`, { ua })).status, 200, ua);
  }
  assert.equal((await get(`/c/${TOK(1)}`, { method: 'HEAD' })).status, 200);
  assert.equal(row('L1').status, 'emailed');
  assert.equal(row('L1').engaged_at, null);
});

test('isProbablyBot', () => {
  assert.equal(isProbablyBot(HUMAN), false);
  assert.equal(isProbablyBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1'), false);
  assert.equal(isProbablyBot(undefined), true);
  assert.equal(isProbablyBot('GoogleImageProxy'), true);
});

test('un nombre de empresa con HTML no se ejecuta: se escapa', async () => {
  seed([lead(1, { name: '<script>alert(1)</script> & Co "LLC"' })]);
  const html = await (await get(`/c/${TOK(1)}`)).text();
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; Co &quot;LLC&quot;/);
});

test('token inválido o inexistente → 404; un lead de otro usuario no se puede usar', async () => {
  seed([lead(1), lead(2, { user_id: 'otro' })]);
  for (const bad of ['corto', 'x'.repeat(25), `${TOK(1).slice(0, 23)}!`, TOK(99), TOK(2)]) {
    assert.equal((await get(`/c/${bad}`)).status, 404, bad);
    assert.equal((await post(`/c/${bad}`, valid())).status, 404, bad);
  }
  assert.equal(row('L2').status, 'emailed');
});

test('si la base de datos falla al abrir: aviso amable (503), sin caerse', async () => {
  seed([lead(1)]);
  db.failNext('new_business_leads', 'select', 'caída');
  const r = await quiet(() => get(`/c/${TOK(1)}`));
  assert.equal(r.status, 503);
  assert.match(await r.text(), /Vuelve a intentarlo/);
  assert.equal(row('L1').status, 'emailed');
});

test('si falla solo el guardado del interés, la página se muestra igualmente', async () => {
  seed([lead(1)]);
  db.failNext('new_business_leads', 'update', 'timeout');
  assert.equal((await quiet(() => get(`/c/${TOK(1)}`))).status, 200);
});

test('limitador de aperturas: demasiadas peticiones desde una IP → 429', async () => {
  seed([lead(1)]);
  const codes = [];
  for (let i = 0; i < 65; i++) codes.push((await fetch(`${base}/c/${TOK(1)}`, { headers: { 'user-agent': HUMAN, 'x-forwarded-for': '9.9.9.9' } })).status);
  assert.equal(codes[0], 200);
  assert.equal(codes.at(-1), 429);
});

// ─── enviar el formulario ────────────────────────────────────────────────────
test('formulario válido: guarda teléfono, nombre, hora y consentimiento; el lead pasa a "requested" y se avisa una vez', async () => {
  seed([lead(1, { status: 'engaged' })]);
  const r = await post(`/c/${TOK(1)}`, valid(), { ip: '203.0.113.7' });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('¡Recibido!') && html.includes('+18605550100') && html.includes('mañana por la tarde'));
  const l = row('L1');
  assert.deepEqual([l.status, l.phone, l.contact_name, l.preferred_time], ['requested', '+18605550100', 'Ana', 'Mañana por la tarde']);
  assert.equal(l.consent_text, CONSENT_TEXT);
  assert.equal(l.consent_ip, '203.0.113.7');
  assert.ok(Math.abs(Date.parse(l.requested_at) - Date.now()) < 5000 && Math.abs(Date.parse(l.consent_at) - Date.now()) < 5000);
  await tick();
  assert.equal(onRequested.mock.callCount(), 1);
  const [hookLead, values] = onRequested.mock.calls[0].arguments;
  assert.deepEqual([hookLead.id, hookLead.name, hookLead.status, hookLead.phone], ['L1', 'Limpieza 1 LLC', 'requested', '+18605550100']);
  assert.deepEqual(values, { phone: '+18605550100', name: 'Ana', preferred_time: 'Mañana por la tarde' });
});

test('el teléfono se entiende en cualquier formato de EE. UU.', async () => {
  for (const [typed, saved] of [['(860) 555-0100', '+18605550100'], ['860.555.0100', '+18605550100'], ['+1 860 555 0100', '+18605550100'], ['1-860-555-0100', '+18605550100']]) {
    seed([lead(1)]);
    assert.equal((await post(`/c/${TOK(1)}`, valid({ phone: typed }))).status, 200, typed);
    assert.equal(row('L1').phone, saved, typed);
  }
});

test('nombre opcional y hora fuera de las opciones → se usa la primera; desde new, queued, emailed, engaged y replied', async () => {
  for (const status of ['new', 'queued', 'emailed', 'engaged', 'replied']) {
    seed([lead(1, { status })]);
    await post(`/c/${TOK(1)}`, valid({ name: '  ', when: 'a las 3 de la madrugada' }));
    const l = row('L1');
    assert.deepEqual([l.status, l.contact_name, l.preferred_time], ['requested', null, 'Lo antes posible'], status);
  }
});

test('sin marcar el consentimiento o con un teléfono inválido: 400, se conserva lo escrito, no se guarda ni se avisa', async () => {
  for (const form of [valid({ consent: undefined }), valid({ phone: '123' }), valid({ phone: '' }), valid({ phone: '000 000 0000' })]) {
    seed([lead(1)]);
    const r = await post(`/c/${TOK(1)}`, Object.fromEntries(Object.entries(form).filter(([, v]) => v !== undefined)));
    assert.equal(r.status, 400, JSON.stringify(form));
    const html = await r.text();
    assert.match(html, /class="err"/);
    assert.ok(html.includes('value="Ana"'));
    assert.deepEqual([row('L1').status, row('L1').phone ?? null], ['emailed', null]);
  }
  await tick();
  assert.equal(onRequested.mock.callCount(), 0);
});

test('enviar dos veces: un solo aviso, la segunda actualiza los datos y no cambia la fecha de la solicitud', async () => {
  seed([lead(1)]);
  await post(`/c/${TOK(1)}`, valid());
  const first = row('L1').requested_at;
  await new Promise(r => setTimeout(r, 5));
  const r = await post(`/c/${TOK(1)}`, valid({ phone: '203 555 0111', when: 'Hoy, más tarde' }));
  assert.equal(r.status, 200);
  const l = row('L1');
  assert.deepEqual([l.status, l.phone, l.preferred_time, l.requested_at], ['requested', '+12035550111', 'Hoy, más tarde', first]);
  await tick();
  assert.equal(onRequested.mock.callCount(), 1);
});

test('dos envíos a la vez: un solo aviso', async () => {
  seed([lead(1)]);
  await Promise.all([post(`/c/${TOK(1)}`, valid()), post(`/c/${TOK(1)}`, valid())]);
  await tick();
  assert.equal(onRequested.mock.callCount(), 1);
});

test('quien ya está llamado/ganado/perdido o fuera (baja, rebote…): "Ya tenemos tu solicitud", sin cambios ni aviso', async () => {
  for (const status of ['called', 'won', 'lost', 'unsubscribed', 'bounced', 'invalid_email', 'rejected']) {
    seed([lead(1, { status })]);
    const r = await post(`/c/${TOK(1)}`, valid());
    assert.equal(r.status, 200, status);
    assert.match(await r.text(), /Ya tenemos tu solicitud/);
    assert.deepEqual([row('L1').status, row('L1').phone ?? null], [status, null], status);
  }
  await tick();
  assert.equal(onRequested.mock.callCount(), 0);
});

test('el campo oculto que solo rellenan los bots: parece que funcionó pero no se guarda nada', async () => {
  seed([lead(1)]);
  const r = await post(`/c/${TOK(1)}`, valid({ website: 'http://spam.example' }));
  assert.equal(r.status, 200);
  assert.deepEqual([row('L1').status, row('L1').phone ?? null], ['emailed', null]);
  await tick();
  assert.equal(onRequested.mock.callCount(), 0);
});

test('si el aviso (Telegram) falla, la persona lo ve todo bien y la solicitud queda guardada', async () => {
  seed([lead(1)]);
  onRequested.mock.mockImplementationOnce(async () => { throw new Error('telegram caído'); });
  const r = await quiet(async () => { const x = await post(`/c/${TOK(1)}`, valid()); await tick(); return x; });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /¡Recibido!/);
  assert.equal(row('L1').status, 'requested');
});

test('si no se puede guardar: error claro (500), el lead no cambia y no se avisa', async () => {
  seed([lead(1)]);
  db.failNext('new_business_leads', 'update', 'disco lleno');
  const r = await quiet(() => post(`/c/${TOK(1)}`, valid()));
  assert.equal(r.status, 500);
  assert.match(await r.text(), /No se ha podido guardar/);
  assert.equal(row('L1').status, 'emailed');
  await tick();
  assert.equal(onRequested.mock.callCount(), 0);
});

test('si la base de datos falla al buscar el lead en el envío: 503 amable', async () => {
  seed([lead(1)]);
  db.failNext('new_business_leads', 'select', 'caída');
  const r = await quiet(() => post(`/c/${TOK(1)}`, valid()));
  assert.equal(r.status, 503);
});

test('limitador de envíos: a partir del 16.º desde una IP → 429', async () => {
  seed([lead(1)]);
  const codes = [];
  for (let i = 0; i < 16; i++) codes.push((await post(`/c/${TOK(1)}`, valid({ phone: '1' }), { ip: '8.8.8.8' })).status);
  assert.equal(codes[0], 400);
  assert.equal(codes.at(-1), 429);
});

test('un envío enorme se rechaza (413) sin mostrar detalles internos', async () => {
  seed([lead(1)]);
  const r = await quiet(() => post(`/c/${TOK(1)}`, valid({ name: 'x'.repeat(20_000) })));
  assert.equal(r.status, 413);
  const text = await r.text();
  assert.doesNotMatch(text, /at .*node_modules|PayloadTooLarge|\.js:\d+/);
});
