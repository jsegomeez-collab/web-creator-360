// Email verification before a lead enters the queue.
//   1. Syntax.
//   2. DNS: the domain must be able to receive mail (MX record, or an A/AAAA record as RFC 5321 fallback).
//   3. Optional external provider hook (EMAIL_VERIFIER_API_KEY) — not implemented yet, see verifyWithProvider().
//
// DNS only proves the DOMAIN exists: it cannot tell whether the mailbox does (that needs a provider, or a bounce).
import { Resolver } from 'dns/promises';

const SYNTAX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Codes that mean "this domain has no such record"; anything else (timeouts, SERVFAIL…) is transient and never rejects a lead
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA']);

let defaultResolver;
function getDefaultResolver() {
  if (!defaultResolver) defaultResolver = new Resolver({ timeout: 4000, tries: 2 });
  return defaultResolver;
}

// Domain → { at, promise }: a batch has hundreds of gmail.com addresses, but the cron process lives for days,
// so entries expire and transient DNS failures are never kept.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const domainCache = new Map();
export const clearDomainCache = () => domainCache.clear();

async function checkDomain(domain, resolver) {
  // MX
  try {
    const mx = await resolver.resolveMx(domain);
    if (mx.length) {
      // RFC 7505 "null MX": a single record with an empty exchange means "this domain accepts no mail"
      const isNullMx = mx.length === 1 && (mx[0].exchange === '' || mx[0].exchange === '.');
      return isNullMx ? { ok: false, reason: 'no_mx' } : { ok: true, reason: 'mx' };
    }
  } catch (err) {
    if (!NO_RECORD.has(err.code)) return { ok: true, reason: 'dns_unverified', detail: err.code };
  }

  // No MX → mail servers fall back to the domain's A/AAAA record
  for (const lookup of ['resolve4', 'resolve6']) {
    try {
      const addrs = await resolver[lookup](domain);
      if (addrs.length) return { ok: true, reason: 'a_record' };
    } catch (err) {
      if (!NO_RECORD.has(err.code)) return { ok: true, reason: 'dns_unverified', detail: err.code };
    }
  }
  return { ok: false, reason: 'no_mx' };
}

// Hook for a paid verifier (ZeroBounce, NeverBounce, Kickbox…). Return { ok: boolean, reason: string } or null to skip.
// Not implemented: with the key set it only warns once, so nothing silently pretends to be verified.
let warned = false;
export async function verifyWithProvider(/* email */) {
  if (!process.env.EMAIL_VERIFIER_API_KEY) return null;
  if (!warned) { warned = true; console.warn('[email-verify] EMAIL_VERIFIER_API_KEY está definida pero no hay proveedor implementado en verifyWithProvider(): se ignora'); }
  return null;
}

// → { ok, reason }   reason: 'syntax' | 'no_mx' | 'mx' | 'a_record' | 'dns_unverified' | 'provider:<reason>'
export async function verifyEmail(email, { resolver = getDefaultResolver(), provider = verifyWithProvider } = {}) {
  const value = String(email ?? '').trim().toLowerCase();
  const [local, domain] = value.split('@');
  if (!SYNTAX_RE.test(value) || value.length > 254 || (local || '').length > 64) return { ok: false, reason: 'syntax' };

  let entry = domainCache.get(domain);
  if (!entry || Date.now() - entry.at > CACHE_TTL_MS) {
    entry = { at: Date.now(), promise: checkDomain(domain, resolver) };
    domainCache.set(domain, entry);
  }
  const verdict = await entry.promise;
  if (verdict.reason === 'dns_unverified') domainCache.delete(domain);   // transient: look it up again next time
  if (!verdict.ok) return verdict;

  const external = await provider(value);
  if (external && external.ok === false) return { ok: false, reason: `provider:${external.reason || 'rejected'}` };
  return verdict;
}

// Verify many emails with limited concurrency. → Map(email → verdict)
export async function verifyMany(emails, { concurrency = 10, ...opts } = {}) {
  const unique = [...new Set(emails.map(e => String(e ?? '').trim().toLowerCase()))];
  const results = new Map();
  let next = 0;
  async function worker() {
    while (next < unique.length) {
      const email = unique[next++];
      results.set(email, await verifyEmail(email, opts));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return results;
}
