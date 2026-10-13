// Instantly's plan (Growth) allows 1,000 leads in the workspace. Leads that have finished their emails keep taking a slot, so the oldest
// ones are removed from Instantly — only as many as needed to keep some free slots — and ONLY the ones that can no longer matter:
//   TIER 1  emailed, never opened their website, never replied, not in the follow-up, and sent 8+ days ago (oldest first)
//   TIER 2  (only if tier 1 is not enough) bounced, unsubscribed, rejected or invalid email
//   NEVER   opened the website · replied · asked for a call · in the follow-up · not sent yet · still in an active sequence
// The history stays in our database (status, dates, demo); only `instantly_lead_id` is emptied. If a removed lead opens its website
// later, the follow-up adds it to Instantly again (services/followup.js).
import { API } from './instantly.js';
import { requestJson } from '../lib/http.js';
import { selectAll } from '../lib/selectAll.js';
import { isDryRun } from '../lib/dryRun.js';

const TABLE = 'new_business_leads';
export const MIN_AGE_DAYS = 8;        // the first email promised the website for 7 days
export const KEEP_FREE = 250;         // free slots to keep (about two days of uploads)
export const MAX_PER_RUN = 200;
const MAX_ROUNDS = 5;
const IDS_PER_REQUEST = 100;
const FINISHED = new Set([3, -1, -2]);                      // Instantly Lead.status: Completed, Bounced, Unsubscribed
const DAY = 86_400_000;

const authHeader = (config) => ({ Authorization: `Bearer ${config.apiKey}` });

// → { limit, count, free }  (what the plan allows and what is used)
export async function leadHeadroom(config, { fetchImpl } = {}) {
  const plan = await requestJson({ service: 'Instantly', url: `${API}/workspace-billing/plan-details`, headers: authHeader(config), fetchImpl, hint401: '(¿INSTANTLY_API_KEY correcta?)' });
  const outreach = plan.subscriptions?.outreach || {};
  const limit = Number(outreach.total_lead_limit), count = Number(outreach.current_lead_count);
  if (!Number.isFinite(limit) || !Number.isFinite(count)) throw new Error('Instantly no dijo cuántos leads permite el plan');
  return { limit, count, free: limit - count };
}

const tier1 = (db, ownerId, cutoffIso, max) => selectAll(() => db.from(TABLE).select('*').eq('user_id', ownerId).eq('status', 'emailed')
  .is('engaged_at', null).is('replied_at', null).is('followup_at', null).not('instantly_lead_id', 'is', null).lte('emailed_at', cutoffIso)
  .order('emailed_at', { ascending: true }).order('id'), { max });

const tier2 = (db, ownerId, max) => selectAll(() => db.from(TABLE).select('*').eq('user_id', ownerId)
  .in('status', ['bounced', 'unsubscribed', 'rejected', 'invalid_email']).not('instantly_lead_id', 'is', null)
  .order('updated_at', { ascending: true }).order('id'), { max });

// Removes `leads` from Instantly after checking each one there; returns how many were removed / already gone / kept.
async function removeFromInstantly({ db, config, leads, needsFinishedCheck, fetchImpl, dryRun }) {
  const out = { removed: 0, alreadyGone: 0, kept: 0 };
  const state = new Map();
  for (let i = 0; i < leads.length; i += IDS_PER_REQUEST) {
    const ids = leads.slice(i, i + IDS_PER_REQUEST).map(l => l.instantly_lead_id);
    const r = await requestJson({ service: 'Instantly', url: `${API}/leads/list`, method: 'POST', headers: authHeader(config), body: { ids, limit: ids.length }, fetchImpl });
    for (const x of r.items || []) state.set(x.id, x);
  }
  const stamp = new Date().toISOString();
  const forget = (lead) => db.from(TABLE).update({ instantly_lead_id: null, updated_at: stamp }).eq('id', lead.id);
  for (const lead of leads) {
    const x = state.get(lead.instantly_lead_id);
    if (!x) {                                               // not in Instantly any more: just forget the stale id
      if (!dryRun) await forget(lead);
      out.alreadyGone++;
      continue;
    }
    // Only leads Instantly itself shows as finished, and that never replied (a reply we have not synced yet must survive)
    if ((needsFinishedCheck && !FINISHED.has(x.status)) || (x.email_reply_count || 0) > 0) { out.kept++; continue; }
    if (dryRun) { out.removed++; continue; }
    // DELETE must go WITHOUT a content-type header
    const res = await (fetchImpl || globalThis.fetch)(`${API}/leads/${lead.instantly_lead_id}`, { method: 'DELETE', headers: authHeader(config) });
    if (res.ok || res.status === 404) { await forget(lead); out.removed++; } else out.kept++;
  }
  return out;
}

// → { dryRun, free, need, removed, alreadyGone, kept, tier1, tier2, skipped? }
//   force: ignore the free-slot target and clean up to `max` (the manual button/script)
export async function cleanupInstantly({ db, ownerId, config, minAgeDays = MIN_AGE_DAYS, keepFree = KEEP_FREE, max = MAX_PER_RUN, force = false, dryRun = isDryRun(), fetchImpl, now = new Date() }) {
  const { free } = await leadHeadroom(config, { fetchImpl });
  const need = force ? max : Math.min(max, Math.max(0, keepFree - free));
  const result = { dryRun, free, need, removed: 0, alreadyGone: 0, kept: 0, tier1: 0, tier2: 0 };
  if (need <= 0) return { ...result, skipped: `hay ${free} huecos libres (se limpia por debajo de ${keepFree})` };

  const cutoff = new Date(now.getTime() - minAgeDays * DAY).toISOString();
  // Stale ids use up part of a round without freeing anything (and are forgotten right away), so another round fetches the next ones.
  // In a preview nothing is forgotten, so a second round would return the same leads: one round only.
  const a = { removed: 0, alreadyGone: 0, kept: 0 };
  const seen = new Set();                                    // kept leads stay in the query: skip the ones already checked
  for (let round = 0; round < MAX_ROUNDS && a.removed < need; round++) {
    const batch = await tier1(db, ownerId, cutoff, need - a.removed + seen.size);
    const fresh = batch.filter(l => !seen.has(l.id)).slice(0, need - a.removed);
    fresh.forEach(l => seen.add(l.id));
    if (!fresh.length) break;
    const r = await removeFromInstantly({ db, config, leads: fresh, needsFinishedCheck: true, fetchImpl, dryRun });
    a.removed += r.removed; a.alreadyGone += r.alreadyGone; a.kept += r.kept;
    if (dryRun || (!r.alreadyGone && !r.kept)) break;
  }
  Object.assign(result, { tier1: a.removed, removed: a.removed, alreadyGone: a.alreadyGone, kept: a.kept });

  // A stale id (the lead is no longer in Instantly) frees nothing: only `removed` counts towards the target
  const left = need - a.removed;
  if (left > 0) {
    const second = await tier2(db, ownerId, left);
    const b = await removeFromInstantly({ db, config, leads: second, needsFinishedCheck: false, fetchImpl, dryRun });
    Object.assign(result, { tier2: b.removed, removed: a.removed + b.removed, alreadyGone: a.alreadyGone + b.alreadyGone, kept: a.kept + b.kept });
  }
  return result;
}
