// Webs de demo de las LLCs nuevas: se crean (motor de plantillas + Vercel) ANTES de enviar el lead a Instantly, el
// email enlaza a ellas con {{web}}, y abrirlas marca al lead como "engaged". Claude y Vercel están simulados.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { createLeadDemo, generateDemos, decorateDemo, demoSlug, readyDemoCount } from '../src/services/leadDemos.js';
import { loadInstantlyConfig, pushLeads } from '../src/services/instantly.js';
import { createCampaignApp } from '../src/campaignApp.js';
import { createLeadsRouter } from '../src/routes/leads.js';

const OWNER = 'owner-1';
const PUBLIC = 'https://campana.example.com';
const mkLead = (i, over = {}) => ({
  id: `L${i}`, user_id: OWNER, source: 'ct_registry', external_id: `E${i}`, name: `SOL ${i} TAX LLC`, email: `l${i}@gmail.com`,
  city: 'Hartford', sector: 'taxes', naics_code: 'Tax Preparation Services (541213)', registered_at: `2026-09-${String(28 - i).padStart(2, '0')}`,
  status: 'new', demo_status: null, link_token: `TOKEN${String(i).padStart(19, '0')}`, ...over,
});
const row = (db, id) => db.rows('new_business_leads').find(l => l.id === id);
const PAGE = '<!DOCTYPE html><html><head><title>Sol</title></head><body><h1>Sol Tax</h1></body></html>';

// Motor y Vercel simulados: guardan con qué se les llamó
function fakes({ failBuild = false, failDeploy = false } = {}) {
  const built = [], deployed = [];
  const build = async ({ business, template }) => {
    built.push({ business, template });
    if (failBuild) throw new Error('La web aún menciona el negocio de ejemplo (Carmen): no se publica');
    return { html: PAGE, template, usage: { input_tokens: 14000, output_tokens: 9000 } };
  };
  const deploy = async (slug, html) => {
    deployed.push({ slug, html });
    if (failDeploy) throw new Error('Token de Vercel inválido');
    return `https://${slug}.vercel.app`;
  };
  return { build, deploy, built, deployed };
}

test('demoSlug: nombre de la marca + 4 caracteres del token, en minúsculas y con guiones', () => {
  assert.equal(demoSlug(mkLead(1)), 'sol-1-tax-toke');
  assert.equal(demoSlug({ name: 'Doña Rosa & Hijos, LLC', link_token: 'Ab_9-xyz' }), 'dona-rosa-and-hijos-ab9x');
});

test('decorateDemo: no se indexa, lleva la barra "La quiero" hacia su página y el aviso de visita', () => {
  const html = decorateDemo(PAGE, { brand: 'Sol <Tax>', requestUrl: `${PUBLIC}/c/TOK`, beaconUrl: `${PUBLIC}/v/TOK` });
  assert.match(html, /<head>\n<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /Web de muestra para Sol &lt;Tax&gt; · fotos y datos de ejemplo/);
  assert.match(html, /<a href="https:\/\/campana\.example\.com\/c\/TOK">La quiero<\/a>/);
  assert.match(html, /sendBeacon\(u\)/);
  assert.match(html, /"https:\/\/campana\.example\.com\/v\/TOK"/);
  assert.match(html, /<\/script>\n<\/body><\/html>$/, 'la barra va justo antes de </body>');
});

test('createLeadDemo: escribe la web con la plantilla de su sector, la publica y la guarda en el lead', async () => {
  const db = createMemoryDb({ new_business_leads: [mkLead(1)] });
  const f = fakes();
  const r = await createLeadDemo({ db, ownerId: OWNER, lead: mkLead(1), publicUrl: PUBLIC, build: f.build, deploy: f.deploy });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://sol-1-tax-toke.vercel.app');
  assert.equal(f.built[0].template, 'general', 'taxes → plantilla general');
  assert.deepEqual(f.built[0].business, { name: 'SOL 1 TAX LLC', city: 'Hartford', state: 'CT', email: 'l1@gmail.com', sector: 'taxes', naics_code: 'Tax Preparation Services (541213)', activity: 'Tax Preparation Services (541213)', registered_at: '2026-09-27' });
  assert.match(f.deployed[0].html, /La quiero/, 'lo publicado es la web ya decorada');
  const l = row(db, 'L1');
  assert.deepEqual([l.demo_status, l.demo_url, l.demo_template, l.demo_error], ['ready', r.url, 'general', null]);
  const site = db.rows('generated_sites')[0];
  assert.deepEqual([site.slug, site.status, site.preview_url, l.site_id], ['sol-1-tax-toke', 'demo', r.url, site.id]);
  assert.equal(l.status, 'new', 'crear la web no cambia el estado del embudo');
});

test('createLeadDemo: si falla (motor o Vercel) el lead queda "failed" con el motivo, y no se publica nada roto', async () => {
  for (const opts of [{ failBuild: true }, { failDeploy: true }]) {
    const db = createMemoryDb({ new_business_leads: [mkLead(1)] });
    const f = fakes(opts);
    const r = await createLeadDemo({ db, ownerId: OWNER, lead: mkLead(1), publicUrl: PUBLIC, build: f.build, deploy: f.deploy });
    assert.equal(r.ok, false);
    const l = row(db, 'L1');
    assert.equal(l.demo_status, 'failed');
    assert.match(l.demo_error, opts.failBuild ? /negocio de ejemplo/ : /Vercel/);
    assert.equal(l.demo_url, undefined);
    assert.equal(db.rows('generated_sites').length, 0);
  }
});

test('createLeadDemo: nunca hace dos veces la misma web (ya lista, o creándose ahora mismo)', async () => {
  const f = fakes();
  const ready = createMemoryDb({ new_business_leads: [mkLead(1, { demo_status: 'ready', demo_url: 'https://x.vercel.app' })] });
  assert.equal((await createLeadDemo({ db: ready, ownerId: OWNER, lead: row(ready, 'L1'), publicUrl: PUBLIC, ...f })).skipped, true);
  const busy = createMemoryDb({ new_business_leads: [mkLead(1, { demo_status: 'generating', updated_at: new Date().toISOString() })] });
  assert.equal((await createLeadDemo({ db: busy, ownerId: OWNER, lead: row(busy, 'L1'), publicUrl: PUBLIC, force: true, ...f })).skipped, true);
  assert.equal(f.built.length, 0);
  // Otra tarea la reservó entre medias: el lead que tenemos en memoria está desfasado
  const race = createMemoryDb({ new_business_leads: [mkLead(1, { demo_status: 'generating' })] });
  assert.equal((await createLeadDemo({ db: race, ownerId: OWNER, lead: mkLead(1), publicUrl: PUBLIC, ...f })).skipped, true);
  assert.equal(f.built.length, 0);
});

test('createLeadDemo: "force" rehace una web lista o fallida; una atascada más de 20 min se puede rehacer', async () => {
  const f = fakes();
  const db = createMemoryDb({ new_business_leads: [mkLead(1, { demo_status: 'failed', demo_error: 'x' }), mkLead(2, { demo_status: 'generating', updated_at: '2026-09-30T08:00:00.000Z' })] });
  assert.equal((await createLeadDemo({ db, ownerId: OWNER, lead: row(db, 'L1'), publicUrl: PUBLIC, force: true, ...f })).ok, true);
  assert.equal((await createLeadDemo({ db, ownerId: OWNER, lead: row(db, 'L2'), publicUrl: PUBLIC, ...f, now: () => new Date('2026-09-30T09:00:00Z') })).ok, true);
  assert.deepEqual([row(db, 'L1').demo_status, row(db, 'L2').demo_status], ['ready', 'ready']);
});

test('generateDemos: solo leads "new" sin web, los más recientes primero, y cuenta creadas y fallidas', async () => {
  const db = createMemoryDb({ new_business_leads: [
    mkLead(1), mkLead(2), mkLead(3, { demo_status: 'ready' }), mkLead(4, { status: 'queued' }), mkLead(5), mkLead(6, { user_id: 'otro' }),
  ] });
  const f = fakes();
  const r = await generateDemos({ db, ownerId: OWNER, publicUrl: PUBLIC, limit: 2, build: f.build, deploy: f.deploy });
  assert.deepEqual([r.created, r.failed], [2, 0]);
  assert.deepEqual(r.results.map(x => x.id), ['L1', 'L2']);
  assert.equal(await readyDemoCount(db, OWNER), 3);
  const again = await generateDemos({ db, ownerId: OWNER, publicUrl: PUBLIC, limit: 5, build: f.build, deploy: f.deploy });
  assert.deepEqual(again.results.map(x => x.id), ['L5']);
});

test('pushLeads con LEAD_DEMOS=true: solo envía leads con su web lista, y {{web}} lleva su dirección', async () => {
  const env = { INSTANTLY_API_KEY: 'k', INSTANTLY_CAMPAIGN_ID: '5a1d6d4e-8a0b-4e9c-9a53-2f4c8e7f1b10', CAMPAIGN_PUBLIC_URL: PUBLIC, LEAD_DEMOS: 'true' };
  const config = loadInstantlyConfig(env, { dryRun: false });
  assert.equal(config.demos, true);
  assert.equal(loadInstantlyConfig({ ...env, LEAD_DEMOS: 'false' }, { dryRun: false }).demos, false);
  const db = createMemoryDb({ new_business_leads: [mkLead(1, { demo_status: 'ready', demo_url: 'https://sol-1.vercel.app' }), mkLead(2), mkLead(3, { demo_status: 'failed' })] });
  const sent = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(...body.leads);
    return { ok: true, status: 200, json: async () => ({ created_leads: body.leads.map((l, index) => ({ id: `i-${index}`, index })) }) };
  };
  const r = await pushLeads({ db, ownerId: OWNER, config, limit: 10, dryRun: false, fetchImpl, sleep: async () => {} });
  assert.equal(r.pushed, 1);
  assert.deepEqual(sent.map(l => l.email), ['l1@gmail.com']);
  assert.equal(sent[0].custom_variables.web, 'https://sol-1.vercel.app/?lang=es');
  assert.deepEqual([row(db, 'L2').status, row(db, 'L3').status], ['new', 'new'], 'sin web, esperan');
});

// ─── servidor público de la campaña: la visita a la demo y el botón "Ver mi web" ─────────────────────────────────────
let server, base, cdb;
before(async () => {
  cdb = createMemoryDb({ new_business_leads: [] });
  server = await new Promise(r => { const s = createCampaignApp({ db: cdb, ownerId: OWNER }).listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });
const UA = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' };

test('/v/:token (aviso desde la demo): abrir su web marca "engaged"; bots, tokens raros y estados avanzados no cuentan', async () => {
  cdb.tables.new_business_leads = [mkLead(1, { status: 'emailed' }), mkLead(2, { status: 'requested' }), mkLead(3, { status: 'emailed' })];
  const hit = (tok, headers = UA) => fetch(`${base}/v/${tok}`, { method: 'POST', headers });
  assert.equal((await hit(mkLead(1).link_token)).status, 204);
  assert.equal(row(cdb, 'L1').status, 'engaged');
  assert.ok(row(cdb, 'L1').engaged_at);
  await hit(mkLead(2).link_token);
  assert.equal(row(cdb, 'L2').status, 'requested', 'no retrocede a alguien que ya pidió la llamada');
  await hit(mkLead(3).link_token, { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
  assert.equal(row(cdb, 'L3').status, 'emailed', 'un bot no cuenta como visita');
  assert.equal((await hit('no-es-un-token')).status, 204);
});

test('/c/:token: si el lead tiene web de demo, su página ofrece "Ver mi web" (en español)', async () => {
  cdb.tables.new_business_leads = [mkLead(1, { status: 'emailed', demo_url: 'https://sol-1.vercel.app' }), mkLead(2, { status: 'emailed' })];
  const withDemo = await (await fetch(`${base}/c/${mkLead(1).link_token}`, { headers: UA })).text();
  assert.match(withDemo, /href="https:\/\/sol-1\.vercel\.app\/\?lang=es"[^>]*>Ver mi web</);
  const without = await (await fetch(`${base}/c/${mkLead(2).link_token}`, { headers: UA })).text();
  assert.doesNotMatch(without, /Ver mi web/);
});

// ─── API del dashboard ──────────────────────────────────────────────────────────────────────────────────────────────
test('dashboard: crear la web de un lead, contadores de demos y el email según la versión activa', async () => {
  const db = createMemoryDb({ new_business_leads: [mkLead(1), mkLead(2, { demo_status: 'failed' }), mkLead(3, { demo_status: 'ready' })] });
  const f = fakes();
  const app = express();
  app.use(express.json());
  app.use('/api/leads', createLeadsRouter({ db, ownerId: OWNER, demoBuild: f.build, demoDeploy: f.deploy }));
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/api/leads`;
  const saved = process.env.LEAD_DEMOS;
  try {
    const made = await fetch(`${url}/L1/demo`, { method: 'POST' }).then(r => r.json());
    assert.equal(made.ok, true);
    assert.equal(row(db, 'L1').demo_status, 'ready');
    assert.equal((await fetch(`${url}/nope/demo`, { method: 'POST' })).status, 404);

    const stats = await fetch(`${url}/stats`).then(r => r.json());
    assert.deepEqual([stats.demos.ready, stats.demos.failed, stats.demos.columns], [2, 1, true]);
    const list = await fetch(`${url}/?status=new&demo=ready&limit=10`).then(r => r.json());
    assert.deepEqual(list.leads.map(l => l.id).sort(), ['L1', 'L3']);
    assert.ok('demo_url' in list.leads[0]);

    process.env.LEAD_DEMOS = 'true';
    const tpl = await fetch(`${url}/email-template`).then(r => r.json());
    assert.equal(tpl.demos, true);
    assert.match(tpl.body, /\{\{web\}\}/);
    process.env.LEAD_DEMOS = 'false';
    assert.match((await fetch(`${url}/email-template`).then(r => r.json())).body, /\{\{calendario\}\}/);

    const batch = await fetch(`${url}/demos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: 9 }) });
    assert.equal(batch.status, 400, 'como mucho 5 de golpe');
  } finally {
    if (saved === undefined) delete process.env.LEAD_DEMOS; else process.env.LEAD_DEMOS = saved;
    srv.closeAllConnections?.(); srv.close();
  }
});

import { generateAllDemos } from '../src/services/leadDemos.js';
test('generateAllDemos (modo "todas"): hace las webs de TODOS los leads nuevos sin web, de 5 en 5, y termina aunque alguna falle', async () => {
  const leads = Array.from({ length: 12 }, (_, i) => mkLead(i + 1));
  const db = createMemoryDb({ new_business_leads: leads });
  let n = 0;
  const f = fakes();
  const build = async (o) => { if (++n === 4) throw new Error('boom'); return f.build(o); };
  const r = await generateAllDemos({ db, ownerId: OWNER, publicUrl: PUBLIC, build, deploy: f.deploy });
  assert.deepEqual(r, { created: 11, failed: 1 });
  assert.equal(db.rows('new_business_leads').filter(l => l.demo_status === 'ready').length, 11);
  assert.equal(db.rows('new_business_leads').filter(l => l.demo_status === 'failed').length, 1, 'la fallida no se reintenta en bucle');
});

test('generateAllDemos: se para al agotar el tiempo y el siguiente ciclo continúa', async () => {
  const db = createMemoryDb({ new_business_leads: Array.from({ length: 12 }, (_, i) => mkLead(i + 1)) });
  const f = fakes();
  let t = 0;
  const r = await generateAllDemos({ db, ownerId: OWNER, publicUrl: PUBLIC, batch: 5, maxMs: 100, build: f.build, deploy: f.deploy, now: () => (t += 60) });
  assert.ok(r.created > 0 && r.created < 12);
  const rest = await generateAllDemos({ db, ownerId: OWNER, publicUrl: PUBLIC, build: f.build, deploy: f.deploy });
  assert.equal(r.created + rest.created, 12);
});
