// Campaign 2: Google Maps businesses WITHOUT a website (any owner; Latino owners are only flagged), emailed in English.
//   Apify searches Maps in cities of FL / TX / NJ → we keep what has no website, is open, is not a chain and has real reviews
//   → Maps gives no contact data for them, so the email comes from their Facebook page (services/facebookEmails.js, checked
//   to be the same business) → DNS check → stored as source "gmaps".
// From there it is the same machine as the LLC leads: demo website, Instantly (its own campaign), funnel, panel.
import { runActor, loadApifyConfig } from './apify.js';
import { findFacebookEmails } from './facebookEmails.js';
import { storeLeads, recordRun, summarizeLeads } from './newLeads.js';
import { senalesLatinas, limpiar, DOMINIOS_GESTORIA } from './ctRegistry.js';
import { pickRun } from './mapsZones.js';

import { MAPS_SOURCE } from './audience.js';
export { MAPS_SOURCE };
export const MIN_REVIEWS = 5;
export const MIN_RATING = 3.5;
export const DEFAULT_LOOKUPS = 60;      // Facebook lookups per run (≈ $0.015 each)

const CHAINS = /mcdonald|burger king|starbucks|domino|kfc|subway|walmart|walgreens|cvs\b|7-eleven|taco bell|chipotle|wendy|pizza hut|popeyes|dunkin|jiffy lube|midas|pep boys|autozone|o'reilly|great clips|sport clips|h&r block|jackson hewitt|liberty tax|western union|moneygram/i;
const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const BAD_EMAIL = /\.(png|jpe?g|gif|webp|svg)$|^(noreply|no-reply|donotreply)@|@(sentry|wixpress|example|domain|email|yourdomain|godaddy)\b|@.*\.(gov|edu)$/i;
const SPANISH_LISTING = /espa[ñn]ol|spanish/i;

// Every email-looking text anywhere in the item, best first: not a generic mailbox. Reviews and other free texts are skipped:
// they are written by customers.
const SKIP_KEYS = new Set(['reviews', 'reviewsDistribution', 'reviewsTags', 'imageUrls', 'images', 'popularTimesHistogram', 'peopleAlsoSearch', 'placesTags', 'questionsAndAnswers']);
export function extractEmails(item) {
  const found = [];
  const walk = (v, key = '') => {
    if (v == null || SKIP_KEYS.has(key)) return;
    if (typeof v === 'string') { for (const m of v.match(EMAIL_RE) || []) found.push(m.toLowerCase()); return; }
    if (Array.isArray(v)) { v.forEach(x => walk(x, key)); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(item);
  const unique = [...new Set(found)].filter(e => !BAD_EMAIL.test(e) && !DOMINIOS_GESTORIA.test(e));
  const generic = /^(info|contact|contacto|hello|hola|admin|sales|ventas|support|office)@/;
  return unique.sort((a, b) => Number(generic.test(a)) - Number(generic.test(b)));
}

// Latino signals of a Maps place (only a flag in the panel, never a filter unless asked): Spanish words in the name, a surname
// in the email, or "Spanish" in the listing details
export function latinSignals(item, email) {
  const base = senalesLatinas(item.title || item.name, email || '');
  const reasons = [...base.reasons];
  if (SPANISH_LISTING.test(JSON.stringify(item.additionalInfo ?? ''))) reasons.push('ficha: español');
  return { reasons, strong: base.nameMatch || reasons.some(r => r.startsWith('ficha')) };
}

// One Apify item → { lead } (email = null when we don't have it yet) or { skip: reason }
//   requireEmail: skip places without email · requireLatino: skip places without any Latino signal (off by default)
export function classifyPlace(item, { zone, category, minReviews = MIN_REVIEWS, minRating = MIN_RATING, requireEmail = true, requireLatino = false } = {}) {
  const name = String(item.title || item.name || '').trim();
  if (!name || !(item.placeId || item.cid)) return { skip: 'sin nombre o id' };
  if (item.website) return { skip: 'tiene web' };
  if (item.permanentlyClosed || item.temporarilyClosed) return { skip: 'cerrado' };
  if (CHAINS.test(name)) return { skip: 'cadena' };
  const reviews = Number(item.reviewsCount ?? 0), rating = Number(item.totalScore ?? 0);
  if (reviews < minReviews) return { skip: 'pocas reseñas' };
  if (rating && rating < minRating) return { skip: 'puntuación baja' };
  const [email = null] = extractEmails(item);
  if (!email && requireEmail) return { skip: 'sin email' };
  const signals = latinSignals(item, email);
  if (requireLatino && !signals.reasons.length) return { skip: 'sin señal latina' };

  return { lead: leadFromPlace(item, { zone, category, email, signals, name, reviews, rating }) };
}

function leadFromPlace(item, { zone, category, email, signals, name, reviews, rating }) {
  return {
    external_id: String(item.placeId || item.cid),
    name,
    email,
    city: item.city || zone?.query?.split(',')[0] || null,
    zip: item.postalCode || null,
    address: item.address || null,
    state: item.state || zone?.state || null,
    business_phone: item.phoneUnformatted || item.phone || null,
    rating: rating || null,
    reviews,
    maps_url: item.url || null,
    category: item.categoryName || (item.categories || [])[0] || null,
    registered_at: null,
    naics_code: null,
    sector: category?.sector || 'otro',
    priority: category?.sector && category.sector !== 'otro' ? 'A' : 'B',
    latino_signal: signals.reasons.length > 0,
    latino_strong: signals.strong,
    minority_owned: false,
    notes: `Maps${signals.reasons.length ? ` · ${signals.reasons.join(', ')}` : ''}`,
  };
}

// The Apify input: one search per category in the zone, English results, only places WITHOUT website
export function buildInput({ zone, categories, maxPerSearch = 40 }) {
  return {
    searchStringsArray: categories.map(c => c.search),
    locationQuery: zone.query,
    countryCode: 'us',
    language: 'en',
    maxCrawledPlacesPerSearch: maxPerSearch,
    website: 'withoutWebsite',
    skipClosedPlaces: true,
    maxReviews: 0,
    maxImages: 0,
  };
}

// Which place came from which search: the item says so in `searchString`
const categoryOf = (item, categories) => categories.find(c => limpiar(c.search) === limpiar(item.searchString)) ?? null;

// One run of the campaign. By default it takes the next (zone, categories) of the rotation (the count of earlier runs is the cursor).
//   zone / categories   force them instead of the rotation · maxPerSearch caps places per search (cost) · maxCostUsd hard cap in Apify
//   lookups             how many places without email get their Facebook page searched (0 = none) · requireLatino: only Latino-signal places
//   items               already-downloaded Apify items (tests / previews: skips the Maps search) · facebook: replaces the Facebook step (tests)
export async function runMapsProspect({
  db = null, ownerId = null, zone = null, categories = null, maxPerSearch = 40, maxCostUsd = 5, lookups = DEFAULT_LOOKUPS, requireLatino = false,
  dryRun = false, verify = true, items = null, facebook = findFacebookEmails, apify = loadApifyConfig(), fetchImpl, sleep, verifyOptions = {},
} = {}) {
  if (!dryRun && (!db || !ownerId)) throw new Error('Falta la base de datos o NEW_LEADS_OWNER_USER_ID: sin ellos solo se puede usar vista previa');

  let picked = { zone, categories };
  if (!zone || !categories) {
    let cursor = 0;
    if (db && ownerId) {
      const { count } = await db.from('lead_ingest_runs').select('id', { count: 'exact', head: true }).eq('user_id', ownerId).eq('source', MAPS_SOURCE);
      cursor = count || 0;
    }
    picked = { ...pickRun(cursor), ...(zone ? { zone } : {}), ...(categories ? { categories } : {}) };
  }

  try {
    let costUsd = 0, raw = items;
    if (!raw) { const r = await runActor(apify, buildInput({ ...picked, maxPerSearch }), { maxCostUsd, fetchImpl, sleep }); raw = r.items; costUsd += r.costUsd || 0; }

    const skips = {};
    const candidates = [];                       // { item, category, lead }
    for (const item of raw) {
      const category = categoryOf(item, picked.categories);
      const r = classifyPlace(item, { zone: picked.zone, category, requireEmail: false, requireLatino: false });
      if (r.lead) candidates.push({ item, category, lead: r.lead }); else skips[r.skip] = (skips[r.skip] || 0) + 1;
    }

    // Places without an email: look for their Facebook page (the ones with most reviews first: the most established businesses)
    const needEmail = candidates.filter(c => !c.lead.email).sort((a, b) => b.lead.reviews - a.lead.reviews);
    const toLookUp = needEmail.slice(0, Math.max(0, lookups));
    skips['sin email (no buscado)'] = needEmail.length - toLookUp.length || undefined;
    let facebookStats = null;
    if (toLookUp.length) {
      const { found, stats } = await facebook(toLookUp.map(c => c.item), { apify, maxCostUsd: Math.max(0.5, toLookUp.length * 0.03), fetchImpl, sleep });
      facebookStats = stats; costUsd += stats.costUsd || 0;
      for (const c of toLookUp) {
        const hit = found.get(c.item.placeId);
        if (!hit || BAD_EMAIL.test(hit.email) || DOMINIOS_GESTORIA.test(hit.email)) continue;
        c.lead.email = hit.email;
        const signals = latinSignals(c.item, hit.email);   // the surname in the email can now count
        Object.assign(c.lead, { latino_signal: signals.reasons.length > 0, latino_strong: signals.strong, notes: `Maps · Facebook${signals.reasons.length ? ` · ${signals.reasons.join(', ')}` : ''}` });
      }
    }

    const withEmail = [];
    for (const c of candidates) {
      if (!c.lead.email) { if (toLookUp.includes(c)) skips['sin email'] = (skips['sin email'] || 0) + 1; continue; }
      if (requireLatino && !c.lead.latino_signal) { skips['sin señal latina'] = (skips['sin señal latina'] || 0) + 1; continue; }
      withEmail.push(c.lead);
    }
    for (const k of Object.keys(skips)) if (!skips[k]) delete skips[k];

    const stored = await storeLeads({ db, ownerId, source: MAPS_SOURCE, candidates: withEmail, dryRun, verify, verifyOptions });
    const stats = {
      zone: picked.zone.query, categories: picked.categories.map(c => c.search), places: raw.length, skips, skipped: stored.skipped,
      invalidReasons: stored.invalidReasons, facebook: facebookStats, costUsd: costUsd || null,
    };
    if (!dryRun) await recordRun(db, { user_id: ownerId, source: MAPS_SOURCE, fetched: raw.length, inserted: stored.inserted, ok: true, stats });
    return { dryRun, ...stats, inserted: stored.inserted, leads: stored.valid, invalid: stored.invalid, summary: summarizeLeads(stored.valid), notes: stored.notes };
  } catch (err) {
    if (!dryRun && db && ownerId) await recordRun(db, { user_id: ownerId, source: MAPS_SOURCE, fetched: 0, inserted: 0, ok: false, error: String(err.message).slice(0, 500) }).catch(() => {});
    throw err;
  }
}
