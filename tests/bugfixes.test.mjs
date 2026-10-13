// Pipeline automático de Google Maps: etapa de análisis (Supabase simulado). Los emails los envía Instantly, no esta app.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './helpers/fakeSupabase.mjs';

const src = (p) => new URL(`../src/${p}`, import.meta.url).href;

const db = createFakeDb();
let profile;
const reset = () => { db.reset(); profile = {}; delete process.env.NEW_LEADS_OWNER_USER_ID; };
reset();
beforeEach(reset);

mock.module(src('db/supabase.js'), { exports: { default: db } });
mock.module(src('services/businessProfile.js'), { exports: { scrapeBusinessProfile: async () => profile } });
mock.module(src('services/claude.js'), { exports: { generateWebsite: async () => '<html></html>' } });
mock.module(src('services/vercel.js'), { exports: { deployToVercel: async () => 'https://x.vercel.app' } });

const { runAutoPipeline } = await import(src('pipeline/auto.js'));

// ─── runAutoPipeline ─────────────────────────────────────────────────────────
// sleep() de 3 s → inmediato y reloj fijo en lunes 10:00. Solo durante estas pruebas: hacerlo global rompería fetch/http.
async function withFakeClock(fn) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => { cb(); return 0; };
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-28T10:00:00') });
  try { return await fn(); } finally { globalThis.setTimeout = realSetTimeout; mock.timers.reset(); }
}

function seedPipeline({ prospected = [], previewSites = [], webData = null, business = null }) {
  db.handlers.businesses = ctx => {
    if (ctx.op !== 'select') return null;
    if (ctx.filters.status === 'prospected') return prospected;
    if (ctx.filters.status === 'scraped') return [];
    if (ctx.filters.id) return business ? [business] : [];
    return [];
  };
  db.handlers.generated_sites = ctx => (ctx.op === 'select' && ctx.filters.status === 'preview' ? previewSites : null);
  db.handlers.outreach_log = ctx => (ctx.op === 'select' ? [] : null);
  db.handlers.business_web_data = () => webData;
}

test('pipeline scrape: guarda el perfil y pasa el negocio a "scraped" sin tocar su teléfono de Google Places', async () => {
  profile = { description: 'd', services: [], social_networks: [], hours: null, language: 'es', email: 'x@y.com', value_proposition: 'v' };
  seedPipeline({ prospected: [{ id: 'b1', name: 'Coolfy', website: 'https://x.es' }] });
  const stats = await withFakeClock(() => runAutoPipeline());
  assert.equal(stats.scraped, 1);
  assert.deepEqual(db.writes('businesses', 'update')[0].payload, { status: 'scraped' });
  assert.equal(db.writes('business_web_data', 'upsert')[0].payload.email, 'x@y.com');
});
