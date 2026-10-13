// One ingest run: download Connecticut registrations → filter → dedupe → verify emails → store.
// Used by `npm run ct:ingest` and (phase 7) by the daily cron. With dryRun it never writes to the database.
import { CT_SOURCE, fetchRegistrations, classifyRegistrations } from './ctRegistry.js';
import { getWatermark, recordRun, storeLeads, summarizeLeads } from './newLeads.js';
import { US_SOURCE } from './audience.js';
import { dropLeadsWithWebsite } from './siteCheck.js';

export const FIRST_RUN_DAYS = 90;   // first load: last 90 days
export const MARGIN_DAYS = 2;       // later runs re-read the last 2 days (late registrations); dedupe makes it harmless

const isoDay = (d) => d.toISOString().slice(0, 10);

export function daysAgo(days, today = new Date()) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - days);
  return isoDay(d);
}

export function shiftDate(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
}

// Options:
//   db, ownerId   Supabase client + user_id. Required unless dryRun. In dryRun they're only used to read (never write).
//   days          force the window ("last N days"); otherwise: resume from the last run (minus MARGIN_DAYS) or FIRST_RUN_DAYS
//   dryRun        no writes at all
//   latinOnly     keep only leads with a Latino signal (default true)
//   americans     also keep the companies with NO Latino signal, stored apart (source ct_registry_us) for the English campaign
//   checkWebsites drop the owners whose own email domain already has a working website (websiteOptions: fetchImpl, lookup…)
//   verify        DNS-check the email domains (default true)
//   rows          already-downloaded registry rows (tests / --json), skips the download
//   fetchImpl     replaces fetch for the download; fetchOptions: extra options for fetchRegistrations (pageSize, sleep…)
//   verifyOptions passed to verifyMany (resolver, provider, concurrency)
export async function runCtIngest({
  db = null, ownerId = null, days = null, dryRun = false, latinOnly = true, americans = false, checkWebsites = false, websiteOptions = {}, verify = true,
  rows = null, today = new Date(), fetchImpl, fetchOptions = {}, verifyOptions = {},
} = {}) {
  if (!dryRun && (!db || !ownerId)) {
    throw new Error('Falta la base de datos o NEW_LEADS_OWNER_USER_ID: sin ellos solo se puede usar --dry-run');
  }
  const notes = [];
  const canReadDb = !!(db && ownerId);

  // 1. Window
  let watermark = null;
  if (days == null && canReadDb) {
    try {
      watermark = await getWatermark(db, ownerId, CT_SOURCE);
    } catch (err) {
      if (!dryRun) throw err;
      notes.push(`No se pudo leer la última ingesta (${err.message}); se usan los últimos ${FIRST_RUN_DAYS} días.`);
    }
  }
  const since = days != null ? daysAgo(days, today)
    : watermark ? shiftDate(watermark, -MARGIN_DAYS)
    : daysAgo(FIRST_RUN_DAYS, today);

  try {
    // 2. Download
    const raw = rows ?? await fetchRegistrations({ since, fetchImpl, ...fetchOptions });
    const newest = raw.reduce((max, r) => { const d = String(r.date_registration ?? '').slice(0, 10); return d > max ? d : max; }, '') || null;

    // 3. Filter (port of the Python script)
    // With "americans" on, the companies with no Latino signal are kept too and go to their own source (English campaign)
    const { leads: classified, stats } = classifyRegistrations(raw, { latinOnly: latinOnly && !americans });

    // 3b. Owners whose own email domain already has a working website are not worth a demo
    let candidates = classified;
    if (checkWebsites) {
      const checked = await dropLeadsWithWebsite(classified, websiteOptions);
      candidates = checked.kept;
      stats.alreadyHasWebsite = checked.dropped.length;
    }
    const latinos = candidates.filter(l => l.latino_signal);
    const us = americans ? candidates.filter(l => !l.latino_signal) : [];

    // 4. Dedupe, verify email domains and store (never writes in dry-run); each group in its own source = its own campaign
    const stored = await storeLeads({ db: canReadDb ? db : null, ownerId, source: CT_SOURCE, candidates: latinos, dryRun, verify, verifyOptions });
    const storedUs = americans ? await storeLeads({ db: canReadDb ? db : null, ownerId, source: US_SOURCE, candidates: us, dryRun, verify, verifyOptions }) : null;
    stats.invalidEmail = stored.invalid.length + (storedUs?.invalid.length || 0);
    notes.push(...stored.notes, ...(storedUs?.notes || []));
    const insertedTotal = stored.inserted + (storedUs?.inserted || 0);
    if (!dryRun) {
      await recordRun(db, {
        user_id: ownerId, source: CT_SOURCE, from_date: since, newest_registration: newest,
        fetched: raw.length, inserted: insertedTotal, ok: true,
        stats: { ...stats, skipped: stored.skipped, invalidReasons: stored.invalidReasons, ...(storedUs ? { americans: { inserted: storedUs.inserted, skipped: storedUs.skipped } } : {}) },
      });
    }

    return {
      dryRun, since, watermark, fetched: raw.length, newestRegistration: newest,
      stats, skipped: stored.skipped, invalidReasons: stored.invalidReasons, notes,
      leads: stored.valid,                // what enters as status "new"
      invalid: stored.invalid,            // stored as "invalid_email" (not emailed)
      summary: summarizeLeads(stored.valid),
      inserted: insertedTotal,                // both groups
      insertedAmericans: storedUs?.inserted || 0,
      americans: storedUs && {
        leads: storedUs.valid, invalid: storedUs.invalid, skipped: storedUs.skipped, invalidReasons: storedUs.invalidReasons, summary: summarizeLeads(storedUs.valid),
        inserted: storedUs.inserted,
      },
    };
  } catch (err) {
    if (!dryRun && canReadDb) {
      // Best effort: leave a trace of the failed run (it never moves the watermark: ok = false)
      await recordRun(db, { user_id: ownerId, source: CT_SOURCE, from_date: since, fetched: 0, inserted: 0, ok: false, error: String(err.message).slice(0, 500) }).catch(() => {});
    }
    throw err;
  }
}
