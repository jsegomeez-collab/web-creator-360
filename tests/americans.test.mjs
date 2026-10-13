// Campaña de "americanos": LLCs nuevas de Connecticut SIN señal latina, en inglés y en su propia campaña de Instantly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { runCtIngest } from '../src/services/ctIngest.js';
import { hasWebsite, dropLeadsWithWebsite, isPrivateAddress, isFreeMail, domainOf, visibleText } from '../src/services/siteCheck.js';
import { MAPS_SOURCE, US_SOURCE, isEnglishSource, campaignOfSource } from '../src/services/audience.js';
import { loadInstantlyConfig, pushLeads, buildInstantlyLead } from '../src/services/instantly.js';
import { renderEmail, emailTemplate, templateVariables, leadVariables, EMAIL_BODY_US } from '../src/prompts/newBusinessEmails.js';
import { isEnglishLead, parseRequest } from '../src/services/callRequests.js';
import { leadBusiness, decorateDemo } from '../src/services/leadDemos.js';
import { writeTexts, SYSTEM, SYSTEM_EN } from '../src/sitegen/writer.js';
import { moveToFollowup } from '../src/services/followup.js';
import { clearDomainCache } from '../src/services/emailVerify.js';

const OWNER = 'owner-1';
const TODAY = new Date('2026-09-28T15:00:00Z');
const resolver = { resolveMx: async () => [{ exchange: 'mx.example.com', priority: 10 }], resolve4: async () => [], resolve6: async () => [] };
const verifyOptions = { resolver, provider: async () => null };

const row = (n, name, email, o = {}) => ({
  name, accountnumber: String(n), status: 'Active', date_registration: '2026-09-14T00:00:00.000', business_email_address: email,
  category_survey_email_address: '', naics_code: 'Janitorial Services (561720)', minority_owned_organization: false,
  billingstreet: '1 Main St', billingcity: 'HARTFORD', billingpostalcode: '06103', ...o,
});

// ─── comprobación de "ya tiene web" ──────────────────────────────────────────
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const page = (html, status = 200) => ({ ok: status < 400, status, text: async () => html });
const REAL_SITE = `<html><body>${'<p>We build custom furniture in Hartford since 2015. Visit our workshop, see our portfolio and get a quote today.</p>'.repeat(3)}</body></html>`;

test('isPrivateAddress: redes internas, loopback y link-local no se consultan', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'no-es-ip']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) assert.equal(isPrivateAddress(ip), false, ip);
  assert.deepEqual([domainOf('A@Foo.COM'), isFreeMail('gmail.com'), isFreeMail('foo.com')], ['foo.com', true, false]);
});

test('hasWebsite: web real sí; aparcada/en construcción, vacía, caída o inexistente no; protegida (403) sí', async () => {
  const check = (respond, options = {}) => hasWebsite('empresa.com', { lookup: publicLookup, fetchImpl: async (url) => respond(url), timeoutMs: 100, ...options });
  assert.deepEqual(await check(() => page(REAL_SITE)), { has: true, reason: 'tiene web' });
  assert.equal((await check(() => page(`<html>${'x '.repeat(80)} This domain is for sale. Buy this domain today</html>`))).has, false);
  assert.equal((await check(() => page('<html><body>Coming soon — our new website is under construction. Please check back later for something new.</body></html>'))).has, false);
  assert.equal((await check(() => page('<html></html>'))).has, false);
  assert.equal((await check(() => page('', 503))).has, false);
  assert.equal((await check(() => page('', 404))).has, false);
  assert.equal((await check(() => { throw new Error('timeout'); })).has, false);
  assert.equal((await check(() => page('', 403))).has, true);
});

test('hasWebsite: una web real que menciona "coming soon" sigue siendo una web; una página aparcada con mucho CSS no (caso real: sabrati.com vs Squarespace)', async () => {
  const check = (html) => hasWebsite('empresa.com', { lookup: publicLookup, fetchImpl: async () => page(html), timeoutMs: 100 });
  const css = '<style>' + '.content * { color: #fff; } '.repeat(200) + '</style><script>' + 'var a=1;'.repeat(300) + '</script>';
  const realSite = `<html><head>${css}</head><body><h1>Resident evaluation summaries</h1>${'<p>We help property managers screen residents faster with clear reports, simple pricing and fast support every day of the week.</p>'.repeat(12)}<footer>New office coming soon in Boston</footer></body></html>`;
  assert.deepEqual(await check(realSite), { has: true, reason: 'tiene web' });
  const parked = `<html><head>${css}</head><body><h1>Coming Soon</h1><p>This site is not published yet. Check back soon for updates from the owner of this new domain name. Thank you for your patience while we get everything ready for you.</p></body></html>`;
  assert.deepEqual(await check(parked), { has: false, reason: 'página de aparcamiento o en construcción' });
  assert.equal(visibleText('<style>a{}</style><p>Hola&nbsp;<b>mundo</b></p><script>x()</script>'), 'Hola mundo');
});

test('hasWebsite: nunca consulta dominios que no resuelven o que apuntan a una red privada', async () => {
  let asked = 0;
  const fetchImpl = async () => { asked++; return page(REAL_SITE); };
  assert.equal((await hasWebsite('interno.com', { fetchImpl, lookup: async () => [{ address: '10.0.0.8' }] })).has, false);
  assert.equal((await hasWebsite('nada.com', { fetchImpl, lookup: async () => { throw new Error('ENOTFOUND'); } })).has, false);
  for (const d of ['localhost', '127.0.0.1', 'sinpunto']) assert.equal((await hasWebsite(d, { fetchImpl, lookup: publicLookup })).has, false);
  assert.equal(asked, 0);
});

test('dropLeadsWithWebsite: los buzones personales nunca se consultan y cada dominio se pregunta una sola vez', async () => {
  const asked = [];
  const fetchImpl = async (url) => { asked.push(new URL(url).hostname); return new URL(url).hostname.includes('conweb') ? page(REAL_SITE) : page('', 404); };
  const leads = [{ email: 'a@gmail.com' }, { email: 'b@conweb.com' }, { email: 'c@conweb.com' }, { email: 'd@sinweb.com' }];
  const { kept, dropped } = await dropLeadsWithWebsite(leads, { fetchImpl, lookup: publicLookup, timeoutMs: 100 });
  assert.deepEqual(kept.map(l => l.email), ['a@gmail.com', 'd@sinweb.com']);
  assert.deepEqual(dropped.map(d => d.lead.email), ['b@conweb.com', 'c@conweb.com']);
  assert.equal(asked.filter(h => h === 'conweb.com').length, 1);          // una sola petición para los dos leads del mismo dominio
  assert.ok(!asked.some(h => h === 'gmail.com'));
});

// ─── ingesta con americanos ──────────────────────────────────────────────────
test('ingesta con americanos: latinos a ct_registry, el resto a ct_registry_us; descarta a quien ya tiene web; una sola ingesta anotada', async () => {
  clearDomainCache();
  const db = createMemoryDb({ new_business_leads: [], lead_ingest_runs: [], email_suppressions: [] });
  const rows = [
    row(1, 'Limpieza Rivera LLC', 'rivera@gmail.com'),                       // latino
    row(2, 'Cooper Consulting LLC', 'cooper@gmail.com'),                     // americano, correo personal
    row(3, 'Paper Blueprint LLC', 'cooper@paperblueprint.com'),              // americano con dominio propio que YA tiene web
    row(4, 'Flow Growth LLC', 'hello@flowgrowth.ai'),                        // americano con dominio propio SIN web
    row(5, 'Garcia Painting LLC', 'garcia@conweb.com'),                      // latino con web propia: también se descarta
  ];
  const fetchImpl = async (url) => (/paperblueprint|conweb/.test(url) ? page(REAL_SITE) : page('', 404));
  const run = (extra = {}) => runCtIngest({ db, ownerId: OWNER, rows, today: TODAY, verifyOptions, americans: true, checkWebsites: true, websiteOptions: { fetchImpl, lookup: publicLookup, timeoutMs: 100 }, ...extra });

  const r = await run();
  const bySource = (s) => db.rows('new_business_leads').filter(l => l.source === s).map(l => l.name).sort();
  assert.deepEqual(bySource('ct_registry'), ['Limpieza Rivera LLC']);
  assert.deepEqual(bySource(US_SOURCE), ['Cooper Consulting LLC', 'Flow Growth LLC']);
  assert.deepEqual([r.inserted, r.insertedAmericans, r.stats.alreadyHasWebsite], [3, 2, 2]);
  assert.equal(db.rows('lead_ingest_runs').length, 1);
  assert.equal(db.rows('lead_ingest_runs')[0].source, 'ct_registry');
  assert.equal((await run()).inserted, 0);                                  // repetir no duplica
});

test('ingesta sin americanos (por defecto): solo latinos, como siempre', async () => {
  clearDomainCache();
  const db = createMemoryDb({ new_business_leads: [], lead_ingest_runs: [], email_suppressions: [] });
  const rows = [row(1, 'Limpieza Rivera LLC', 'rivera@gmail.com'), row(2, 'Cooper Consulting LLC', 'cooper@gmail.com')];
  const r = await runCtIngest({ db, ownerId: OWNER, rows, today: TODAY, verifyOptions });
  assert.deepEqual([r.inserted, r.insertedAmericans, r.americans, db.rows('new_business_leads').map(l => l.source)], [1, 0, null, ['ct_registry']]);
});

test('vista previa con americanos: cuenta los dos grupos y no escribe nada', async () => {
  clearDomainCache();
  const db = createMemoryDb({ new_business_leads: [], lead_ingest_runs: [], email_suppressions: [] });
  const rows = [row(1, 'Limpieza Rivera LLC', 'rivera@gmail.com'), row(2, 'Cooper Consulting LLC', 'cooper@gmail.com')];
  const r = await runCtIngest({ db, ownerId: OWNER, rows, today: TODAY, verifyOptions, americans: true, dryRun: true });
  assert.deepEqual([r.leads.length, r.americans.leads.length, r.inserted, db.rows('new_business_leads').length], [1, 1, 0, 0]);
});

// ─── tres campañas en Instantly ──────────────────────────────────────────────
const C = { llc: '5a1d6d4e-8a0b-4e9c-9a53-2f4c8e7f1b10', maps: '9b2e7f5f-9b1c-4fad-8b64-3a5d9f8a2c21', us: '7c3a1e44-2b5d-4c6e-9f10-8a7b6c5d4e32' };
const env = { INSTANTLY_API_KEY: 'k', INSTANTLY_CAMPAIGN_ID: C.llc, INSTANTLY_CAMPAIGN_ID_MAPS: C.maps, INSTANTLY_CAMPAIGN_ID_US: C.us, CAMPAIGN_PUBLIC_URL: 'https://campana.example.com' };

test('cada campaña envía solo lo suyo: americanos → su campaña; las otras dos no se los llevan', async () => {
  const mk = (id, source) => ({ id, user_id: OWNER, source, external_id: id, name: `N ${id}`, email: `${id}@gmail.com`, status: 'new', demo_status: 'ready', demo_url: `https://${id}.vercel.app`, link_token: `t-${id}`, created_at: '2026-10-01T00:00:00Z' });
  const sent = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body); sent.push([body.campaign_id, body.leads.map(l => l.email)]);
    return { ok: true, status: 200, json: async () => ({ created_leads: body.leads.map((l, index) => ({ id: `i-${l.email}`, index, email: l.email })) }) };
  };
  const db = createMemoryDb({ new_business_leads: [mk('a', 'ct_registry'), mk('b', MAPS_SOURCE), mk('c', US_SOURCE), mk('d', 'csv_import')] });
  for (const campaign of ['us', 'maps', 'llc']) await pushLeads({ db, ownerId: OWNER, config: loadInstantlyConfig(env, { dryRun: false, campaign }), dryRun: false, fetchImpl });
  assert.deepEqual(sent, [[C.us, ['c@gmail.com']], [C.maps, ['b@gmail.com']], [C.llc, ['a@gmail.com', 'd@gmail.com']]]);
  assert.equal(loadInstantlyConfig(env, { dryRun: false, campaign: 'us' }).demos, true);
  assert.throws(() => loadInstantlyConfig({ ...env, INSTANTLY_CAMPAIGN_ID_US: '' }, { dryRun: false, campaign: 'us' }), /INSTANTLY_CAMPAIGN_ID_US/);
});

test('audiencias: qué origen es inglés y a qué campaña va', () => {
  assert.deepEqual([MAPS_SOURCE, US_SOURCE].map(isEnglishSource), [true, true]);
  assert.deepEqual(['ct_registry', 'csv_import', undefined].map(isEnglishSource), [false, false, false]);
  assert.deepEqual(['ct_registry', MAPS_SOURCE, US_SOURCE, 'csv_import'].map(campaignOfSource), ['llc', 'maps', 'us', 'llc']);
});

// ─── todo en inglés para los americanos ──────────────────────────────────────
test('el email de americanos está en inglés, con las variables inglesas y la web en inglés', () => {
  const lead = { source: US_SOURCE, name: 'COOPER CONSULTING LLC', city: 'Hartford', sector: 'otro', demo_url: 'https://cooper-ab12.vercel.app', link_token: 'x' };
  const e = renderEmail(lead, 'https://c.example.com/c/x', { campaign: 'us' });
  assert.equal(e.subject, 'Congrats on Cooper Consulting LLC');
  assert.match(e.body, /^Hi Cooper Consulting LLC team,/);
  assert.match(e.body, /Congratulations on registering Cooper Consulting LLC in Hartford!/);
  assert.match(e.body, /https:\/\/cooper-ab12\.vercel\.app\/\?lang=en/);
  assert.ok(!/Buenas|registrar|Enhorabuena/.test(e.body));
  const vars = leadVariables(lead, 'u');
  for (const v of templateVariables({ campaign: 'us' })) assert.ok(v in vars, `falta {{${v}}}`);
  assert.equal(emailTemplate({ campaign: 'us' }).body, EMAIL_BODY_US);
  assert.equal(buildInstantlyLead(lead, loadInstantlyConfig(env, { dryRun: false, campaign: 'us' })).custom_variables.site, 'https://cooper-ab12.vercel.app/?lang=en');
});

test('la página de solicitud, la barra de la demo y el motor de webs tratan al americano como inglés (sin suponer que es latino)', async () => {
  assert.equal(isEnglishLead({ source: US_SOURCE }), true);
  assert.equal(isEnglishLead({ source: 'ct_registry' }), false);
  assert.match(parseRequest({ phone: '1' }, 'en').errors.phone, /Please check your phone/);
  assert.match(decorateDemo('<html><head></head><body></body></html>', { brand: 'Cooper', requestUrl: 'u', beaconUrl: 'b', lang: 'en' }), /Sample website for Cooper/);
  assert.equal(leadBusiness({ name: 'Cooper', source: US_SOURCE, city: 'Hartford', state: 'CT' }).audience, 'en');
  assert.equal('audience' in leadBusiness({ name: 'Limpieza Rivera', source: 'ct_registry', city: 'Hartford' }), false);
  const systems = [];
  const write = async ({ system }) => { systems.push(system); return { text: JSON.stringify({ units: [] }), usage: {}, stopReason: 'end_turn' }; };
  await writeTexts({ facts: { brand: 'Cooper', legalName: 'Cooper LLC', city: 'Hartford', state: 'CT' }, items: [], template: 'general', audience: 'en', write });
  await writeTexts({ facts: { brand: 'Rivera', legalName: 'Rivera LLC', city: 'Hartford', state: 'CT' }, items: [], template: 'general', write });
  assert.deepEqual(systems, [SYSTEM_EN, SYSTEM]);
  assert.ok(!/Hispanic|Latino/.test(SYSTEM_EN) && /Hispanic/.test(SYSTEM));
});

test('el seguimiento en español no recoge a los americanos (tendrán el suyo en inglés)', async () => {
  const lead = (id, source) => ({ id, user_id: OWNER, source, name: id, email: `${id}@gmail.com`, status: 'engaged', demo_status: 'ready', instantly_lead_id: `inst-${id}`, engaged_at: '2026-10-10T00:00:00Z', replied_at: null, followup_at: null });
  const db = createMemoryDb({ new_business_leads: [lead('a', 'ct_registry'), lead('c', US_SOURCE), lead('b', MAPS_SOURCE)] });
  const config = loadInstantlyConfig({ ...env, INSTANTLY_CAMPAIGN_ID_FOLLOWUP: '0ce4443c-8693-42df-be0c-cd6ecb88f9b7' }, { dryRun: false, campaign: 'followup' });
  const fetchImpl = async (url, opts) => ({ ok: true, status: 200, json: async () => ({ items: JSON.parse(opts.body).ids.map(id => ({ id, status: 3, campaign: C.llc, email_reply_count: 0 })) }) });
  const r = await moveToFollowup({ db, ownerId: OWNER, config, dryRun: true, fetchImpl });
  assert.equal(r.eligible, 1);
});
