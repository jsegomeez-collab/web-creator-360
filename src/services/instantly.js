// Instantly (cold email sender, API v2). We push new leads into ONE campaign and Instantly does the rest: its own
// mailboxes, warm-up, schedule, daily limits and the unsubscribe link. What happens afterwards (sent, bounced,
// unsubscribed, replied) is found by polling, not a webhook (services/instantlyPoll.js) — webhooks need a paid plan.
//   POST /leads/add   up to 1000 leads per request, with per-lead custom variables ({{empresa}}, {{ciudad}}…)
import { isDryRun, dryRunLog } from '../lib/dryRun.js';
import { requestJson } from '../lib/http.js';
import { selectAll } from '../lib/selectAll.js';
import { displayName, leadVariables } from '../prompts/newBusinessEmails.js';

const MAPS_SOURCE = 'gmaps';   // same value as services/mapsProspect.js (not imported: that one imports this indirectly)

export const API = 'https://api.instantly.ai/api/v2';
const MAX_PER_REQUEST = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEADS_TABLE = 'new_business_leads';
const REJECTED_NOTE = 'Instantly no lo aceptó (ya estaba en tu workspace, está en la lista de bloqueo o el email no es válido)';

// Settings for pushing leads. A real push needs an API key, a campaign, the public URL of the campaign server (the link
// in each email points there). In dry-run placeholders are used.
// campaign: 'llc' (new LLCs, INSTANTLY_CAMPAIGN_ID), 'maps' (Google Maps businesses without a website, INSTANTLY_CAMPAIGN_ID_MAPS)
// or 'followup' (those who opened their website and have not replied, INSTANTLY_CAMPAIGN_ID_FOLLOWUP)
const CAMPAIGN_ID_VARS = { llc: 'INSTANTLY_CAMPAIGN_ID', maps: 'INSTANTLY_CAMPAIGN_ID_MAPS', followup: 'INSTANTLY_CAMPAIGN_ID_FOLLOWUP' };
export function loadInstantlyConfig(env = process.env, { dryRun = isDryRun(), campaign = 'llc' } = {}) {
  const idVar = CAMPAIGN_ID_VARS[campaign] ?? CAMPAIGN_ID_VARS.llc;
  const apiKey = String(env.INSTANTLY_API_KEY || '').trim();
  const campaignId = String(env[idVar] || '').trim();
  const publicUrl = String(env.CAMPAIGN_PUBLIC_URL || '').trim().replace(/\/+$/, '');

  const problems = [];
  if (!apiKey) problems.push('INSTANTLY_API_KEY');
  if (!UUID_RE.test(campaignId)) problems.push(`${idVar} (el UUID de la campaña)`);
  if (!/^https:\/\//i.test(publicUrl) || /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(publicUrl)) {
    problems.push('CAMPAIGN_PUBLIC_URL (URL pública https:// del servidor de la campaña, no localhost)');
  }

  if (problems.length && !dryRun) throw new Error(`Configuración incompleta para enviar leads a Instantly. Revisa en tu .env: ${problems.join(', ')}`);
  return {
    apiKey, campaignId, campaign,
    publicUrl: publicUrl || 'http://localhost:3002',
    // LEAD_DEMOS=true: each lead gets its own demo website first, and only leads whose demo is ready are sent
    // (the Maps campaign always has demos: its email is all about the site we made)
    demos: campaign === 'maps' || String(env.LEAD_DEMOS || '').trim().toLowerCase() === 'true',
    warnings: problems,
  };
}

// The link each lead gets in {{calendario}}: their own page to ask for the call (routes/leadLink.js)
export const leadLinkUrl = (config, token) => `${config.publicUrl}/c/${token}`;

export const buildInstantlyLead = (lead, config) => ({
  email: lead.email,
  company_name: displayName(lead.name),
  custom_variables: leadVariables(lead, leadLinkUrl(config, lead.link_token)),
});

// POST to the Instantly API (retries and error messages come from lib/http.js)
const call = (config, path, body, { fetchImpl, sleep } = {}) => requestJson({
  service: 'Instantly', url: `${API}${path}`, method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}` }, body, fetchImpl, sleep,
  hint401: '(¿INSTANTLY_API_KEY correcta y con permiso para leads?)',
});

// Pushes the newest leads with status "new" into the campaign. Returns { dryRun, pushed, rejected }.
//   pushed    → status "queued" (Instantly will send it on its schedule), with the Instantly lead id
//   rejected  → status "rejected": Instantly didn't create it (already in the workspace, blocklist or invalid email)
// In dry-run nothing is sent and nothing is written.
// filters: source, sector, priority, batch (import_batch) — narrow which "new" leads are eligible, e.g. just one CSV import
export async function pushLeads({ db, ownerId, config, limit = 100, filters = {}, dryRun = isDryRun(), fetchImpl, sleep, now = new Date() }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('limit debe ser un entero entre 1 y 5000');

  const eligible = () => {
    let query = db.from(LEADS_TABLE).select('*').eq('user_id', ownerId).eq('status', 'new');
    // each campaign only takes its own leads: Google Maps businesses go to the Maps campaign, everything else to the LLC one
    query = config.campaign === 'maps' ? query.eq('source', MAPS_SOURCE) : query.neq('source', MAPS_SOURCE);
    if (config.demos) query = query.eq('demo_status', 'ready');   // the email links to the demo: never send one without it
    if (filters.source) query = query.eq('source', filters.source);
    if (filters.sector) query = query.eq('sector', filters.sector);
    if (filters.priority) query = query.eq('priority', filters.priority);
    if (filters.batch) query = query.eq('import_batch', filters.batch);
    return query.order('registered_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).order('id');
  };
  let leads;
  try { leads = await selectAll(eligible, { max: limit }); } catch (err) { throw new Error(`cargar leads: ${err.message}`); }
  if (!leads.length) return { dryRun, pushed: 0, rejected: 0 };

  const payloads = leads.map(l => buildInstantlyLead(l, config));

  if (dryRun) {
    dryRunLog('instantly.push', { campaign: config.campaignId, leads: leads.length, first: JSON.stringify(payloads[0]) });
    return { dryRun: true, pushed: leads.length, rejected: 0 };
  }

  let pushed = 0, rejected = 0;
  for (let from = 0; from < leads.length; from += MAX_PER_REQUEST) {
    const chunk = leads.slice(from, from + MAX_PER_REQUEST);
    const result = await call(config, '/leads/add', {
      campaign_id: config.campaignId,
      leads: payloads.slice(from, from + MAX_PER_REQUEST),
      skip_if_in_workspace: true,
    }, { fetchImpl, sleep });

    // created_leads[].index is the position in the request; fall back to the email if it's missing
    const created = new Map();
    for (const c of result.created_leads || []) {
      const idx = Number.isInteger(c.index) ? c.index : chunk.findIndex(l => l.email === String(c.email || '').toLowerCase());
      if (idx >= 0) created.set(idx, c.id);
    }

    const stamp = now.toISOString();
    const accepted = [], notAccepted = [];
    chunk.forEach((lead, i) => (created.has(i) ? accepted : notAccepted).push({ lead, instantlyId: created.get(i) }));

    for (let i = 0; i < accepted.length; i += 20) {
      await Promise.all(accepted.slice(i, i + 20).map(async ({ lead, instantlyId }) => {
        const { error: e } = await db.from(LEADS_TABLE).update({ status: 'queued', instantly_lead_id: instantlyId, pushed_at: stamp, updated_at: stamp }).eq('id', lead.id);
        if (e) throw new Error(`Instantly aceptó los leads pero no se pudo guardar el estado (${e.message}). No vuelvas a enviar: revisa new_business_leads.`);
      }));
    }
    for (const { lead } of notAccepted) {
      const { error: e } = await db.from(LEADS_TABLE).update({ status: 'rejected', notes: [lead.notes, REJECTED_NOTE].filter(Boolean).join(' · '), updated_at: stamp }).eq('id', lead.id);
      if (e) throw new Error(`guardar lead rechazado: ${e.message}`);
    }
    pushed += accepted.length;
    rejected += notAccepted.length;
  }
  return { dryRun: false, pushed, rejected };
}

// A campaign that has run out of leads goes to "completed" (status 3) and ignores leads added later until it is resumed.
// After sending new leads, this resumes it. It only touches a COMPLETED campaign: one you paused on purpose (2) stays paused.
// Never throws (the leads are already in): returns 'resumed' | 'ok' | 'error: …'.
export async function resumeIfCompleted(config, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const headers = { Authorization: `Bearer ${config.apiKey}` };
    const campaign = await (await fetchImpl(`${API}/campaigns/${config.campaignId}`, { headers })).json();
    if (campaign.status !== 3) return 'ok';
    const r = await fetchImpl(`${API}/campaigns/${config.campaignId}/activate`, { method: 'POST', headers });
    return r.ok ? 'resumed' : `error: Instantly respondió ${r.status}`;
  } catch (err) {
    return `error: ${err.message}`;
  }
}
