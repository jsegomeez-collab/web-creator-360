// What happened in Instantly with the leads we already pushed: sent, bounced, unsubscribed or replied. Instantly's
// webhooks need a paid plan (Hypergrowth+); its API (POST /leads/list) works on every plan, so we ask it instead — every
// few minutes from the campaign server's cron, or on demand from the dashboard's "Comprobar ahora" button.
import { API } from './instantly.js';
import { requestJson } from '../lib/http.js';
import { selectAll } from '../lib/selectAll.js';
import { suppress } from './suppressions.js';

const TABLE = 'new_business_leads';
const IDS_PER_REQUEST = 100;                 // matches the API's own page size limit (`limit` is capped at 100)

// Leads worth asking Instantly about: pushed to it, and not yet at a point where nothing more can happen to them
// (a reply can still arrive after "engaged"/"requested"; once "called" you've already read Instantly's inbox yourself)
export const POLLABLE_STATUSES = ['queued', 'emailed', 'engaged', 'requested'];
const BEFORE_ENGAGING = new Set(['queued', 'emailed']);

// Instantly's Lead.status: 1 Active, 2 Paused, 3 Completed, -1 Bounced, -2 Unsubscribed, -3 Skipped
const BOUNCED = -1;
const UNSUBSCRIBED = -2;

// What changed for one lead → { patch, suppressAs, repliedNow }. `dbLead` is our row, `instLead` is Instantly's.
export function effectOf(dbLead, instLead, at) {
  const patch = {};
  let suppressAs = null;

  if (instLead.status === BOUNCED) {
    if (BEFORE_ENGAGING.has(dbLead.status)) patch.status = 'bounced';
    suppressAs = 'bounced';
  } else if (instLead.status === UNSUBSCRIBED) {
    if (BEFORE_ENGAGING.has(dbLead.status)) patch.status = 'unsubscribed';
    suppressAs = 'unsubscribed';
  } else if (dbLead.status === 'queued' && instLead.timestamp_last_contact) {
    patch.status = 'emailed';
    patch.emailed_at = instLead.timestamp_last_contact;
  }

  const repliedNow = (instLead.email_reply_count || 0) > 0 && !dbLead.replied_at;
  if (repliedNow) {
    patch.replied_at = instLead.timestamp_last_reply || at;
    if (!patch.status && BEFORE_ENGAGING.has(dbLead.status)) patch.status = 'replied';
  }
  return { patch, suppressAs, repliedNow };
}

const call = (config, path, body, opts) => requestJson({
  service: 'Instantly', url: `${API}${path}`, method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}` }, body,
  hint401: '(¿INSTANTLY_API_KEY correcta?)', ...opts,
});

// db: Supabase client · ownerId: NEW_LEADS_OWNER_USER_ID · config: loadInstantlyConfig()
// onReply(lead): called (not awaited) the first time a lead replies — never breaks the poll if it fails
export async function pollInstantlyEvents({ db, ownerId, config, fetchImpl, sleep, now = new Date(), onReply = null }) {
  let rows;
  try {
    rows = await selectAll(() => db.from(TABLE).select('*').eq('user_id', ownerId).in('status', POLLABLE_STATUSES).order('id'));
  } catch (err) { throw new Error(`cargar leads: ${err.message}`); }
  const leads = rows.filter(l => l.instantly_lead_id);

  const at = now.toISOString();
  let updated = 0, suppressed = 0, replied = 0;

  for (let i = 0; i < leads.length; i += IDS_PER_REQUEST) {
    const chunk = leads.slice(i, i + IDS_PER_REQUEST);
    const result = await call(config, '/leads/list', { ids: chunk.map(l => l.instantly_lead_id), limit: chunk.length }, { fetchImpl, sleep });
    const byId = new Map((result.items || []).map(x => [x.id, x]));

    for (const dbLead of chunk) {
      const instLead = byId.get(dbLead.instantly_lead_id);
      if (!instLead) continue;                // e.g. deleted from Instantly by hand; nothing to learn from it

      const { patch, suppressAs, repliedNow } = effectOf(dbLead, instLead, at);
      if (suppressAs) { await suppress(db, ownerId, dbLead.email, suppressAs); suppressed++; }
      if (!Object.keys(patch).length) continue;

      // The status filter makes two overlapping polls harmless: only the first to run gets the row back
      const { data, error: uErr } = await db.from(TABLE).update({ ...patch, updated_at: at }).eq('id', dbLead.id).eq('status', dbLead.status).select('id');
      if (uErr) throw new Error(`guardar lead: ${uErr.message}`);
      if (!data?.length) continue;
      updated++;

      if (repliedNow) {
        replied++;
        if (onReply) Promise.resolve().then(() => onReply({ ...dbLead, ...patch })).catch(err => console.error('[instantly-poll] onReply failed:', err.message));
      }
    }
  }
  return { checked: leads.length, updated, suppressed, replied };
}
