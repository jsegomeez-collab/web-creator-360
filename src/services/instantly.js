// Instantly (cold email sender, API v2). We push new leads into ONE campaign and Instantly does the rest: its own
// mailboxes, warm-up, schedule, daily limits and the unsubscribe link. What happens afterwards comes back to us through
// a webhook (src/routes/instantlyWebhook.js).
//   POST /leads/add   up to 1000 leads per request, with per-lead custom variables ({{empresa}}, {{ciudad}}…)
//   POST /webhooks    one webhook for all events, protected by a secret header
import { isDryRun, dryRunLog } from '../lib/dryRun.js';
import { displayName, leadVariables } from '../prompts/newBusinessEmails.js';

export const API = 'https://api.instantly.ai/api/v2';
const MAX_PER_REQUEST = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEADS_TABLE = 'new_business_leads';
const REJECTED_NOTE = 'Instantly no lo aceptó (ya estaba en tu workspace, está en la lista de bloqueo o el email no es válido)';

const sleepDefault = (ms) => new Promise(r => setTimeout(r, ms));

// Settings for pushing leads. A real push needs an API key, a campaign, the public URL of the campaign server (the link
// in each email points there) and the calendar the link finally opens. In dry-run placeholders are used.
export function loadInstantlyConfig(env = process.env, { dryRun = isDryRun() } = {}) {
  const apiKey = String(env.INSTANTLY_API_KEY || '').trim();
  const campaignId = String(env.INSTANTLY_CAMPAIGN_ID || '').trim();
  const publicUrl = String(env.CAMPAIGN_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const calendarUrl = String(env.CALENDAR_URL || '').trim();

  const problems = [];
  if (!apiKey) problems.push('INSTANTLY_API_KEY');
  if (!UUID_RE.test(campaignId)) problems.push('INSTANTLY_CAMPAIGN_ID (el UUID de la campaña)');
  if (!/^https:\/\//i.test(publicUrl) || /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(publicUrl)) {
    problems.push('CAMPAIGN_PUBLIC_URL (URL pública https:// del servidor de la campaña, no localhost)');
  }
  if (!/^https?:\/\//i.test(calendarUrl)) problems.push('CALENDAR_URL (tu página para agendar la llamada)');

  if (problems.length && !dryRun) throw new Error(`Configuración incompleta para enviar leads a Instantly. Revisa en tu .env: ${problems.join(', ')}`);
  return {
    apiKey, campaignId,
    publicUrl: publicUrl || 'http://localhost:3002',
    warnings: problems,
  };
}

// The link each lead gets in {{calendario}}: tracked, then redirects to the calendar
export const trackedCalendarUrl = (config, token) => `${config.publicUrl}/c/${token}`;

export const buildInstantlyLead = (lead, config) => ({
  email: lead.email,
  company_name: displayName(lead.name),
  custom_variables: leadVariables(lead, trackedCalendarUrl(config, lead.link_token)),
});

// One API call with retries on 429 / 5xx. Errors carry Instantly's own message.
async function call(config, path, body, { fetchImpl = globalThis.fetch, sleep = sleepDefault, retries = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt >= retries) throw new Error(`No se pudo conectar con Instantly: ${err.message}`);
      await sleep(1000 * attempt);
      continue;
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) { await sleep(1000 * attempt); continue; }
    const detail = await res.json().then(j => j.message || j.error || JSON.stringify(j)).catch(() => res.statusText);
    throw new Error(`Instantly respondió ${res.status}: ${detail}${res.status === 401 ? ' (¿INSTANTLY_API_KEY correcta y con permiso para leads?)' : ''}`);
  }
}

// Pushes the newest leads with status "new" into the campaign. Returns { dryRun, pushed, rejected }.
//   pushed    → status "queued" (Instantly will send it on its schedule), with the Instantly lead id
//   rejected  → status "rejected": Instantly didn't create it (already in the workspace, blocklist or invalid email)
// In dry-run nothing is sent and nothing is written.
export async function pushLeads({ db, ownerId, config, limit = 100, dryRun = isDryRun(), fetchImpl, sleep, now = new Date() }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('limit debe ser un entero entre 1 y 5000');

  const { data: leads, error } = await db.from(LEADS_TABLE).select('*')
    .eq('user_id', ownerId).eq('status', 'new').order('registered_at', { ascending: false }).limit(limit);
  if (error) throw new Error(`cargar leads: ${error.message}`);
  if (!leads?.length) return { dryRun, pushed: 0, rejected: 0 };

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

// Creates the single webhook (all events) that calls our server, protected by a secret header.
export async function createWebhook({ config, targetUrl, secret, fetchImpl, sleep }) {
  if (!/^https:\/\//i.test(targetUrl || '')) throw new Error('La URL del webhook debe ser https://');
  if (!secret) throw new Error('Falta INSTANTLY_WEBHOOK_SECRET');
  return call(config, '/webhooks', {
    name: 'Web Creator 360',
    target_hook_url: targetUrl,
    event_type: 'all_events',
    campaign: config.campaignId,
    headers: { 'x-webhook-secret': secret },
  }, { fetchImpl, sleep });
}
