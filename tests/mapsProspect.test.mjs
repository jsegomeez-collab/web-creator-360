// Campaña 2 (negocios de Google Maps sin web): clasificación de lugares, emails, ejecución con Apify simulado,
// separación de campañas en Instantly y texto propio del email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { extractEmails, classifyPlace, buildInput, runMapsProspect, MAPS_SOURCE } from '../src/services/mapsProspect.js';
import { runActor } from '../src/services/apify.js';
import { pickRun, ZONES, CATEGORIES } from '../src/services/mapsZones.js';
import { loadInstantlyConfig, pushLeads, buildInstantlyLead } from '../src/services/instantly.js';
import { facebookPageUrl, pageFromSearch, pageMatches, findFacebookEmails } from '../src/services/facebookEmails.js';
import { decorateDemo } from '../src/services/leadDemos.js';
import { parseRequest, saveRequest, CONSENT_TEXT_EN, PREFERRED_TIMES_EN } from '../src/services/callRequests.js';
import { renderEmail, emailTemplate, templateVariables, leadVariables } from '../src/prompts/newBusinessEmails.js';
import { leadBusiness } from '../src/services/leadDemos.js';

const OWNER = 'owner-1';
const zone = { state: 'FL', query: 'Hialeah, FL' };
const taqueria = { search: 'taquería', sector: 'comida', latin: true };
const barber = { search: 'barbería', sector: 'belleza', latin: false };

const place = (over = {}) => ({
  title: 'Taquería El Primo', placeId: 'P1', city: 'Hialeah', state: 'Florida', postalCode: '33012', address: '1 Main St, Hialeah, FL',
  phone: '(305) 555-0100', phoneUnformatted: '+13055550100', website: null, reviewsCount: 62, totalScore: 4.8, url: 'https://maps.google.com/?cid=1',
  categoryName: 'Taquería', searchString: 'taquería', emails: ['elprimo@gmail.com'], ...over,
});
const resolver = { resolveMx: async () => [{ exchange: 'mx.example.com' }], resolve4: async () => [], resolve6: async () => [] };
const verifyOptions = { resolver, provider: async () => null };

// ─── emails ──────────────────────────────────────────────────────────────────
test('extractEmails: busca en todo el lugar (Facebook, Instagram…), quita basura y deja los genéricos al final', () => {
  const item = { emails: ['INFO@elprimo.com'], facebooks: [{ email: 'maria.lopez@gmail.com', photo: 'a@2x.png' }], text: 'escríbenos a x@sentry.io', reviews: [{ text: 'mi email es cliente@gmail.com' }] };
  assert.deepEqual(extractEmails(item), ['maria.lopez@gmail.com', 'info@elprimo.com']);
  assert.deepEqual(extractEmails({}), []);
  assert.deepEqual(extractEmails({ emails: ['ayuda@incfile.com', 'a@ciudad.gov'] }), []);
});

// ─── clasificación ───────────────────────────────────────────────────────────
test('classifyPlace: un negocio latino sin web, con reseñas y email se convierte en lead de Maps', () => {
  const { lead } = classifyPlace(place(), { zone, category: taqueria });
  assert.deepEqual(
    [lead.external_id, lead.name, lead.email, lead.city, lead.state, lead.business_phone, lead.rating, lead.reviews, lead.sector, lead.priority, lead.latino_signal, lead.latino_strong, lead.registered_at],
    ['P1', 'Taquería El Primo', 'elprimo@gmail.com', 'Hialeah', 'Florida', '+13055550100', 4.8, 62, 'comida', 'A', true, true, null],
  );
  assert.match(lead.notes, /^Maps · /);
});

test('classifyPlace: motivos para descartar', () => {
  const skip = (over, opts = { zone, category: taqueria }) => classifyPlace(place(over), opts).skip;
  assert.equal(skip({ website: 'https://elprimo.com' }), 'tiene web');
  assert.equal(skip({ permanentlyClosed: true }), 'cerrado');
  assert.equal(skip({ title: "McDonald's" }), 'cadena');
  assert.equal(skip({ reviewsCount: 2 }), 'pocas reseñas');
  assert.equal(skip({ totalScore: 2.9 }), 'puntuación baja');
  assert.equal(skip({ emails: [] }), 'sin email');
  assert.equal(skip({ placeId: undefined }), 'sin nombre o id');
});

test('classifyPlace: cualquier dueño entra; las señales latinas solo marcan, y se pueden exigir', () => {
  const anyone = place({ title: 'Joe Plumbing', emails: ['joe@gmail.com'] });
  const r = classifyPlace(anyone, { zone, category: barber });
  assert.deepEqual([r.lead.latino_signal, r.lead.latino_strong, r.lead.notes], [false, false, 'Maps']);
  assert.equal(classifyPlace(anyone, { zone, category: barber, requireLatino: true }).skip, 'sin señal latina');
  const latino = classifyPlace(place({ title: 'Premier Cuts', emails: ['rodriguez@gmail.com'] }), { zone, category: barber, requireLatino: true });
  assert.ok(latino.lead.latino_signal);
  assert.equal(classifyPlace(place({ title: 'Premier Cuts', emails: ['p@gmail.com'], additionalInfo: { Languages: ['Spanish'] } }), { zone, category: barber }).lead.latino_strong, true);
  // sin email todavía: pasa como candidato para buscar su Facebook
  assert.equal(classifyPlace(place({ emails: [] }), { zone, category: taqueria, requireEmail: false }).lead.email, null);
});

test('buildInput: solo lugares SIN web, resultados en inglés, con las búsquedas de la zona', () => {
  const i = buildInput({ zone, categories: [taqueria, barber], maxPerSearch: 25 });
  assert.deepEqual([i.searchStringsArray, i.locationQuery, i.website, i.language, i.maxCrawledPlacesPerSearch], [['taquería', 'barbería'], 'Hialeah, FL', 'withoutWebsite', 'en', 25]);
});

test('pickRun: rota por ciudades y, al dar la vuelta, cambia de categorías', () => {
  assert.equal(pickRun(0).zone, ZONES[0]);
  assert.equal(pickRun(1).zone, ZONES[1]);
  assert.deepEqual(pickRun(0).categories, CATEGORIES.slice(0, 3));
  assert.deepEqual(pickRun(ZONES.length).categories, CATEGORIES.slice(3, 6));
  assert.equal(pickRun(ZONES.length).zone, ZONES[0]);
});

// ─── ejecución completa ──────────────────────────────────────────────────────
test('runMapsProspect: busca el Facebook de los que no tienen email, guarda los buenos como source gmaps, no duplica y anota la ejecución', async () => {
  const db = createMemoryDb({ new_business_leads: [], lead_ingest_runs: [] });
  const items = [
    place({ emails: [] }),                                                   // sin email: se busca su Facebook → lo encuentra
    place({ placeId: 'P2', title: 'Joe Plumbing', emails: [] }),             // sin email: Facebook sin resultado
    place({ placeId: 'P3', website: 'https://x.com' }), place({ placeId: 'P4', emails: ['dueno@gmail.com'], title: 'Joe Barbers' }),
  ];
  const asked = [];
  const facebook = async (places) => { asked.push(places.map(p => p.placeId)); return { found: new Map([['P1', { email: 'elprimo@gmail.com', url: 'https://www.facebook.com/x' }]]), stats: { searched: places.length, pages: 2, matched: 1, withEmail: 1, costUsd: 0.03 } }; };
  const run = () => runMapsProspect({ db, ownerId: OWNER, zone, categories: [taqueria], items, facebook, verifyOptions });
  const r = await run();
  assert.deepEqual(asked, [['P1', 'P2']]);
  assert.deepEqual([r.places, r.inserted, r.skips, r.costUsd], [4, 2, { 'tiene web': 1, 'sin email': 1 }, 0.03]);
  const rows = db.rows('new_business_leads');
  assert.deepEqual(rows.map(l => [l.source, l.status, l.email, l.business_phone, l.reviews]).sort(), [['gmaps', 'new', 'dueno@gmail.com', '+13055550100', 62], ['gmaps', 'new', 'elprimo@gmail.com', '+13055550100', 62]]);
  assert.equal(db.rows('lead_ingest_runs')[0].source, MAPS_SOURCE);
  assert.equal((await run()).inserted, 0);   // la segunda vez ya los tiene
});

test('runMapsProspect: lookups limita cuántos Facebook se buscan (los de más reseñas primero) y 0 no busca ninguno', async () => {
  const items = [place({ placeId: 'A', emails: [], reviewsCount: 10 }), place({ placeId: 'B', emails: [], reviewsCount: 90 }), place({ placeId: 'C', emails: [], reviewsCount: 40 })];
  const asked = [];
  const facebook = async (places) => { asked.push(places.map(p => p.placeId)); return { found: new Map(), stats: { costUsd: 0 } }; };
  await runMapsProspect({ zone, categories: [taqueria], items, facebook, lookups: 2, dryRun: true, verifyOptions });
  assert.deepEqual(asked, [['B', 'C']]);
  asked.length = 0;
  const r = await runMapsProspect({ zone, categories: [taqueria], items, facebook, lookups: 0, dryRun: true, verifyOptions });
  assert.deepEqual([asked.length, r.leads.length], [0, 0]);
});

test('runMapsProspect: vista previa no escribe nada', async () => {
  const db = createMemoryDb({ new_business_leads: [], lead_ingest_runs: [] });
  const r = await runMapsProspect({ db, ownerId: OWNER, zone, categories: [taqueria], items: [place()], dryRun: true, verifyOptions });
  assert.deepEqual([r.inserted, r.leads.length, db.rows('new_business_leads').length, db.rows('lead_ingest_runs').length], [0, 1, 0, 0]);
});

// ─── Apify ───────────────────────────────────────────────────────────────────
test('runActor: lanza, espera, lee todas las páginas y manda el token en la cabecera (no en la URL)', async () => {
  const calls = [];
  const statuses = ['RUNNING', 'SUCCEEDED'];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', auth: opts.headers?.Authorization });
    let json;
    if (url.includes('/runs?')) json = { data: { id: 'run1', status: 'READY', defaultDatasetId: 'ds1' } };
    else if (url.includes('/actor-runs/run1')) json = { data: { id: 'run1', status: statuses.shift(), defaultDatasetId: 'ds1', usageTotalUsd: 0.42 } };
    else json = Array.from({ length: url.includes('offset=0') ? 1000 : 3 }, (_, i) => ({ n: i }));
    return { ok: true, status: 200, json: async () => json };
  };
  const r = await runActor({ token: 'tok-secret', actor: 'compass~crawler-google-places' }, { a: 1 }, { maxCostUsd: 5, fetchImpl, sleep: async () => {} });
  assert.deepEqual([r.items.length, r.costUsd], [1003, 0.42]);
  assert.ok(calls.every(c => c.auth === 'Bearer tok-secret' && !c.url.includes('tok-secret')));
  assert.match(calls[0].url, /maxTotalChargeUsd=5/);
});

test('runActor: sin token o con run fallida da un error claro', async () => {
  await assert.rejects(() => runActor({ token: '', actor: 'x~y' }, {}), /APIFY_TOKEN/);
  const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => ({ data: { id: 'r', status: url.includes('/runs') && !url.includes('actor-runs') ? 'READY' : 'FAILED' } }) });
  await assert.rejects(() => runActor({ token: 't', actor: 'x~y' }, {}, { fetchImpl, sleep: async () => {} }), /FAILED/);
});

// ─── dos campañas en Instantly ───────────────────────────────────────────────
const LLC_CAMPAIGN = '5a1d6d4e-8a0b-4e9c-9a53-2f4c8e7f1b10';
const MAPS_CAMPAIGN = '9b2e7f5f-9b1c-4fad-8b64-3a5d9f8a2c21';
const env = { INSTANTLY_API_KEY: 'k', INSTANTLY_CAMPAIGN_ID: LLC_CAMPAIGN, INSTANTLY_CAMPAIGN_ID_MAPS: MAPS_CAMPAIGN, CAMPAIGN_PUBLIC_URL: 'https://campana.example.com', LEAD_DEMOS: 'true' };

test('config de la campaña Maps usa su propio ID y se niega si falta', () => {
  assert.equal(loadInstantlyConfig(env, { dryRun: false, campaign: 'maps' }).campaignId, MAPS_CAMPAIGN);
  assert.equal(loadInstantlyConfig(env, { dryRun: false }).campaignId, LLC_CAMPAIGN);
  assert.throws(() => loadInstantlyConfig({ ...env, INSTANTLY_CAMPAIGN_ID_MAPS: '' }, { dryRun: false, campaign: 'maps' }), /INSTANTLY_CAMPAIGN_ID_MAPS/);
});

test('cada campaña envía solo sus leads: los de Maps a la campaña Maps y el resto a la de LLCs', async () => {
  const mk = (id, source) => ({ id, user_id: OWNER, source, external_id: id, name: `N ${id}`, email: `${id}@gmail.com`, status: 'new', demo_status: 'ready', demo_url: `https://${id}.vercel.app`, link_token: `T${id.padEnd(23, '0')}`, created_at: '2026-10-01T00:00:00Z' });
  const sent = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body); sent.push([body.campaign_id, body.leads.map(l => l.email)]);
    return { ok: true, status: 200, json: async () => ({ created_leads: body.leads.map((l, index) => ({ id: `i-${l.email}`, index, email: l.email })) }) };
  };
  const db = createMemoryDb({ new_business_leads: [mk('a', 'ct_registry'), mk('b', 'gmaps'), mk('c', 'csv_import')] });
  const r1 = await pushLeads({ db, ownerId: OWNER, config: loadInstantlyConfig(env, { dryRun: false, campaign: 'maps' }), dryRun: false, fetchImpl });
  const r2 = await pushLeads({ db, ownerId: OWNER, config: loadInstantlyConfig(env, { dryRun: false }), dryRun: false, fetchImpl });
  assert.deepEqual([r1.pushed, r2.pushed], [1, 2]);
  assert.deepEqual(sent, [[MAPS_CAMPAIGN, ['b@gmail.com']], [LLC_CAMPAIGN, ['a@gmail.com', 'c@gmail.com']]]);
});

// ─── copy propio de la campaña Maps ──────────────────────────────────────────
test('el email de Maps está en inglés, usa las reseñas reales y todas sus variables se rellenan', () => {
  const lead = { source: 'gmaps', name: 'TAQUERIA EL PRIMO', city: 'Hialeah', sector: 'comida', rating: 4.8, reviews: 62, demo_url: 'https://el-primo-ab12.vercel.app', link_token: 'x' };
  const e = renderEmail(lead, 'https://c.example.com/c/x', { demos: true, campaign: 'maps' });
  assert.equal(e.subject, 'A website for Taqueria el Primo');
  assert.match(e.body, /^Hi Taqueria el Primo team,/);
  assert.match(e.body, /found Taqueria el Primo \(4\.8★ from 62 reviews\)\. I noticed you don't have a website yet\./);
  assert.match(e.body, /https:\/\/el-primo-ab12\.vercel\.app\/\?lang=en/);
  assert.ok(!/registrar|Buenas/.test(e.body), 'no es el copy de las LLCs');
  assert.notEqual(emailTemplate({ campaign: 'maps' }).body, emailTemplate({ demos: true }).body);
  const vars = leadVariables(lead, 'u');
  for (const v of templateVariables({ campaign: 'maps' })) assert.ok(v in vars, `falta {{${v}}}`);
  assert.equal(buildInstantlyLead(lead, loadInstantlyConfig(env, { dryRun: false, campaign: 'maps' })).custom_variables.reviews_phrase, ' (4.8★ from 62 reviews)');
  assert.equal(leadVariables({ ...lead, contact_name: 'Maria Lopez' }, 'u').greeting, 'Maria');
});

test('sin reseñas reales no se inventa ninguna; y los leads de LLCs mantienen sus variables en español', () => {
  assert.equal(leadVariables({ source: 'gmaps', name: 'X', link_token: 'x' }, 'u').reviews_phrase, '');
  assert.ok(!('reviews_phrase' in leadVariables({ source: 'ct_registry', name: 'X', link_token: 'x' }, 'u')));
  assert.ok('empresa' in leadVariables({ source: 'ct_registry', name: 'X', link_token: 'x' }, 'u'));
});

test('la web de demo de un lead de Maps usa su estado, su teléfono real y su categoría', () => {
  const b = leadBusiness({ name: 'Taquería El Primo', city: 'Hialeah', state: 'FL', email: 'e@g.com', sector: 'comida', category: 'Taquería', business_phone: '+13055550100', registered_at: null });
  assert.deepEqual([b.state, b.phone, b.activity], ['FL', '+13055550100', 'Taquería']);
});

// ─── rutas del panel ─────────────────────────────────────────────────────────
import express from 'express';
import { createLeadsRouter } from '../src/routes/leads.js';

async function withRoutes(fn, { db, mapsItems = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/leads', createLeadsRouter({ db, ownerId: OWNER, verifyOptions, mapsItems, fetchImpl: globalThis.fetch }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const api = (path, { method = 'GET', body } = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/leads${path}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: await r.json() }));
  try { return await fn(api); } finally { server.closeAllConnections?.(); server.close(); }
}

test('ruta /ingest/maps: guarda leads de Maps, devuelve el resumen sin listas de emails y valida maxPerSearch', async () => {
  const db = createMemoryDb({ new_business_leads: [], lead_ingest_runs: [] });
  await withRoutes(async (api) => {
    const r = await api('/ingest/maps', { method: 'POST', body: { maxPerSearch: 20 } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.inserted, r.body.places, r.body.leads, r.body.invalid], [1, 2, undefined, undefined]);
    assert.equal(db.rows('new_business_leads')[0].source, MAPS_SOURCE);
    assert.equal((await api('/ingest/maps', { method: 'POST', body: { maxPerSearch: 999 } })).status, 400);
  }, { db, mapsItems: [place(), place({ placeId: 'P9', website: 'https://x.com' })] });
});

test('ruta /ingest/maps: sin APIFY_TOKEN explica qué falta', async () => {
  delete process.env.APIFY_TOKEN;
  await withRoutes(async (api) => {
    const r = await api('/ingest/maps', { method: 'POST', body: {} });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /APIFY_TOKEN/);
  }, { db: createMemoryDb({ new_business_leads: [], lead_ingest_runs: [] } ) });
});

test('rutas: /email-template?campaign=maps devuelve el texto de Maps, y la lista filtra por origen y excluye Maps', async () => {
  const mk = (id, source) => ({ id, user_id: OWNER, source, external_id: id, name: `N ${id}`, email: `${id}@gmail.com`, status: 'new', link_token: `t-${id}`, created_at: '2026-10-01T00:00:00Z' });
  const db = createMemoryDb({ new_business_leads: [mk('a', 'ct_registry'), mk('b', 'gmaps'), mk('c', 'csv_import')] });
  await withRoutes(async (api) => {
    const t = (await api('/email-template?campaign=maps')).body;
    assert.deepEqual([t.campaign, t.subject, t.demos], ['maps', 'A website for {{business}}', true]);
    assert.ok(t.variables.includes('reviews_phrase'));
    assert.equal((await api('/email-template')).body.campaign, 'llc');
    assert.deepEqual((await api('/?source=gmaps')).body.leads.map(l => l.id), ['b']);
    assert.deepEqual((await api('/?notSource=gmaps')).body.leads.map(l => l.id).sort(), ['a', 'c']);
  }, { db });
});

test('ruta /push con campaign=maps usa el ID de la campaña de Maps y solo sus leads', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  Object.assign(process.env, { INSTANTLY_API_KEY: 'k', INSTANTLY_CAMPAIGN_ID: LLC_CAMPAIGN, INSTANTLY_CAMPAIGN_ID_MAPS: MAPS_CAMPAIGN, CAMPAIGN_PUBLIC_URL: 'https://campana.example.com', LEAD_DEMOS: 'true' });
  delete process.env.OUTREACH_DRY_RUN;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.instantly.ai')) {
      if (String(url).endsWith('/leads/add')) {
        const body = JSON.parse(opts.body); sent.push([body.campaign_id, body.leads.map(l => l.email)]);
        return { ok: true, status: 200, json: async () => ({ created_leads: body.leads.map((l, index) => ({ id: `i${index}`, index, email: l.email })) }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 1 }) };   // GET campaign → active
    }
    return realFetch(url, opts);
  };
  const mk = (id, source) => ({ id, user_id: OWNER, source, external_id: id, name: `N ${id}`, email: `${id}@gmail.com`, status: 'new', demo_status: 'ready', demo_url: `https://${id}.vercel.app`, link_token: `t-${id}`, created_at: '2026-10-01T00:00:00Z' });
  const db = createMemoryDb({ new_business_leads: [mk('a', 'ct_registry'), mk('b', 'gmaps')] });
  try {
    await withRoutes(async (api) => {
      const r = await api('/push', { method: 'POST', body: { limit: 10, campaign: 'maps' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.pushed, 1);
      assert.deepEqual(sent, [[MAPS_CAMPAIGN, ['b@gmail.com']]]);
    }, { db });
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ['INSTANTLY_API_KEY', 'INSTANTLY_CAMPAIGN_ID', 'INSTANTLY_CAMPAIGN_ID_MAPS', 'CAMPAIGN_PUBLIC_URL', 'LEAD_DEMOS']) delete process.env[k];
  }
});

// ─── Facebook: encontrar la página y comprobar que es el mismo negocio ───────
test('facebookPageUrl: solo páginas de negocio, normalizadas', () => {
  assert.equal(facebookPageUrl('https://www.facebook.com/taqueriacancunhtx/'), 'https://www.facebook.com/taqueriacancunhtx');
  assert.equal(facebookPageUrl('https://www.facebook.com/100058817383620/photos/'), 'https://www.facebook.com/100058817383620');
  assert.equal(facebookPageUrl('https://www.facebook.com/pages/Taqueria-El-Alazan/449121958944849'), 'https://www.facebook.com/pages/Taqueria-El-Alazan/449121958944849');
  for (const bad of ['https://www.facebook.com/groups/123', 'https://www.facebook.com/sharer/sharer.php?u=x', 'https://yelp.com/biz/x', 'https://www.facebook.com/', null]) assert.equal(facebookPageUrl(bad), null);
  assert.equal(pageFromSearch({ organicResults: [{ url: 'https://yelp.com/x' }, { url: 'https://www.facebook.com/groups/9' }, { url: 'https://www.facebook.com/elrojoloco/' }] }), 'https://www.facebook.com/elrojoloco');
});

test('pageMatches: mismo teléfono o mismas palabras distintivas del nombre; las genéricas no cuentan', () => {
  const place = { title: 'Taqueria El Rojo Loco', phoneUnformatted: '+17132271572' };
  assert.ok(pageMatches(place, { phone: '(713) 227-1572', title: 'Otro nombre' }));                     // teléfono
  assert.ok(pageMatches(place, { title: 'Taqueria El Rojo Loco | Houston TX' }));                        // nombre
  assert.ok(!pageMatches(place, { title: 'Taqueria Cancun Restaurant', phone: '(713) 932-9566' }));     // otro negocio
  assert.ok(!pageMatches({ title: 'Taqueria El Paisa' }, { title: 'Taqueria El Charro' }));             // solo comparten palabras genéricas
});

test('findFacebookEmails: busca la página, la lee y solo da el email si es el mismo negocio', async () => {
  const places = [
    { placeId: 'P1', title: 'Taqueria El Rojo Loco', city: 'Houston', state: 'TX', phoneUnformatted: '+17132271572' },
    { placeId: 'P2', title: 'Taqueria Chuy', city: 'Houston', state: 'TX', phoneUnformatted: '+17135550000' },
    { placeId: 'P3', title: 'Joe Plumbing', city: 'Houston', state: 'TX' },
  ];
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push(url.split('/v2')[1].split('?')[0]);
    let json;
    if (/\/acts\/[^/]+\/runs/.test(url)) json = { data: { id: url.includes('google') ? 'g' : 'f', status: 'SUCCEEDED', defaultDatasetId: url.includes('google') ? 'dg' : 'df', usageTotalUsd: 0.02 } };
    else if (url.includes('/datasets/dg/')) json = [
      { searchQuery: { term: 'Taqueria El Rojo Loco Houston TX facebook' }, organicResults: [{ url: 'https://www.facebook.com/elrojoloco/' }] },
      { searchQuery: { term: 'Taqueria Chuy Houston TX facebook' }, organicResults: [{ url: 'https://www.facebook.com/taqueriacancunhtx/' }] },
      { searchQuery: { term: 'Joe Plumbing Houston TX facebook' }, organicResults: [{ url: 'https://yelp.com/biz/joe' }] },
    ];
    else if (url.includes('/datasets/df/')) json = [
      { facebookUrl: 'https://www.facebook.com/elrojoloco', title: 'Taqueria El Rojo Loco | Houston TX', email: 'ElRojo@Gmail.com', phone: '(713) 227-1572' },
      { facebookUrl: 'https://www.facebook.com/taqueriacancunhtx', title: 'Taqueria Cancun', email: 'cancun@gmail.com', phone: '(713) 932-9566' },   // otro negocio
    ];
    else json = { data: { status: 'SUCCEEDED' } };
    return { ok: true, status: 200, json: async () => json };
  };
  const { found, stats } = await findFacebookEmails(places, { apify: { token: 't' }, fetchImpl, sleep: async () => {} });
  assert.deepEqual([...found.entries()], [['P1', { email: 'elrojo@gmail.com', url: 'https://www.facebook.com/elrojoloco' }]]);
  assert.deepEqual([stats.searched, stats.pages, stats.matched, stats.withEmail], [3, 2, 1, 1]);
});

// ─── todo en inglés para los leads de Maps ───────────────────────────────────
test('la barra de la demo y la página de solicitud están en inglés para los leads de Maps (y en español para el resto)', () => {
  const bar = (lang) => decorateDemo('<html><head></head><body></body></html>', { brand: 'El Primo', requestUrl: 'https://c/x', beaconUrl: 'https://v/x', lang });
  assert.match(bar('en'), /Sample website for El Primo[\s\S]*I want it/);
  assert.match(bar('es'), /Web de muestra para El Primo[\s\S]*La quiero/);
  const en = parseRequest({ phone: '305 555 0100', consent: 'on', when: 'Later today' }, 'en');
  assert.equal(en.values.preferred_time, 'Later today');
  assert.match(parseRequest({ phone: '12' }, 'en').errors.phone, /Please check your phone/);
  assert.match(parseRequest({ phone: '12' }).errors.phone, /Revisa tu teléfono/);
  assert.equal(PREFERRED_TIMES_EN[0], 'As soon as possible');
});

test('la solicitud de un lead de Maps guarda el consentimiento en inglés como prueba', async () => {
  const mk = (source) => ({ id: 'L', user_id: OWNER, source, status: 'emailed', link_token: 't' });
  for (const [source, expected] of [['gmaps', CONSENT_TEXT_EN], ['ct_registry', undefined]]) {
    const db = createMemoryDb({ new_business_leads: [mk(source)] });
    assert.equal(await saveRequest({ db, ownerId: OWNER, lead: mk(source), values: { phone: '+13055550100', name: null, preferred_time: 'Later today' }, ip: '1.1.1.1' }), 'new');
    const saved = db.rows('new_business_leads')[0].consent_text;
    if (expected) assert.equal(saved, expected); else assert.match(saved, /^Acepto que Get ur Web/);
  }
});
