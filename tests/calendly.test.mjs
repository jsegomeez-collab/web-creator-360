// Reservas de Calendly: quién agendó una llamada de verdad (no basta con abrir el enlace) y con qué hora.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { syncBookings, loadCalendlyConfig, isCalendlyConfigured, phoneOf, BOOKABLE } from '../src/services/calendly.js';

const OWNER = 'owner-1';
const NOW = new Date('2026-09-29T15:00:00.000Z');
const config = { token: 'tok-123' };
const noSleep = async () => {};
const TOK = (c) => `${c}`.repeat(24).slice(0, 24);          // 24 caracteres, como los tokens reales

const lead = (id, o = {}) => ({
  id, user_id: OWNER, source: 'ct_registry', name: `Empresa ${id}`, email: `${id.toLowerCase()}@gmail.com`, city: 'Hartford', sector: 'limpieza',
  status: 'emailed', link_token: TOK(id.toLowerCase().charCodeAt(0) % 10), booked_at: null, call_at: null, ...o,
});
const mkDb = (leads) => createMemoryDb({ new_business_leads: leads });
const row = (db, id) => db.rows('new_business_leads').find(l => l.id === id);

// Un Calendly falso: respeta status=active de los invitados y da 401 con otro token
function fakeCalendly(events, { pages = null, token = config.token } = {}) {
  const calls = [];
  const json = (status, body) => ({ ok: status < 400, status, statusText: 'x', json: async () => body });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), auth: opts.headers?.Authorization });
    if (opts.headers?.Authorization !== `Bearer ${token}`) return json(401, { title: 'Unauthenticated', message: 'The access token is invalid' });
    if (u.pathname === '/users/me') return json(200, { resource: { uri: 'https://api.calendly.com/users/U1' } });
    if (u.pathname === '/scheduled_events') {
      const page = Number(u.searchParams.get('page') || 0);
      if (pages) return json(200, { collection: pages[page], pagination: { next_page: page + 1 < pages.length ? `https://api.calendly.com/scheduled_events?page=${page + 1}` : null } });
      return json(200, { collection: events.map(e => ({ uri: `https://api.calendly.com/scheduled_events/${e.uuid}`, start_time: e.start_time, created_at: e.created_at, status: 'active' })), pagination: { next_page: null } });
    }
    const m = u.pathname.match(/^\/scheduled_events\/([^/]+)\/invitees$/);
    if (m) {
      const e = events.find(x => x.uuid === m[1]);
      const wanted = u.searchParams.get('status');
      return json(200, { collection: (e?.invitees || []).filter(i => !wanted || (i.status || 'active') === wanted), pagination: { next_page: null } });
    }
    return json(404, { message: 'no existe' });
  };
  return { fetchImpl, calls };
}

const event = (uuid, start, invitees, created = '2026-09-29T14:00:00.000Z') => ({ uuid, start_time: start, created_at: created, invitees });
const invitee = (o = {}) => ({ email: 'x@gmail.com', name: 'Ana', created_at: '2026-09-29T14:00:05.000Z', status: 'active', tracking: {}, questions_and_answers: [], ...o });
const sync = (db, cal, extra = {}) => syncBookings({ db, ownerId: OWNER, config, fetchImpl: cal.fetchImpl, sleep: noSleep, now: NOW, ...extra });

// ─── configuración ───────────────────────────────────────────────────────────
test('sin CALENDLY_API_TOKEN: error claro y isCalendlyConfigured = false', () => {
  assert.throws(() => loadCalendlyConfig({}), /CALENDLY_API_TOKEN/);
  assert.throws(() => loadCalendlyConfig({ CALENDLY_API_TOKEN: '   ' }), /CALENDLY_API_TOKEN/);
  assert.equal(isCalendlyConfigured({}), false);
  assert.deepEqual(loadCalendlyConfig({ CALENDLY_API_TOKEN: ' abc ' }), { token: 'abc' });
  assert.equal(isCalendlyConfigured({ CALENDLY_API_TOKEN: 'abc' }), true);
});

test('phoneOf: campo de recordatorio por SMS o pregunta de teléfono del formulario', () => {
  assert.equal(phoneOf({ text_reminder_number: '+1 203 555 0100' }), '+1 203 555 0100');
  assert.equal(phoneOf({ questions_and_answers: [{ question: 'Tu teléfono', answer: ' 860-555-0101 ' }] }), '860-555-0101');
  assert.equal(phoneOf({ questions_and_answers: [{ question: 'Phone number', answer: '860-555-0102' }] }), '860-555-0102');
  assert.equal(phoneOf({ questions_and_answers: [{ question: 'Comentarios', answer: 'hola' }] }), null);
  assert.equal(phoneOf({ questions_and_answers: [{ question: 'Teléfono', answer: '  ' }] }), null);
  assert.equal(phoneOf({}), null);
});

// ─── qué pide a Calendly ─────────────────────────────────────────────────────
test('pide a Calendly con el token, solo llamadas activas de los últimos 3 días en adelante y solo invitados activos', async () => {
  const cal = fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee()])]);
  await sync(mkDb([]), cal);
  assert.ok(cal.calls.every(c => c.auth === 'Bearer tok-123'));
  const list = cal.calls.find(c => c.path === '/scheduled_events');
  assert.deepEqual(list.params, { user: 'https://api.calendly.com/users/U1', min_start_time: '2026-09-26T15:00:00.000Z', status: 'active', sort: 'start_time:asc', count: '100' });
  const inv = cal.calls.find(c => c.path === '/scheduled_events/E1/invitees');
  assert.equal(inv.params.status, 'active');
});

// ─── emparejar la reserva con su lead ────────────────────────────────────────
test('por el token del enlace (utm_content): el lead pasa a booked con la hora de la llamada y avisa una vez', async () => {
  const db = mkDb([lead('A', { link_token: TOK(1) })]);
  const cal = fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'otro-correo@hotmail.com', tracking: { utm_content: TOK(1), utm_source: 'instantly' }, text_reminder_number: '+1 203 555 0100' })])]);
  const hook = mock.fn(async () => {});
  const r = await sync(db, cal, { onBooked: hook });
  assert.deepEqual(r, { events: 1, bookings: 1, booked: 1, rescheduled: 0, unmatched: 0 });
  const l = row(db, 'A');
  assert.deepEqual([l.status, l.call_at, l.booked_at], ['booked', '2026-09-30T18:00:00.000Z', '2026-09-29T14:00:05.000Z']);
  assert.equal(hook.mock.callCount(), 1);
  const [hookLead, booking] = hook.mock.calls[0].arguments;
  assert.deepEqual([hookLead.id, hookLead.status], ['A', 'booked']);
  assert.deepEqual([booking.email, booking.name, booking.phone, booking.startTime], ['otro-correo@hotmail.com', 'Ana', '+1 203 555 0100', '2026-09-30T18:00:00.000Z']);
});

test('sin token: por el email del invitado (sin distinguir mayúsculas)', async () => {
  const db = mkDb([lead('A', { email: 'dueno@gmail.com' })]);
  const cal = fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'Dueno@Gmail.COM' })])]);
  const r = await sync(db, cal);
  assert.equal(r.booked, 1);
  assert.equal(row(db, 'A').status, 'booked');
});

test('si el token y el email apuntan a leads distintos, manda el token', async () => {
  const db = mkDb([lead('A', { link_token: TOK(1), email: 'a@gmail.com' }), lead('B', { link_token: TOK(2), email: 'b@gmail.com' })]);
  const cal = fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'b@gmail.com', tracking: { utm_content: TOK(1) } })])]);
  await sync(db, cal);
  assert.deepEqual([row(db, 'A').status, row(db, 'B').status], ['booked', 'emailed']);
});

test('un token con formato raro se ignora (y cae al email)', async () => {
  const db = mkDb([lead('A', { email: 'a@gmail.com' })]);
  const cal = fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'a@gmail.com', tracking: { utm_content: "x' or 1=1 --" } })])]);
  assert.equal((await sync(db, cal)).booked, 1);
});

test('reservas de gente que no es un lead: se cuentan como "unmatched" y no se toca nada', async () => {
  const db = mkDb([lead('A')]);
  const cal = fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'amigo@gmail.com' })])]);
  const r = await sync(db, cal);
  assert.deepEqual([r.booked, r.unmatched], [0, 1]);
  assert.equal(row(db, 'A').status, 'emailed');
});

test('nunca empareja con leads de otro usuario', async () => {
  const db = mkDb([lead('A', { user_id: 'otro', link_token: TOK(1) })]);
  const cal = fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'a@gmail.com', tracking: { utm_content: TOK(1) } })])]);
  const r = await sync(db, cal);
  assert.deepEqual([r.booked, r.unmatched], [0, 1]);
  assert.equal(row(db, 'A').status, 'emailed');
});

// ─── estados ─────────────────────────────────────────────────────────────────
test('desde new, queued, emailed, engaged y replied → booked', async () => {
  for (const status of BOOKABLE) {
    const db = mkDb([lead('A', { status })]);
    const cal = fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'a@gmail.com' })])]);
    assert.equal((await sync(db, cal)).booked, 1, status);
    assert.equal(row(db, 'A').status, 'booked', status);
  }
});

test('quien ya está llamado/ganado/perdido o fuera (baja, rebote…) NO se toca', async () => {
  for (const status of ['called', 'won', 'lost', 'unsubscribed', 'bounced', 'invalid_email', 'rejected']) {
    const db = mkDb([lead('A', { status })]);
    const cal = fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'a@gmail.com' })])]);
    const hook = mock.fn(async () => {});
    const r = await sync(db, cal, { onBooked: hook });
    assert.deepEqual([r.booked, r.rescheduled, hook.mock.callCount()], [0, 0, 0], status);
    assert.deepEqual([row(db, 'A').status, row(db, 'A').call_at], [status, null], status);
  }
});

test('repetir la comprobación no vuelve a avisar ni a cambiar nada', async () => {
  const db = mkDb([lead('A')]);
  const cal = fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'a@gmail.com' })])]);
  const hook = mock.fn(async () => {});
  await sync(db, cal, { onBooked: hook });
  const before = { ...row(db, 'A') };
  const again = await sync(db, cal, { onBooked: hook });
  assert.deepEqual([again.booked, again.rescheduled, hook.mock.callCount()], [0, 0, 1]);
  assert.deepEqual(row(db, 'A'), before);
});

test('dos comprobaciones a la vez: el lead se reserva una sola vez y se avisa una sola vez', async () => {
  const db = mkDb([lead('A')]);
  const cal = fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'a@gmail.com' })])]);
  const hook = mock.fn(async () => {});
  const [r1, r2] = await Promise.all([sync(db, cal, { onBooked: hook }), sync(db, cal, { onBooked: hook })]);
  assert.equal(r1.booked + r2.booked, 1);
  assert.equal(hook.mock.callCount(), 1);
});

// ─── cambios de hora y varias reservas ───────────────────────────────────────
test('llamada cambiada de hora: actualiza call_at sin avisar de nuevo; misma hora → nada', async () => {
  const db = mkDb([lead('A', { status: 'booked', booked_at: '2026-09-29T10:00:00.000Z', call_at: '2026-09-30T18:00:00.000Z' })]);
  const hook = mock.fn(async () => {});
  const same = await sync(db, fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'a@gmail.com' })])]), { onBooked: hook });
  assert.deepEqual([same.booked, same.rescheduled], [0, 0]);
  const moved = await sync(db, fakeCalendly([event('E2', '2026-10-01T16:30:00.000Z', [invitee({ email: 'a@gmail.com' })])]), { onBooked: hook });
  assert.deepEqual([moved.booked, moved.rescheduled, hook.mock.callCount()], [0, 1, 0]);
  const l = row(db, 'A');
  assert.deepEqual([l.status, l.call_at, l.booked_at], ['booked', '2026-10-01T16:30:00.000Z', '2026-09-29T10:00:00.000Z']);
});

test('varias reservas del mismo lead: la próxima que aún no ha pasado; si todas pasaron, la última', async () => {
  const two = (a, b) => [event('E1', a, [invitee({ email: 'a@gmail.com' })]), event('E2', b, [invitee({ email: 'a@gmail.com' })])];
  const db1 = mkDb([lead('A')]);
  await sync(db1, fakeCalendly(two('2026-10-05T18:00:00.000Z', '2026-09-30T18:00:00.000Z')));
  assert.equal(row(db1, 'A').call_at, '2026-09-30T18:00:00.000Z');
  const db2 = mkDb([lead('A')]);
  await sync(db2, fakeCalendly(two('2026-09-28T18:00:00.000Z', '2026-09-27T18:00:00.000Z')));
  assert.equal(row(db2, 'A').call_at, '2026-09-28T18:00:00.000Z');
  const db3 = mkDb([lead('A')]);
  await sync(db3, fakeCalendly(two('2026-09-28T18:00:00.000Z', '2026-10-02T18:00:00.000Z')));
  assert.equal(row(db3, 'A').call_at, '2026-10-02T18:00:00.000Z');
});

test('invitados cancelados no cuentan (se piden con status=active)', async () => {
  const db = mkDb([lead('A')]);
  const cal = fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'a@gmail.com', status: 'canceled' })])]);
  const r = await sync(db, cal);
  assert.deepEqual([r.bookings, r.booked], [0, 0]);
  assert.equal(row(db, 'A').status, 'emailed');
});

// ─── robustez ────────────────────────────────────────────────────────────────
test('si el aviso (onBooked) falla, la reserva queda guardada y la comprobación sigue con los demás', async () => {
  const db = mkDb([lead('A', { link_token: TOK(1) }), lead('B', { link_token: TOK(2) })]);
  const cal = fakeCalendly([
    event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'a@gmail.com' })]),
    event('E2', '2026-09-30T19:00:00.000Z', [invitee({ email: 'b@gmail.com' })]),
  ]);
  const seen = [];
  const err = mock.method(console, 'error', () => {});
  try {
    const r = await sync(db, cal, { onBooked: async (l) => { seen.push(l.id); throw new Error('boom'); } });
    assert.equal(r.booked, 2);
    assert.deepEqual(seen.sort(), ['A', 'B']);
    assert.equal(err.mock.callCount(), 2);
  } finally { err.mock.restore(); }
  assert.deepEqual([row(db, 'A').status, row(db, 'B').status], ['booked', 'booked']);
});

test('token inválido → error legible con la pista; 429 se reintenta; caída de red da error claro', async () => {
  await assert.rejects(() => sync(mkDb([]), fakeCalendly([], { token: 'otro' })), /Calendly respondió 401: The access token is invalid.*CALENDLY_API_TOKEN/);

  let n = 0;
  const inner = fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'a@gmail.com' })])]);
  const flaky = { fetchImpl: async (...a) => (n++ === 0 ? { ok: false, status: 429, statusText: 'Too Many', json: async () => ({}) } : inner.fetchImpl(...a)) };
  const db = mkDb([lead('A')]);
  assert.equal((await sync(db, flaky)).booked, 1);

  const down = { fetchImpl: async () => { throw new Error('ECONNRESET'); } };
  await assert.rejects(() => sync(mkDb([]), down), /No se pudo conectar con Calendly: ECONNRESET/);
});

test('errores de la base de datos: se dicen y no se da por hecha la reserva', async () => {
  const cal = fakeCalendly([event('E1', '2026-09-30T18:00:00.000Z', [invitee({ email: 'a@gmail.com' })])]);
  const db1 = mkDb([lead('A')]);
  db1.failNext('new_business_leads', 'select', 'connection lost');
  await assert.rejects(() => sync(db1, cal), /buscar leads: connection lost/);
  const db2 = mkDb([lead('A')]);
  db2.failNext('new_business_leads', 'update', 'disk full');
  const hook = mock.fn(async () => {});
  await assert.rejects(() => sync(db2, cal, { onBooked: hook }), /guardar reserva: disk full/);
  assert.equal(hook.mock.callCount(), 0);
  assert.equal(row(db2, 'A').status, 'emailed');
});

test('paginación: sigue las páginas hasta un máximo de 2 (200 llamadas)', async () => {
  const mk = (i) => ({ uri: `https://api.calendly.com/scheduled_events/P${i}`, start_time: '2026-09-30T18:00:00.000Z', created_at: '2026-09-29T14:00:00.000Z' });
  const cal = fakeCalendly([], { pages: [[mk(1)], [mk(2)], [mk(3)]] });
  const r = await sync(mkDb([]), cal);
  assert.equal(r.events, 2);
  assert.equal(cal.calls.filter(c => c.path === '/scheduled_events').length, 2);
});

test('sin llamadas recientes: no toca la base de datos', async () => {
  const db = mkDb([lead('A')]);
  const r = await sync(db, fakeCalendly([]));
  assert.deepEqual(r, { events: 0, bookings: 0, booked: 0, rescheduled: 0, unmatched: 0 });
  assert.equal(db.log.length, 0);
});
