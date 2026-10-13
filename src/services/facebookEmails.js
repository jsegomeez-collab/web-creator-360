// Emails for Google Maps businesses that have NO website: Maps gives no contact data for them, but many have a Facebook page.
//   1. Google search ("<name> <city> facebook") finds the page   2. a Facebook pages scraper reads its public email/phone
//   3. we only accept the email when the page really is that business (same phone, or the same distinctive name words):
//      the search sometimes returns another business's page, and writing to the wrong business must never happen.
// Both steps run on Apify (loadApifyConfig token). About $0.015 per business looked up; ~20% end up with an email.
import { runActor } from './apify.js';

export const GOOGLE_ACTOR = 'apify~google-search-scraper';
export const FACEBOOK_ACTOR = 'apify~facebook-pages-scraper';

// First path segments of facebook.com that are not a business page
const NOT_A_PAGE = new Set(['public', 'login', 'sharer', 'sharer.php', 'groups', 'events', 'watch', 'marketplace', 'photo', 'photos', 'p', 'hashtag', 'story.php', 'reel', 'reels', 'share', 'plugins', 'dialog', 'permalink.php', 'policies', 'help', 'business', 'ads', 'people', 'l.php', 'tr', 'login.php']);

// Any facebook.com address of a page (even one pointing at /photos or /videos) → the page's own address, or null
export function facebookPageUrl(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.|m\.|es-la\.|mobile\.)?facebook\.com\/(pages\/[^/?#]+\/\d+|[^/?#]+)/i);
  if (!m) return null;
  const first = m[1].split('/')[0].toLowerCase();
  if (NOT_A_PAGE.has(first)) return null;
  return `https://www.facebook.com/${m[1]}`;
}

// The first result that is a Facebook page
export function pageFromSearch(searchItem) {
  for (const r of searchItem?.organicResults || []) {
    const u = facebookPageUrl(r.url);
    if (u) return u;
  }
  return null;
}

const GENERIC = new Set(['the', 'and', 'llc', 'inc', 'corp', 'co', 'ltd', 'el', 'la', 'los', 'las', 'de', 'del', 'y', 'en', 'of', 'at', 'in', 'services', 'service', 'shop', 'store', 'restaurant', 'restaurante', 'taqueria', 'taqueria', 'barber', 'barbershop', 'barbería', 'salon', 'nails', 'nail', 'spa', 'beauty', 'hair', 'cleaning', 'auto', 'repair', 'mexican', 'grill', 'bar', 'cafe', 'bakery', 'panaderia', 'cuts', 'cut', 'studio', 'group', 'company', 'home', 'house', 'express', 'tx', 'fl', 'nj', 'houston', 'miami']);
const words = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !GENERIC.has(w));
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

// Is this Facebook page the Maps business? Same phone number, or they share the distinctive words of the name
// (generic words like "taqueria" or "barbershop" do not count: every business in the street has them).
export function pageMatches(place, page) {
  const phones = [page.phone, ...(page.phones || [])].map(last10).filter(p => p.length === 10);
  const mine = last10(place.phoneUnformatted || place.phone);
  if (mine.length === 10 && phones.includes(mine)) return true;
  const a = new Set(words(place.title || place.name));
  const b = new Set(words([page.title, page.name, page.pageName, String(page.facebookUrl || page.pageUrl || '').split('/').filter(Boolean).pop()].filter(Boolean).join(' ')));
  if (!a.size || !b.size) return false;
  const shared = [...a].filter(w => b.has(w)).length;
  return shared >= Math.max(1, Math.ceil(0.6 * Math.min(a.size, b.size)));
}

const emailOf = (page) => {
  const e = [page.email, ...(page.emails || [])].find(x => typeof x === 'string' && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(x));
  return e ? e.toLowerCase() : null;
};

// places: Apify Maps items (title, city, state, phone…) → { found: Map(placeId → { email, url }), stats }
//   apify: loadApifyConfig() · maxCostUsd caps each of the two Apify runs · fetchImpl / sleep: tests
export async function findFacebookEmails(places, { apify, maxCostUsd = 2, fetchImpl, sleep } = {}) {
  const stats = { searched: places.length, pages: 0, matched: 0, withEmail: 0, costUsd: 0 };
  const found = new Map();
  if (!places.length) return { found, stats };

  const termOf = (p) => `${p.title || p.name} ${p.city || ''} ${p.state || ''} facebook`.replace(/\s+/g, ' ').trim();
  const search = await runActor({ ...apify, actor: GOOGLE_ACTOR }, {
    queries: places.map(termOf).join('\n'), resultsPerPage: 5, maxPagesPerQuery: 1, countryCode: 'us', languageCode: 'en',
  }, { maxCostUsd, fetchImpl, sleep });
  stats.costUsd += search.costUsd || 0;

  const urlOfPlace = new Map();                       // place id → its facebook page
  const byTerm = new Map(places.map(p => [termOf(p), p]));
  for (const item of search.items) {
    const place = byTerm.get(String(item.searchQuery?.term || '').replace(/\s+/g, ' ').trim());
    const url = place && pageFromSearch(item);
    if (url) urlOfPlace.set(place.placeId, { place, url });
  }
  stats.pages = urlOfPlace.size;
  if (!urlOfPlace.size) return { found, stats };

  const urls = [...new Set([...urlOfPlace.values()].map(v => v.url))];
  const pages = await runActor({ ...apify, actor: FACEBOOK_ACTOR }, { startUrls: urls.map(url => ({ url })) }, { maxCostUsd, fetchImpl, sleep });
  stats.costUsd += pages.costUsd || 0;

  // Each page goes to the place whose search found it; it must then pass the "is it really them?" check
  const placeOfUrl = new Map();
  for (const { place, url } of urlOfPlace.values()) placeOfUrl.set(url.toLowerCase(), place);
  for (const page of pages.items) {
    const key = facebookPageUrl(page.facebookUrl || page.pageUrl || page.url)?.toLowerCase();
    // The page's own address can differ from the one searched (a numeric id that redirects to a name): then look for the place by phone/name
    const place = (key && placeOfUrl.get(key)) || [...urlOfPlace.values()].map(v => v.place).find(p => !found.has(p.placeId) && pageMatches(p, page));
    if (!place || found.has(place.placeId) || !pageMatches(place, page)) continue;
    stats.matched++;
    const email = emailOf(page);
    if (email) { found.set(place.placeId, { email, url: key }); stats.withEmail++; }
  }
  return { found, stats };
}
