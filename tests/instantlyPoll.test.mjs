// Qué pasó en Instantly con los leads ya enviados (enviado, rebotado, de baja, respondió), preguntando a su API en vez de
// esperar un webhook (que necesita su plan de pago). Reemplaza a src/routes/instantlyWebhook.js.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { pollInstantlyEvents, effectOf, POLLABLE_STATUSES } from '../src/services/instantlyPoll.js';

const OWNER = 'owner-1';
const CONFIG = { apiKey: 'k-123', campaignId: 'c-1' };
const NOW = new Date('2026-09-29T15:00:00.000Z');
const lead = (id, o = {}) => ({ id, user_id: OWNER, email: `${id.toLowerCase()}@gmail.com`, name: `Lead ${id}`, status: 'queued', instantly_lead_id: `inst-${id}`, replied_at: null, ...o });

// Instantly falso: POST /leads/list devuelve `items`, o falla si se le pide
function fakeInstantly(handler) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body, auth: opts.headers?.Authorization });
    const r = await handler(body);
    return { ok: r.status ? r.status < 400 : true, status: r.status ?? 200, statusText: 'x', json: async () => r.json ?? { items: [] } };
  };
  return { fetchImpl, calls };
}
const items = (arr) => ({ items: arr });
const noSleep = async () => {};

// ─── effectOf: la lógica pura ────────────────────────────────────────────────
test('effectOf: el primer contacto de Instantly pasa "queued" a "emailed" con su fecha', () => {
  const { patch } = effectOf(lead('A'), { status: 1, timestamp_last_contact: '2026-09-29T10:00:00.000Z' }, NOW.toISOString());
  assert.deepEqual(patch, { status: 'emailed', emailed_at: '2026-09-29T10:00:00.000Z' });
});

test('effectOf: sin timestamp_last_contact todavía, "queued" no cambia', () => {
  assert.deepEqual(effectOf(lead('A'), { status: 1 }, NOW.toISOString()).patch, {});
});

test('effectOf: rebote (-1) y baja (-2) solo mueven el estado si aún no había interactuado', () => {
  const before = effectOf(lead('A', { status: 'emailed' }), { status: -1 }, NOW.toISOString());
  assert.deepEqual([before.patch, before.suppressAs], [{ status: 'bounced' }, 'bounced']);
  const after = effectOf(lead('A', { status: 'engaged' }), { status: -2 }, NOW.toISOString());
  assert.deepEqual([after.patch, after.suppressAs], [{}, 'unsubscribed']);   // se suprime igual, pero no retrocede el estado
});

test('effectOf: respuesta nueva (email_reply_count > 0 y sin replied_at) marca la fecha y, si aún no interactuó, pasa a "replied"', () => {
  const beforeEngaging = effectOf(lead('A', { status: 'emailed' }), { status: 1, email_reply_count: 1, timestamp_last_reply: '2026-09-29T11:00:00.000Z' }, NOW.toISOString());
  assert.deepEqual([beforeEngaging.patch, beforeEngaging.repliedNow], [{ status: 'replied', replied_at: '2026-09-29T11:00:00.000Z' }, true]);
  const afterEngaging = effectOf(lead('A', { status: 'requested' }), { status: 1, email_reply_count: 1, timestamp_last_reply: '2026-09-29T11:00:00.000Z' }, NOW.toISOString());
  assert.deepEqual([afterEngaging.patch, afterEngaging.repliedNow], [{ replied_at: '2026-09-29T11:00:00.000Z' }, true]);   // el teléfono/estado no se tocan
});

test('effectOf: sin fecha de respuesta se usa "ahora"; un lead que ya tenía replied_at no vuelve a contarse', () => {
  const noDate = effectOf(lead('A', { status: 'emailed' }), { status: 1, email_reply_count: 2 }, NOW.toISOString());
  assert.deepEqual(noDate.patch.replied_at, NOW.toISOString());
  const already = effectOf(lead('A', { status: 'emailed', replied_at: '2026-09-01T00:00:00.000Z' }), { status: 1, email_reply_count: 3 }, NOW.toISOString());
  assert.deepEqual([already.patch, already.repliedNow], [{}, false]);
});

test('effectOf: un lead ya activo (status:1) sin más novedades no cambia nada', () => {
  const r = effectOf(lead('A', { status: 'emailed' }), { status: 1, email_reply_count: 0, timestamp_last_contact: '2026-09-20T00:00:00.000Z' }, NOW.toISOString());
  assert.deepEqual(r, { patch: {}, suppressAs: null, repliedNow: false });
});

// ─── pollInstantlyEvents: qué leads se preguntan y qué guarda ───────────────
test('solo pregunta por los leads con instantly_lead_id y un estado que aún puede cambiar', async () => {
  assert.deepEqual(POLLABLE_STATUSES, ['queued', 'emailed', 'engaged', 'requested']);
  const db = createMemoryDb({ new_business_leads: [
    lead('A', { status: 'queued' }),
    lead('B', { status: 'new', instantly_lead_id: null }),          // aún no enviado a Instantly
    lead('C', { status: 'called' }),                                 // ya llamado: no hace falta seguir preguntando
    lead('D', { status: 'unsubscribed' }),
  ] });
  const { fetchImpl, calls } = fakeInstantly(() => ({ json: items([]) }));
  const r = await pollInstantlyEvents({ db, ownerId: OWNER, config: CONFIG, fetchImpl, sleep: noSleep, now: NOW });
  assert.deepEqual(r, { checked: 1, updated: 0, suppressed: 0, replied: 0 });
  assert.deepEqual(calls[0].body.ids, ['inst-A']);
  assert.equal(calls[0].auth, 'Bearer k-123');
});

test('nunca pregunta por leads de otro usuario', async () => {
  const db = createMemoryDb({ new_business_leads: [lead('A', { user_id: 'otro' })] });
  const { fetchImpl, calls } = fakeInstantly(() => ({ json: items([]) }));
  const r = await pollInstantlyEvents({ db, ownerId: OWNER, config: CONFIG, fetchImpl, sleep: noSleep, now: NOW });
  assert.deepEqual(r, { checked: 0, updated: 0, suppressed: 0, replied: 0 });
  assert.equal(calls.length, 0);
});

test('guarda enviado, rebote (con supresión) y baja (con supresión); cuenta bien cada cosa', async () => {
  const db = createMemoryDb({ new_business_leads: [
    lead('A', { status: 'queued' }),
    lead('B', { status: 'queued' }),
    lead('C', { status: 'emailed' }),
  ] });
  const { fetchImpl } = fakeInstantly(() => ({ json: items([
    { id: 'inst-A', status: 1, email_reply_count: 0, timestamp_last_contact: '2026-09-29T09:00:00.000Z' },
    { id: 'inst-B', status: -1, email_reply_count: 0 },
    { id: 'inst-C', status: -2, email_reply_count: 0 },
  ]) }));
  const r = await pollInstantlyEvents({ db, ownerId: OWNER, config: CONFIG, fetchImpl, sleep: noSleep, now: NOW });
  assert.deepEqual(r, { checked: 3, updated: 3, suppressed: 2, replied: 0 });
  const byId = Object.fromEntries(db.rows('new_business_leads').map(l => [l.id, l]));
  assert.deepEqual([byId.A.status, byId.A.emailed_at], ['emailed', '2026-09-29T09:00:00.000Z']);
  assert.equal(byId.B.status, 'bounced');
  assert.equal(byId.C.status, 'unsubscribed');   // "emailed" es previo a interactuar: la baja sí lo mueve
  assert.deepEqual(db.rows('email_suppressions').map(s => s.reason).sort(), ['bounced', 'unsubscribed']);
});

test('avisa (onReply) solo la primera vez que alguien responde', async () => {
  const db = createMemoryDb({ new_business_leads: [lead('A', { status: 'emailed' })] });
  const { fetchImpl } = fakeInstantly(() => ({ json: items([{ id: 'inst-A', status: 1, email_reply_count: 1, timestamp_last_reply: '2026-09-29T11:00:00.000Z' }]) }));
  const onReply = mock.fn(async () => {});
  const r = await pollInstantlyEvents({ db, ownerId: OWNER, config: CONFIG, fetchImpl, sleep: noSleep, now: NOW, onReply: (...a) => onReply(...a) });
  assert.deepEqual(r, { checked: 1, updated: 1, suppressed: 0, replied: 1 });
  await new Promise(res => setTimeout(res, 25));
  assert.equal(onReply.mock.callCount(), 1);
  assert.equal(onReply.mock.calls[0].arguments[0].status, 'replied');

  // repetir: ya no está en POLLABLE_STATUSES (pasó a "replied") → ni se pregunta ni se vuelve a avisar
  const again = await pollInstantlyEvents({ db, ownerId: OWNER, config: CONFIG, fetchImpl, sleep: noSleep, now: NOW, onReply: (...a) => onReply(...a) });
  assert.deepEqual(again, { checked: 0, updated: 0, suppressed: 0, replied: 0 });
  await new Promise(res => setTimeout(res, 25));
  assert.equal(onReply.mock.callCount(), 1);
});

test('leads sin novedad en Instantly no generan ninguna escritura', async () => {
  const db = createMemoryDb({ new_business_leads: [lead('A', { status: 'emailed' })] });
  const { fetchImpl } = fakeInstantly(() => ({ json: items([{ id: 'inst-A', status: 1, email_reply_count: 0 }]) }));
  const r = await pollInstantlyEvents({ db, ownerId: OWNER, config: CONFIG, fetchImpl, sleep: noSleep, now: NOW });
  assert.deepEqual(r, { checked: 1, updated: 0, suppressed: 0, replied: 0 });
  assert.equal(db.log.filter(l => l.op === 'update').length, 0);
});

test('un lead que Instantly ya no conoce (borrado a mano) se ignora sin romper el resto', async () => {
  const db = createMemoryDb({ new_business_leads: [lead('A', { status: 'queued' }), lead('B', { status: 'queued' })] });
  const { fetchImpl } = fakeInstantly(() => ({ json: items([{ id: 'inst-B', status: 1, email_reply_count: 0, timestamp_last_contact: NOW.toISOString() }]) }));   // inst-A no viene
  const r = await pollInstantlyEvents({ db, ownerId: OWNER, config: CONFIG, fetchImpl, sleep: noSleep, now: NOW });
  assert.deepEqual(r, { checked: 2, updated: 1, suppressed: 0, replied: 0 });
  assert.equal(db.rows('new_business_leads').find(l => l.id === 'A').status, 'queued');
});

test('más de 100 leads se piden en varias tandas de 100', async () => {
  const leads = Array.from({ length: 205 }, (_, i) => lead(`L${i}`, { status: 'queued' }));
  const db = createMemoryDb({ new_business_leads: leads });
  const { fetchImpl, calls } = fakeInstantly(() => ({ json: items([]) }));
  const r = await pollInstantlyEvents({ db, ownerId: OWNER, config: CONFIG, fetchImpl, sleep: noSleep, now: NOW });
  assert.equal(r.checked, 205);
  assert.deepEqual(calls.map(c => c.body.ids.length), [100, 100, 5]);
  assert.equal(calls.every(c => c.body.limit === c.body.ids.length), true);
});

// ─── robustez ────────────────────────────────────────────────────────────────
test('token incorrecto (401 de Instantly) → error legible con la pista', async () => {
  const db = createMemoryDb({ new_business_leads: [lead('A', { status: 'queued' })] });
  const { fetchImpl } = fakeInstantly(() => ({ status: 401, json: { error: 'Invalid API key' } }));
  await assert.rejects(() => pollInstantlyEvents({ db, ownerId: OWNER, config: CONFIG, fetchImpl, sleep: noSleep, now: NOW }), /Instantly respondió 401: Invalid API key.*INSTANTLY_API_KEY/);
});

test('un fallo de la base de datos al leer o al guardar se propaga (no se da nada por hecho)', async () => {
  const dbReadFail = createMemoryDb({ new_business_leads: [lead('A', { status: 'queued' })] });
  dbReadFail.failNext('new_business_leads', 'select', 'timeout');
  const cal1 = fakeInstantly(() => ({ json: items([]) }));
  await assert.rejects(() => pollInstantlyEvents({ db: dbReadFail, ownerId: OWNER, config: CONFIG, fetchImpl: cal1.fetchImpl, sleep: noSleep, now: NOW }), /cargar leads: timeout/);

  const dbWriteFail = createMemoryDb({ new_business_leads: [lead('A', { status: 'queued' })] });
  dbWriteFail.failNext('new_business_leads', 'update', 'disco lleno');
  const cal2 = fakeInstantly(() => ({ json: items([{ id: 'inst-A', status: 1, email_reply_count: 0, timestamp_last_contact: NOW.toISOString() }]) }));
  await assert.rejects(() => pollInstantlyEvents({ db: dbWriteFail, ownerId: OWNER, config: CONFIG, fetchImpl: cal2.fetchImpl, sleep: noSleep, now: NOW }), /guardar lead: disco lleno/);
});

test('dos comprobaciones a la vez sobre el mismo lead: solo una lo actualiza y avisa', async () => {
  // Puede pasar de verdad: el botón "Comprobar ahora" del dashboard local y el cron del servidor de la campaña son dos
  // procesos distintos que pueden preguntar por Instantly casi al mismo tiempo.
  const db = createMemoryDb({ new_business_leads: [lead('A', { status: 'emailed' })] });
  const { fetchImpl } = fakeInstantly(() => ({ json: items([{ id: 'inst-A', status: 1, email_reply_count: 1, timestamp_last_reply: '2026-09-29T11:00:00.000Z' }]) }));
  const onReply = mock.fn(async () => {});
  const [r1, r2] = await Promise.all([
    pollInstantlyEvents({ db, ownerId: OWNER, config: CONFIG, fetchImpl, sleep: noSleep, now: NOW, onReply: (...a) => onReply(...a) }),
    pollInstantlyEvents({ db, ownerId: OWNER, config: CONFIG, fetchImpl, sleep: noSleep, now: NOW, onReply: (...a) => onReply(...a) }),
  ]);
  assert.deepEqual([r1.updated + r2.updated, r1.replied + r2.replied], [1, 1]);
  await new Promise(res => setTimeout(res, 25));
  assert.equal(onReply.mock.callCount(), 1);
  assert.equal(db.rows('new_business_leads')[0].status, 'replied');
});

test('sin leads que revisar, no llama a Instantly', async () => {
  const db = createMemoryDb({ new_business_leads: [] });
  const { fetchImpl, calls } = fakeInstantly(() => ({ json: items([]) }));
  const r = await pollInstantlyEvents({ db, ownerId: OWNER, config: CONFIG, fetchImpl, sleep: noSleep, now: NOW });
  assert.deepEqual(r, { checked: 0, updated: 0, suppressed: 0, replied: 0 });
  assert.equal(calls.length, 0);
});
