// Seguimiento: los que abrieron la web y no han respondido pasan a una campaña aparte de Instantly (7 emails, uno al día).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { moveToFollowup, followupOverview, FOLLOWUP_DAYS } from '../src/services/followup.js';
import { loadInstantlyConfig } from '../src/services/instantly.js';
import { createLeadsRouter } from '../src/routes/leads.js';

const OWNER = 'owner-1';
const C1 = '5a1d6d4e-8a0b-4e9c-9a53-2f4c8e7f1b10';
const FU = '0ce4443c-8693-42df-be0c-cd6ecb88f9b7';
const env = { INSTANTLY_API_KEY: 'k', INSTANTLY_CAMPAIGN_ID: C1, INSTANTLY_CAMPAIGN_ID_FOLLOWUP: FU, CAMPAIGN_PUBLIC_URL: 'https://campana.example.com' };
const config = () => loadInstantlyConfig(env, { dryRun: false, campaign: 'followup' });
const NOW = new Date('2026-10-13T12:00:00Z');
const ago = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const mk = (id, over = {}) => ({
  id, user_id: OWNER, source: 'ct_registry', external_id: id, name: `Negocio ${id}`, email: `${id}@gmail.com`, status: 'engaged', demo_status: 'ready',
  demo_url: `https://${id}.vercel.app`, instantly_lead_id: `inst-${id}`, engaged_at: ago(3), replied_at: null, followup_at: null, link_token: `t-${id}`, ...over,
});

// Instantly simulado: estado de cada lead + movimientos
function fakeInstantly(state, { moveWorks = true, campaignStatus = 1 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const path = url.replace('https://api.instantly.ai/api/v2', '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method: opts.method || 'GET', path, body });
    let json = {};
    if (path === '/leads/list') json = { items: body.ids.filter(id => state[id]).map(id => ({ id, ...state[id] })) };
    else if (path === '/leads/move') {
      if (moveWorks) for (const id of body.ids) state[id] = { ...state[id], campaign: body.to_campaign_id, status: 1 };
      json = { id: 'job-1', status: 'pending' };
    } else if (path === '/leads/add') json = { created_leads: body.leads.map((l, index) => ({ id: `new-${l.email}`, index, email: l.email })) };
    else if (path === '/background-jobs/job-1') json = { id: 'job-1', status: 'success' };
    else if (path.startsWith('/campaigns/')) json = { status: campaignStatus };
    return { ok: true, status: 200, json: async () => json };
  };
  return { fetchImpl, calls };
}
const inst = (over = {}) => ({ campaign: C1, status: 3, email_reply_count: 0, ...over });
const stamped = (db) => db.rows('new_business_leads').filter(l => l.followup_at).map(l => l.id).sort();

test('mueve solo a los que abrieron la web y no han respondido; omite rebotes, bajas, respuestas y los que no están en Instantly', async () => {
  const db = createMemoryDb({ new_business_leads: [
    mk('A'), mk('B', { replied_at: ago(1) }), mk('C'), mk('D'), mk('E'), mk('F'),
    mk('G', { source: 'gmaps' }), mk('H', { demo_status: null }), mk('I'), mk('J', { status: 'emailed' }), mk('K', { followup_at: ago(2) }), mk('L', { instantly_lead_id: null }),
  ] });
  const state = {
    'inst-A': inst(), 'inst-C': inst({ email_reply_count: 1 }), 'inst-D': inst({ status: -1 }), 'inst-E': inst({ status: -2 }),
    'inst-I': inst({ campaign: FU, status: 1 }),   // ya está en la campaña de seguimiento
  };
  const { fetchImpl, calls } = fakeInstantly(state);
  const r = await moveToFollowup({ db, ownerId: OWNER, config: config(), dryRun: false, fetchImpl, sleep: async () => {}, now: NOW });
  // F (su ID ya no existe en Instantly) y L (se le quitó el ID al limpiar Instantly) se vuelven a añadir directamente al seguimiento
  assert.deepEqual([r.eligible, r.moved, r.readded, r.skipped], [7, 4, 2, { notInInstantly: 0, bounced: 1, unsubscribed: 1, replied: 1 }]);
  const adds = calls.filter(c => c.path === '/leads/add');
  assert.equal(adds.length, 1);
  assert.deepEqual([adds[0].body.campaign_id, adds[0].body.skip_if_in_workspace, adds[0].body.leads.map(l => l.email).sort()], [FU, true, ['F@gmail.com', 'L@gmail.com']]);
  assert.deepEqual(['F', 'L'].map(id => db.rows('new_business_leads').find(l => l.id === id).instantly_lead_id), ['new-F@gmail.com', 'new-L@gmail.com']);
  const moves = calls.filter(c => c.path === '/leads/move');
  assert.equal(moves.length, 1);
  assert.deepEqual([moves[0].body.ids, moves[0].body.campaign, moves[0].body.to_campaign_id], [['inst-A'], C1, FU]);
  assert.deepEqual(stamped(db), ['A', 'F', 'I', 'K', 'L']);          // K ya estaba de antes
  assert.equal(db.rows('new_business_leads').find(l => l.id === 'A').followup_at, NOW.toISOString());
  assert.equal(state['inst-A'].campaign, FU);
  assert.equal(r.campaign, 'ok');                                     // la campaña estaba activa: no hace falta reanudarla
});

test('si Instantly no confirma el movimiento, el lead no se marca y se reintenta en el siguiente ciclo', async () => {
  const db = createMemoryDb({ new_business_leads: [mk('A')] });
  const { fetchImpl } = fakeInstantly({ 'inst-A': inst() }, { moveWorks: false });
  const r = await moveToFollowup({ db, ownerId: OWNER, config: config(), dryRun: false, fetchImpl, sleep: async () => {}, now: NOW });
  assert.deepEqual([r.moved, stamped(db)], [0, []]);
});

test('vista previa (dry-run): cuenta pero no mueve ni escribe nada', async () => {
  const db = createMemoryDb({ new_business_leads: [mk('A'), mk('C')] });
  const { fetchImpl, calls } = fakeInstantly({ 'inst-A': inst(), 'inst-C': inst({ email_reply_count: 2 }) });
  const r = await moveToFollowup({ db, ownerId: OWNER, config: config(), dryRun: true, fetchImpl, now: NOW });
  assert.deepEqual([r.dryRun, r.eligible, r.moved, r.skipped.replied], [true, 2, 1, 1]);
  assert.equal(calls.filter(c => c.path === '/leads/move').length, 0);
  assert.deepEqual(stamped(db), []);
});

test('si la campaña de seguimiento estaba "completada", se reanuda al meter leads nuevos', async () => {
  const db = createMemoryDb({ new_business_leads: [mk('A')] });
  const { fetchImpl, calls } = fakeInstantly({ 'inst-A': inst() }, { campaignStatus: 3 });
  const r = await moveToFollowup({ db, ownerId: OWNER, config: config(), dryRun: false, fetchImpl, sleep: async () => {}, now: NOW });
  assert.equal(r.campaign, 'resumed');
  assert.ok(calls.some(c => c.method === 'POST' && c.path === `/campaigns/${FU}/activate`));
});

test('con verifyCopy: si el texto del seguimiento en Instantly no encaja con lo que enviamos, no se mueve a nadie', async () => {
  const db = createMemoryDb({ new_business_leads: [mk('A')] });
  const state = { 'inst-A': inst() };
  const base = fakeInstantly(state);
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    if (/\/campaigns\/[^/]+$/.test(url) && !opts.method) {                                            // GET de la campaña de seguimiento: con variables viejas y sin asunto
      calls.push('GET campaña');
      return { ok: true, status: 200, json: async () => ({ sequences: [{ steps: [{ delay: 1, variants: [{ subject: '', body: '<div>Hola {{nombre}} {{web}}</div>' }] }] }] }) };
    }
    return base.fetchImpl(url, opts);
  };
  await assert.rejects(() => moveToFollowup({ db, ownerId: OWNER, config: config(), dryRun: false, verifyCopy: true, fetchImpl, sleep: async () => {}, now: NOW }), /su texto no coincide con lo que enviamos/);
  assert.equal(base.calls.filter(c => c.path === '/leads/move').length, 0);
  assert.deepEqual(stamped(db), []);
});

test('sin nadie que mover no llama a Instantly', async () => {
  const db = createMemoryDb({ new_business_leads: [mk('B', { replied_at: ago(1) })] });
  const { fetchImpl, calls } = fakeInstantly({});
  const r = await moveToFollowup({ db, ownerId: OWNER, config: config(), dryRun: false, fetchImpl, now: NOW });
  assert.deepEqual([r.eligible, r.moved, calls.length], [0, 0, 0]);
});

test('resumen: esperando, en secuencia (día N de 7), han respondido y enfriados', async () => {
  const db = createMemoryDb({ new_business_leads: [
    mk('W'),                                                                  // esperando a entrar
    mk('A1', { followup_at: ago(0.2) }), mk('A2', { followup_at: ago(3.5) }), // día 1 y día 4
    mk('R', { followup_at: ago(2), replied_at: ago(1), status: 'replied' }),  // respondió dentro del seguimiento
    mk('C', { followup_at: ago(10) }),                                        // pasaron los 7 días sin responder
  ] });
  const o = await followupOverview({ db, ownerId: OWNER, now: NOW });
  assert.equal(FOLLOWUP_DAYS, 7);
  assert.deepEqual(o.counts, { waiting: 1, active: 2, replied: 1, cold: 1 });
  const by = Object.fromEntries(o.leads.map(l => [l.id, [l.state, l.day]]));
  assert.deepEqual(by, { A1: ['active', 1], A2: ['active', 4], R: ['replied', 3], C: ['cold', 7] });
});

test('ruta GET /followup: resumen, y avisa si falta INSTANTLY_CAMPAIGN_ID_FOLLOWUP', async () => {
  const db = createMemoryDb({ new_business_leads: [mk('W'), mk('A1', { followup_at: ago(1) })] });
  const app = express(); app.use(express.json());
  app.use('/api/leads', createLeadsRouter({ db, ownerId: OWNER, verifyCopy: false }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const get = () => fetch(`http://127.0.0.1:${server.address().port}/api/leads/followup`).then(r => r.json());
  try {
    delete process.env.INSTANTLY_CAMPAIGN_ID_FOLLOWUP;
    const off = await get();
    assert.deepEqual([off.configured, off.counts.waiting, off.counts.active], [false, 1, 1]);
    process.env.INSTANTLY_CAMPAIGN_ID_FOLLOWUP = FU;
    const on = await get();
    assert.deepEqual([on.configured, on.campaign], [true, '0ce4443c']);
  } finally { server.closeAllConnections?.(); server.close(); delete process.env.INSTANTLY_CAMPAIGN_ID_FOLLOWUP; }
});
