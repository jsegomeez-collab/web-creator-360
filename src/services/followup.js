// Follow-up of the leads that opened their demo website but have not replied.
// They are moved to a SEPARATE Instantly campaign (INSTANTLY_CAMPAIGN_ID_FOLLOWUP) with 7 emails, one a day. Instantly stops the
// sequence by itself when the lead replies (the campaign has "stop on reply"); our 5-minute poll then marks the reply.
// Moving a lead that had finished the first campaign puts it back to "active" in the new one (checked against the real API),
// and it keeps its Instantly id, so nothing else in the app changes.
import { API, resumeIfCompleted, checkCampaignCopy } from './instantly.js';
import { requestJson } from '../lib/http.js';
import { selectAll } from '../lib/selectAll.js';
import { isDryRun } from '../lib/dryRun.js';
import { MAPS_SOURCE, US_SOURCE } from './audience.js';

const TABLE = 'new_business_leads';
export const FOLLOWUP_DAYS = 7;                  // one email a day for 7 days
const IDS_PER_REQUEST = 100;
const BOUNCED = -1, UNSUBSCRIBED = -2;           // Instantly's Lead.status
const DAY = 86_400_000;
const sleepDefault = (ms) => new Promise(r => setTimeout(r, ms));

const call = (config, path, body, opts = {}) => requestJson({
  service: 'Instantly', url: `${API}${path}`, method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${config.apiKey}` }, body,
  hint401: '(¿INSTANTLY_API_KEY correcta y con permiso para leads?)', ...opts,
});

// Leads that should enter the follow-up: opened their demo, did not reply, have a demo to link to, not entered yet.
// Two lanes, each with its own Instantly campaign: 'es' (the Spanish one: everything but the English sources) and 'us' (the
// "americanos", in English). Google Maps leads will have their own follow-up campaign: not here.
const eligible = (db, ownerId, limit, audience = 'es') => selectAll(() => {
  let query = db.from(TABLE).select('*').eq('user_id', ownerId).eq('status', 'engaged')
    .is('followup_at', null).is('replied_at', null).eq('demo_status', 'ready').not('instantly_lead_id', 'is', null);
  query = audience === 'us' ? query.eq('source', US_SOURCE) : query.neq('source', MAPS_SOURCE).neq('source', US_SOURCE);
  return query.order('engaged_at', { ascending: true }).order('id');
}, { max: limit });

// What Instantly knows now about these leads → Map(id → lead)
async function instantlyState(config, leads, opts) {
  const byId = new Map();
  for (let i = 0; i < leads.length; i += IDS_PER_REQUEST) {
    const ids = leads.slice(i, i + IDS_PER_REQUEST).map(l => l.instantly_lead_id);
    const result = await call(config, '/leads/list', { ids, limit: ids.length }, opts);
    for (const x of result.items || []) byId.set(x.id, x);
  }
  return byId;
}

// The move is a background job on Instantly's side: wait until it ends (a few seconds)
async function waitForJob(config, jobId, { fetchImpl, sleep = sleepDefault, tries = 20 } = {}) {
  for (let i = 0; i < tries; i++) {
    const job = await call(config, `/background-jobs/${jobId}`, null, { fetchImpl, sleep });
    if (job.status === 'success') return true;
    if (['failed', 'cancelled'].includes(job.status)) throw new Error(`Instantly no pudo mover los leads (${job.status})`);
    await sleep(2000);
  }
  throw new Error('Instantly tarda demasiado en mover los leads; se reintentará en el próximo ciclo');
}

// Moves the eligible leads to the follow-up campaign. → { dryRun, eligible, moved, skipped }
//   skipped: notInInstantly · bounced · unsubscribed · replied (Instantly has a reply we had not marked yet)
//   audience: 'es' (default, config = the Spanish follow-up campaign) or 'us' (the "americanos", config = their English one)
//   verifyCopy: before moving anyone, read the follow-up campaign and stop if its email copy does not match what we send (checkCampaignCopy)
export async function moveToFollowup({ db, ownerId, config, audience = 'es', limit = 200, dryRun = isDryRun(), verifyCopy = false, fetchImpl, sleep, now = new Date() }) {
  let leads;
  try { leads = await eligible(db, ownerId, limit, audience); } catch (err) {
    throw new Error(`cargar leads para el seguimiento: ${err.message}${/followup_at|column/i.test(err.message) ? ' (¿has ejecutado src/db/schema-followup.sql en Supabase?)' : ''}`);
  }
  const skipped = { notInInstantly: 0, bounced: 0, unsubscribed: 0, replied: 0 };
  if (!leads.length) return { dryRun, eligible: 0, moved: 0, skipped };

  const opts = { fetchImpl, sleep };
  const state = await instantlyState(config, leads, opts);
  const toMove = new Map();                      // the campaign they are in now → leads
  const alreadyThere = [];
  for (const lead of leads) {
    const x = state.get(lead.instantly_lead_id);
    if (!x) skipped.notInInstantly++;
    else if (x.status === BOUNCED) skipped.bounced++;
    else if (x.status === UNSUBSCRIBED) skipped.unsubscribed++;
    else if ((x.email_reply_count || 0) > 0) skipped.replied++;
    else if (x.campaign === config.campaignId) alreadyThere.push(lead);
    else toMove.set(x.campaign, [...(toMove.get(x.campaign) || []), lead]);
  }
  const movable = [...toMove.values()].flat().length + alreadyThere.length;
  if (dryRun) return { dryRun: true, eligible: leads.length, moved: movable, skipped };

  if (verifyCopy && movable) {
    const check = await checkCampaignCopy(config, leads[0], { fetchImpl });
    if (!check.ok) throw new Error(`No se pasan leads a la campaña de seguimiento porque su texto no coincide con lo que enviamos: ${check.problems.join('; ')}`);
  }

  const stamped = [...alreadyThere];
  for (const [fromCampaign, group] of toMove) {
    for (let i = 0; i < group.length; i += IDS_PER_REQUEST) {
      const chunk = group.slice(i, i + IDS_PER_REQUEST);
      const job = await call(config, '/leads/move', {
        ids: chunk.map(l => l.instantly_lead_id), campaign: fromCampaign, to_campaign_id: config.campaignId, check_duplicates: false, copy_leads: false,
      }, opts);
      await waitForJob(config, job.id, opts);
      // Only the ones Instantly now shows in the follow-up campaign count as moved
      const after = await instantlyState(config, chunk, opts);
      stamped.push(...chunk.filter(l => after.get(l.instantly_lead_id)?.campaign === config.campaignId));
    }
  }

  const stamp = now.toISOString();
  for (let i = 0; i < stamped.length; i += 20) {
    await Promise.all(stamped.slice(i, i + 20).map(async (lead) => {
      const { error } = await db.from(TABLE).update({ followup_at: stamp, updated_at: stamp }).eq('id', lead.id);
      if (error) throw new Error(`Instantly movió los leads pero no se pudo guardar el estado (${error.message}). Revisa new_business_leads.followup_at.`);
    }));
  }
  // A follow-up campaign that had sent everything is "completed" and ignores leads moved in later
  const campaign = stamped.length ? await resumeIfCompleted(config, { fetchImpl }) : 'ok';
  return { dryRun: false, eligible: leads.length, moved: stamped.length, skipped, campaign };
}

// For the panel: who is waiting to enter, who is in the sequence (day N of 7), who replied since, who went cold
export async function followupOverview({ db, ownerId, now = new Date() }) {
  const rows = await selectAll(() => db.from(TABLE).select('id, name, email, city, source, status, engaged_at, followup_at, replied_at, demo_url')
    .eq('user_id', ownerId).not('followup_at', 'is', null).order('followup_at', { ascending: false }).order('id'));
  const waiting = [...await eligible(db, ownerId, 5000, 'es'), ...await eligible(db, ownerId, 5000, 'us')];

  const leads = rows.map((l) => {
    const days = Math.floor((now.getTime() - Date.parse(l.followup_at)) / DAY);
    const state = l.replied_at ? 'replied' : days >= FOLLOWUP_DAYS ? 'cold' : 'active';
    return { ...l, day: Math.min(days + 1, FOLLOWUP_DAYS), state, lang: l.source === US_SOURCE ? 'en' : 'es' };
  });
  const count = (s) => leads.filter(l => l.state === s).length;
  return { counts: { waiting: waiting.length, active: count('active'), replied: count('replied'), cold: count('cold') }, days: FOLLOWUP_DAYS, leads };
}
