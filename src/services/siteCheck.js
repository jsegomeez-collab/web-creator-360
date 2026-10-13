// Does the owner's own email domain already have a working website? A new LLC whose email is name@theirdomain.com usually has
// one, and would not buy a demo. Free of charge: it just asks the domain. Personal mailboxes (gmail, yahoo…) are never checked.
// Safe by design: it only asks public domains (never IPs, localhost or addresses that resolve to a private network).
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net',
  'cox.net', 'optonline.net', 'charter.net', 'earthlink.net', 'mail.com', 'gmx.com', 'zoho.com', 'yahoo.es', 'hotmail.es', 'outlook.es',
]);

// A page that exists but is not a business website: a registrar's parking page, a default server page, "coming soon"…
const PLACEHOLDER = /domain (is )?(for sale|parked|may be for sale)|buy this domain|this domain (is|has been) (parked|registered)|parked (free|domain)|account suspended|coming soon|under construction|default web page|welcome to nginx|apache2? (ubuntu )?default|index of \/|website (is )?expired|future home of/i;

const MIN_TEXT = 120;        // less visible text than this: an empty page
const THIN_PAGE = 800;       // under this much visible text, a placeholder phrase means a parked page

// The text a visitor reads: no scripts, styles or tags
export const visibleText = (html) => String(html)
  .replace(/<!--[\s\S]*?-->|<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;|&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();

export const domainOf = (email) => String(email || '').split('@')[1]?.trim().toLowerCase() || '';
export const isFreeMail = (domain) => FREE_MAIL.has(domain);

// Private, loopback, link-local and other non-public addresses
export function isPrivateAddress(ip) {
  if (!isIP(ip)) return true;
  if (ip.includes(':')) return /^(::1?$|fc|fd|fe[89ab]|::ffff:(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

async function isPublicHost(domain, lookup) {
  if (!domain || !domain.includes('.') || isIP(domain) || domain === 'localhost') return false;
  try {
    const addresses = await lookup(domain, { all: true });
    return addresses.length > 0 && addresses.every(a => !isPrivateAddress(a.address));
  } catch { return false; }               // the domain does not resolve: no website
}

// → { has: boolean, reason }
export async function hasWebsite(domain, { fetchImpl = globalThis.fetch, lookup = dns.lookup, timeoutMs = 6000 } = {}) {
  if (!await isPublicHost(domain, lookup)) return { has: false, reason: 'el dominio no responde' };
  for (const url of [`https://${domain}`, `https://www.${domain}`, `http://${domain}`]) {
    try {
      const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteCheck/1.0)', Accept: 'text/html' } });
      if (res.status >= 500) continue;
      // 401/403/429: a real server that does not let a bot in (Cloudflare…): treat as a website
      if ([401, 403, 429].includes(res.status)) return { has: true, reason: `responde (${res.status})` };
      if (res.status >= 400) continue;
      const text = visibleText(String(await res.text()).slice(0, 200_000));
      if (text.length < MIN_TEXT) continue;                                         // an almost empty page
      // "Coming soon", "domain for sale"… only mean a placeholder when the page has hardly any text: a real website often
      // mentions them somewhere (a section, a footer)
      if (text.length < THIN_PAGE && PLACEHOLDER.test(text)) return { has: false, reason: 'página de aparcamiento o en construcción' };
      return { has: true, reason: 'tiene web' };
    } catch { /* timeout, TLS or network error: try the next address */ }
  }
  return { has: false, reason: 'no hay web' };
}

// Splits leads in those worth emailing and those whose own domain already has a website. Personal mailboxes always stay.
//   → { kept, dropped: [{ lead, reason }] }
export async function dropLeadsWithWebsite(leads, { concurrency = 10, ...options } = {}) {
  const verdicts = new Map();                     // domain → result (a domain is asked only once)
  const domains = [...new Set(leads.map(l => domainOf(l.email)).filter(d => d && !isFreeMail(d)))];
  for (let i = 0; i < domains.length; i += concurrency) {
    await Promise.all(domains.slice(i, i + concurrency).map(async (d) => verdicts.set(d, await hasWebsite(d, options))));
  }
  const kept = [], dropped = [];
  for (const lead of leads) {
    const verdict = verdicts.get(domainOf(lead.email));
    if (verdict?.has) dropped.push({ lead, reason: verdict.reason }); else kept.push(lead);
  }
  return { kept, dropped };
}
