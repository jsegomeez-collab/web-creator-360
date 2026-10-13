// Limpieza de Instantly (el plan permite 1.000 leads): se borran, empezando por los más antiguos, solo los leads que ya no importan,
// solo hasta tener huecos libres, y nunca los que abrieron la web, respondieron, están en seguimiento o siguen en una secuencia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { cleanupInstantly, leadHeadroom, MIN_AGE_DAYS, KEEP_FREE } from '../src/services/instantlyCleanup.js';
import { loadInstantlyConfig } from '../src/services/instantly.js';

const OWNER = 'owner-1';
const NOW = new Date('2026-10-20T12:00:00Z');
const ago = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const config = loadInstantlyConfig({ INSTANTLY_API_KEY: 'k', INSTANTLY_CAMPAIGN_ID: '5a1d6d4e-8a0b-4e9c-9a53-2f4c8e7f1b10', CAMPAIGN_PUBLIC_URL: 'https://c.example.com' }, { dryRun: false });

const mk = (id, over = {}) => ({ id, user_id: OWNER, source: 'ct_registry', name: id, email: `${id}@gmail.com`, status: 'emailed', emailed_at: ago(10), engaged_at: null, replied_at: null, followup_at: null, instantly_lead_id: `inst-${id}`, updated_at: ago(10), ...over });

// Instantly simulado: el plan, los leads y los borrados. `state` = lo que Instantly sabe de cada lead (los que faltan "ya no existen").
function fakeInstantly({ count, limit = 1000, state }) {
  const deleted = [];
  const fetchImpl = async (url, opts = {}) => {
    const path = url.replace('https://api.instantly.ai/api/v2', '');
    if (path === '/workspace-billing/plan-details') return { ok: true, status: 200, json: async () => ({ subscriptions: { outreach: { total_lead_limit: limit, current_lead_count: count } } }) };
    if (path === '/leads/list') { const ids = JSON.parse(opts.body).ids; return { ok: true, status: 200, json: async () => ({ items: ids.filter(id => state[id]).map(id => ({ id, ...state[id] })) }) }; }
    if (opts.method === 'DELETE') { assert.equal(opts.headers['Content-Type'], undefined, 'DELETE va SIN content-type'); deleted.push(path.split('/').pop()); return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, deleted };
}
const finished = { status: 3, email_reply_count: 0 };
const idsOf = (db) => Object.fromEntries(db.rows('new_business_leads').map(l => [l.id, l.instantly_lead_id]));
const run = (f, db, extra = {}) => cleanupInstantly({ db, ownerId: OWNER, config, dryRun: false, fetchImpl: f.fetchImpl, now: NOW, ...extra });

test('leadHeadroom: lee del plan cuántos leads caben y cuántos hay', async () => {
  const f = fakeInstantly({ count: 541, state: {} });
  assert.deepEqual(await leadHeadroom(config, { fetchImpl: f.fetchImpl }), { limit: 1000, count: 541, free: 459 });
});

test('con huecos de sobra no borra nada ni toca la base de datos', async () => {
  const db = createMemoryDb({ new_business_leads: [mk('a', { emailed_at: ago(30) })] });
  const f = fakeInstantly({ count: 541, state: { 'inst-a': finished } });
  const r = await run(f, db);
  assert.match(r.skipped, /459 huecos libres/);
  assert.deepEqual([f.deleted, idsOf(db).a], [[], 'inst-a']);
});

test('borra primero los enviados sin abrir la web, los más antiguos primero, y nunca los protegidos', async () => {
  const leads = [
    mk('viejo30', { emailed_at: ago(30) }), mk('viejo20', { emailed_at: ago(20) }), mk('medio10', { emailed_at: ago(10) }),
    mk('reciente5', { emailed_at: ago(5) }),                                                                                       // menos de 8 días
    mk('abrioWeb', { emailed_at: ago(40), engaged_at: ago(35) }), mk('respondio', { emailed_at: ago(40), replied_at: ago(35) }),   // protegidos
    mk('seguimiento', { emailed_at: ago(40), followup_at: ago(3) }), mk('pidioLlamada', { status: 'requested', emailed_at: ago(40) }),
    mk('sinEnviar', { status: 'new', emailed_at: null, instantly_lead_id: null }), mk('enCola', { status: 'queued', emailed_at: null }),
    mk('secuenciaActiva', { emailed_at: ago(12) }),                                                                                // Instantly dice que sigue activo
    mk('respuestaSinSincronizar', { emailed_at: ago(25) }),                                                                        // Instantly tiene una respuesta que nosotros no
  ];
  const db = createMemoryDb({ new_business_leads: leads });
  const state = Object.fromEntries(leads.filter(l => l.instantly_lead_id).map(l => [l.instantly_lead_id, finished]));
  state['inst-secuenciaActiva'] = { status: 1, email_reply_count: 0 };
  state['inst-respuestaSinSincronizar'] = { status: 3, email_reply_count: 1 };
  const f = fakeInstantly({ count: 900, state });                          // 100 libres < 250 → hay que liberar 150
  const r = await run(f, db);
  assert.deepEqual(f.deleted, ['inst-viejo30', 'inst-viejo20', 'inst-medio10']);   // en orden de antigüedad
  assert.deepEqual([r.need, r.removed, r.tier1, r.tier2], [150, 3, 3, 0]);
  const ids = idsOf(db);
  assert.deepEqual(['viejo30', 'viejo20', 'medio10'].map(k => ids[k]), [null, null, null]);
  for (const k of ['reciente5', 'abrioWeb', 'respondio', 'seguimiento', 'pidioLlamada', 'enCola', 'secuenciaActiva', 'respuestaSinSincronizar']) assert.equal(ids[k], `inst-${k}`, `${k} debe conservarse`);
  assert.equal(db.rows('new_business_leads').find(l => l.id === 'viejo30').status, 'emailed');   // el historial se queda
});

test('solo borra lo necesario para dejar los huecos libres (no todo lo borrable)', async () => {
  const leads = [30, 25, 20, 15, 10].map(d => mk(`d${d}`, { emailed_at: ago(d) }));
  const db = createMemoryDb({ new_business_leads: leads });
  const state = Object.fromEntries(leads.map(l => [l.instantly_lead_id, finished]));
  const f = fakeInstantly({ count: 1000 - (KEEP_FREE - 2), state });         // faltan 2 huecos
  const r = await run(f, db);
  assert.deepEqual([r.need, f.deleted], [2, ['inst-d30', 'inst-d25']]);
});

test('los rebotados y bajas solo se borran si los enviados no bastan', async () => {
  const leads = [mk('enviado', { emailed_at: ago(12) }), mk('rebotado', { status: 'bounced', emailed_at: ago(12) }), mk('baja', { status: 'unsubscribed', emailed_at: ago(12) })];
  const db = createMemoryDb({ new_business_leads: leads });
  const state = Object.fromEntries(leads.map(l => [l.instantly_lead_id, finished]));
  const few = fakeInstantly({ count: 1000 - (KEEP_FREE - 1), state });        // hace falta 1: basta el enviado
  await run(few, db);
  assert.deepEqual(few.deleted, ['inst-enviado']);
  const many = fakeInstantly({ count: 1000 - (KEEP_FREE - 3), state });       // hacen falta 3 y del tier 1 no queda nadie → entran los del tier 2
  const r = await run(many, db);
  assert.deepEqual([r.tier1, r.tier2, many.deleted.sort()], [0, 2, ['inst-baja', 'inst-rebotado']]);
});

test('un ID que ya no existe en Instantly solo se olvida (no cuenta como hueco liberado) y sigue con el siguiente', async () => {
  const leads = [mk('fantasma', { emailed_at: ago(30) }), mk('real', { emailed_at: ago(20) })];
  const db = createMemoryDb({ new_business_leads: leads });
  const f = fakeInstantly({ count: 1000 - (KEEP_FREE - 1), state: { 'inst-real': finished } });
  const r = await run(f, db);
  assert.deepEqual([r.alreadyGone, r.removed, f.deleted], [1, 1, ['inst-real']]);
  assert.deepEqual([idsOf(db).fantasma, idsOf(db).real], [null, null]);
});

test('vista previa (dryRun) no borra ni escribe; force ignora los huecos libres', async () => {
  const leads = [mk('a', { emailed_at: ago(20) }), mk('b', { emailed_at: ago(15) })];
  const db = createMemoryDb({ new_business_leads: leads });
  const state = Object.fromEntries(leads.map(l => [l.instantly_lead_id, finished]));
  const f = fakeInstantly({ count: 541, state });
  const dry = await run(f, db, { force: true, max: 10, dryRun: true });
  assert.deepEqual([dry.dryRun, dry.removed, f.deleted, idsOf(db).a], [true, 2, [], 'inst-a']);
  const real = await run(f, db, { force: true, max: 10 });
  assert.deepEqual([real.removed, f.deleted], [2, ['inst-a', 'inst-b']]);
  assert.equal(MIN_AGE_DAYS, 8);
});
