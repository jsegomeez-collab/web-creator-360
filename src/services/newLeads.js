// Persistence for new_business_leads / email_suppressions / lead_ingest_runs.
// `db` is a Supabase client (injected so it can be tested). Every row carries user_id (multi-tenant).
import { randomBytes } from 'crypto';

// `businesses.source` of the rows created for these leads: the Google Places pipeline never touches them
export const LEAD_BUSINESS_SOURCE = 'new_business_lead';

// Supabase filters put `in (...)` lists in the URL: keep them short
const CHUNK = 150;
function* chunks(arr, size = CHUNK) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

function fail(step, error) {
  const err = new Error(`${step}: ${error.message}`);
  err.step = step;
  return err;
}

// Unguessable URL-safe token for /f/:token and /u/:token
export const newFormToken = () => randomBytes(18).toString('base64url');

// ─── Ingest bookkeeping ──────────────────────────────────────────────────────

// Newest registration date seen by the last successful run (YYYY-MM-DD) or null on a first run
export async function getWatermark(db, ownerId, source) {
  const { data, error } = await db
    .from('lead_ingest_runs')
    .select('newest_registration')
    .eq('user_id', ownerId)
    .eq('source', source)
    .eq('ok', true)
    .not('newest_registration', 'is', null)
    .order('ran_at', { ascending: false })
    .limit(1);
  if (error) throw fail('leer la última ingesta', error);
  return data?.[0]?.newest_registration ?? null;
}

export async function recordRun(db, run) {
  const { error } = await db.from('lead_ingest_runs').insert(run);
  if (error) throw fail('guardar la ingesta', error);
}

// ─── Dedupe against what we already have ─────────────────────────────────────

// Splits candidates into `fresh` (safe to insert) and counts of what was skipped and why:
//   existing   → same source + external_id already stored
//   suppressed → email is in email_suppressions (unsubscribed, bounced, agency…)
//   emailTaken → same email already belongs to another lead of this user (would be emailed twice)
//   batchDuplicate → same email twice in this batch (the most recent company is kept)
export async function filterNewLeads(db, ownerId, source, candidates) {
  const skipped = { existing: 0, suppressed: 0, emailTaken: 0, batchDuplicate: 0 };
  if (!candidates.length) return { fresh: [], skipped };

  const emails = [...new Set(candidates.map(c => c.email))];
  const externalIds = [...new Set(candidates.map(c => c.external_id))];

  const suppressed = new Set();
  for (const part of chunks(emails)) {
    const { data, error } = await db.from('email_suppressions').select('email').eq('user_id', ownerId).in('email', part);
    if (error) throw fail('consultar supresiones', error);
    (data || []).forEach(r => suppressed.add(r.email));
  }

  const existingIds = new Set();
  const existingEmails = new Set();
  for (const part of chunks(externalIds)) {
    const { data, error } = await db.from('new_business_leads').select('external_id, email').eq('user_id', ownerId).eq('source', source).in('external_id', part);
    if (error) throw fail('consultar leads existentes', error);
    (data || []).forEach(r => existingIds.add(r.external_id));
  }
  for (const part of chunks(emails)) {
    const { data, error } = await db.from('new_business_leads').select('email').eq('user_id', ownerId).in('email', part);
    if (error) throw fail('consultar emails existentes', error);
    (data || []).forEach(r => existingEmails.add(r.email));
  }

  const seenInBatch = new Set();
  const fresh = [];
  for (const c of candidates) {                     // candidates arrive newest-first
    if (existingIds.has(c.external_id)) { skipped.existing++; continue; }
    if (suppressed.has(c.email)) { skipped.suppressed++; continue; }
    if (existingEmails.has(c.email)) { skipped.emailTaken++; continue; }
    if (seenInBatch.has(c.email)) { skipped.batchDuplicate++; continue; }
    seenInBatch.add(c.email);
    fresh.push(c);
  }
  return { fresh, skipped };
}

// ─── Insert ──────────────────────────────────────────────────────────────────

// `status` per lead: 'new' normally, 'invalid_email' when the domain can't receive mail.
// Upsert with ignoreDuplicates makes a re-run (or a race with another run) harmless.
export async function insertLeads(db, ownerId, source, leads, statusOf = () => 'new') {
  if (!leads.length) return 0;
  const rows = leads.map(l => ({
    user_id: ownerId,
    source,
    external_id: l.external_id,
    name: l.name,
    email: l.email,
    city: l.city,
    zip: l.zip,
    address: l.address,
    registered_at: l.registered_at,
    naics_code: l.naics_code,
    sector: l.sector,
    priority: l.priority,
    latino_signal: l.latino_signal,
    latino_strong: l.latino_strong,
    minority_owned: l.minority_owned,
    notes: l.notes,
    status: statusOf(l),
    form_token: newFormToken(),
  }));
  for (const part of chunks(rows, 200)) {
    const { error } = await db.from('new_business_leads').upsert(part, { onConflict: 'user_id,source,external_id', ignoreDuplicates: true });
    if (error) throw fail('insertar leads', error);
  }
  return rows.length;
}
