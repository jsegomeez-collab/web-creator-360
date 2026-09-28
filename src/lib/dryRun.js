// Test mode for the outreach campaign: with OUTREACH_DRY_RUN=true emails and Telegram alerts are written to the
// log instead of being sent. Everything else (queue, sequence steps, form, database) behaves as in production.

export const isDryRun = () => String(process.env.OUTREACH_DRY_RUN || '').trim().toLowerCase() === 'true';

// In dry-run the demo step uses a stub page and skips Claude + Vercel, unless this is also set
export const realDemoInDryRun = () => String(process.env.DRY_RUN_REAL_DEMO || '').trim().toLowerCase() === 'true';

const clip = (v) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}… (+${v.length - 300} chars)` : v);

// [dry-run] email {"to":"…","subject":"…"}
export function dryRunLog(kind, details = {}) {
  const safe = Object.fromEntries(Object.entries(details).map(([k, v]) => [k, clip(v)]));
  console.log(`[dry-run] ${kind} ${JSON.stringify(safe)}`);
}
