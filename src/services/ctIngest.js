// One ingest run: download Connecticut registrations → filter → dedupe → verify emails → store.
// Used by `npm run ct:ingest` and (phase 7) by the daily cron. With dryRun it never writes to the database.
import { CT_SOURCE, fetchRegistrations, classifyRegistrations } from './ctRegistry.js';
import { verifyMany } from './emailVerify.js';
import { getWatermark, recordRun, filterNewLeads, insertLeads } from './newLeads.js';

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

function tally(leads, key) {
  const out = {};
  for (const l of leads) out[l[key]] = (out[l[key]] || 0) + 1;
  return out;
}

export function summarize(leads) {
  const dates = leads.map(l => l.registered_at).filter(Boolean).sort();
  return {
    total: leads.length,
    byPriority: tally(leads, 'priority'),
    bySector: tally(leads, 'sector'),
    latinoStrong: leads.filter(l => l.latino_strong).length,
    minorityOwned: leads.filter(l => l.minority_owned).length,
    oldest: dates[0] ?? null,
    newest: dates.at(-1) ?? null,
  };
}

// Options:
//   db, ownerId   Supabase client + user_id. Required unless dryRun. In dryRun they're only used to read (never write).
//   days          force the window ("last N days"); otherwise: resume from the last run (minus MARGIN_DAYS) or FIRST_RUN_DAYS
//   dryRun        no writes at all
//   latinOnly     keep only leads with a Latino signal (default true)
//   verify        DNS-check the email domains (default true)
//   rows          already-downloaded registry rows (tests / --json), skips the download
//   fetchImpl     replaces fetch for the download; fetchOptions: extra options for fetchRegistrations (pageSize, sleep…)
//   verifyOptions passed to verifyMany (resolver, provider, concurrency)
export async function runCtIngest({
  db = null, ownerId = null, days = null, dryRun = false, latinOnly = true, verify = true,
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
    const { leads: candidates, stats } = classifyRegistrations(raw, { latinOnly });

    // 4. Dedupe against what we already have (existing leads, suppressions, shared emails)
    let fresh = candidates;
    let skipped = { existing: 0, suppressed: 0, emailTaken: 0, batchDuplicate: 0 };
    if (canReadDb) {
      try {
        ({ fresh, skipped } = await filterNewLeads(db, ownerId, CT_SOURCE, candidates));
      } catch (err) {
        if (!dryRun) throw err;
        notes.push(`No se pudo consultar la base de datos (${err.message}): el recuento no descuenta leads ya guardados ni bajas.`);
      }
    } else {
      notes.push('Sin base de datos: el recuento no descuenta leads ya guardados ni bajas.');
    }

    // 5. Verify email domains (only the ones that would enter)
    const verdicts = verify && fresh.length ? await verifyMany(fresh.map(l => l.email), verifyOptions) : new Map();
    const bad = (l) => { const v = verdicts.get(l.email); return v && !v.ok ? v : null; };
    const valid = fresh.filter(l => !bad(l));
    const invalid = fresh.filter(l => bad(l));
    const invalidReasons = {};
    for (const l of invalid) { const r = bad(l).reason; invalidReasons[r] = (invalidReasons[r] || 0) + 1; }
    stats.invalidEmail = invalid.length;

    // 6. Store (never in dry-run)
    let inserted = 0;
    if (!dryRun) {
      inserted = await insertLeads(db, ownerId, CT_SOURCE, fresh, l => (bad(l) ? 'invalid_email' : 'new'));
      await recordRun(db, {
        user_id: ownerId, source: CT_SOURCE, from_date: since, newest_registration: newest,
        fetched: raw.length, inserted, ok: true, stats: { ...stats, skipped, invalidReasons },
      });
    }

    return {
      dryRun, since, watermark, fetched: raw.length, newestRegistration: newest,
      stats, skipped, invalidReasons, notes,
      leads: valid,                       // what enters the queue as status "new"
      invalid,                            // stored as "invalid_email" (not emailed)
      summary: summarize(valid),
      inserted,
    };
  } catch (err) {
    if (!dryRun && canReadDb) {
      // Best effort: leave a trace of the failed run (it never moves the watermark: ok = false)
      await recordRun(db, { user_id: ownerId, source: CT_SOURCE, from_date: since, fetched: 0, inserted: 0, ok: false, error: String(err.message).slice(0, 500) }).catch(() => {});
    }
    throw err;
  }
}
