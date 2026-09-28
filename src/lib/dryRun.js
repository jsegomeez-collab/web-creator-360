// Test mode for the outreach campaign: with OUTREACH_DRY_RUN=true the push to Instantly and the Telegram alerts are written
// to the log instead of being sent. Everything else (database, webhooks, tracked links) behaves as in production.

export const isDryRun = () => String(process.env.OUTREACH_DRY_RUN || '').trim().toLowerCase() === 'true';

const clip = (v) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}… (+${v.length - 300} chars)` : v);

// [dry-run] instantly.push {"leads":12,"campaign":"…"}
export function dryRunLog(kind, details = {}) {
  const safe = Object.fromEntries(Object.entries(details).map(([k, v]) => [k, clip(v)]));
  console.log(`[dry-run] ${kind} ${JSON.stringify(safe)}`);
}
