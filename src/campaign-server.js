// Starts the public campaign server (see campaignApp.js). Run it with: npm run start:campaign
import 'dotenv/config';
import cron from 'node-cron';
import supabase from './db/supabase.js';
import { createCampaignApp } from './campaignApp.js';
import { runCtIngest } from './services/ctIngest.js';
import { runMapsProspect } from './services/mapsProspect.js';
import { moveToFollowup } from './services/followup.js';
import { loadApifyConfig } from './services/apify.js';
import { loadInstantlyConfig, pushLeads, resumeIfCompleted } from './services/instantly.js';
import { pollInstantlyEvents } from './services/instantlyPoll.js';
import { getAutopilotSettings, ALL_MODE_SEND_LIMIT } from './services/autopilot.js';
import { generateDemos, generateAllDemos, readyDemoCount, expireDemos } from './services/leadDemos.js';
import { alertCallRequest, alertReply, sendTelegram, loadTelegramConfig } from './services/telegram.js';

const ownerId = (process.env.NEW_LEADS_OWNER_USER_ID || '').trim();
if (!ownerId) {
  console.error('Falta NEW_LEADS_OWNER_USER_ID: sin él el servidor no sabe a qué usuario pertenecen los leads.');
  process.exit(1);
}

// Filled in below as each unattended part starts (or is skipped, with the reason): read by GET /health
const autopilotStatus = { ingest: false, poll: false, push: false, demos: false, maps: false, followup: false, us: false, campaign: (process.env.INSTANTLY_CAMPAIGN_ID || '').trim().slice(0, 8) || null, notes: [] };
const app = createCampaignApp({ db: supabase, ownerId, onRequested: (lead, values) => alertCallRequest(lead, values), getStatus: () => autopilotStatus });

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Campaign server on port ${PORT}`));
if (!loadTelegramConfig()) console.warn('Sin TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID: no recibirás avisos en el móvil (las solicitudes sí quedan en el dashboard)');

// A recurring job that only lets one tick run at a time (if a run is still going when the next tick fires, that tick
// is skipped rather than piling up) — a Postgres error or a slow network call never turns into two overlapping runs.
function every(expression, name, task, cronOptions) {
  let running = false;
  cron.schedule(expression, async () => {
    if (running) return;
    running = true;
    try { await task(); } catch (err) { console.error(`[autopilot] ${name} falló:`, err.message); } finally { running = false; }
  }, cronOptions);
}

// What happened in Instantly (sent, bounced, unsubscribed, replied): its webhooks need a paid plan, so we ask its API
// instead, every 5 minutes. Polling only needs the API key and the campaign (dryRun:true so a missing
// CAMPAIGN_PUBLIC_URL — irrelevant here — doesn't stop it).
const rawConfig = loadInstantlyConfig(process.env, { dryRun: true });
const instantlyConfig = rawConfig.apiKey && rawConfig.campaignId ? rawConfig : null;
if (!instantlyConfig) console.warn(`Sin comprobación automática de Instantly: falta ${rawConfig.warnings.filter(w => !w.startsWith('CAMPAIGN_PUBLIC_URL')).join(', ') || 'configurar Instantly'} en tu .env`);

if (instantlyConfig) {
  every('*/5 * * * *', 'comprobar Instantly', async () => {
    const r = await pollInstantlyEvents({ db: supabase, ownerId, config: instantlyConfig, onReply: (lead) => alertReply(lead) });
    if (r.updated || r.suppressed) console.log(`[instantly] revisados ${r.checked} · actualizados ${r.updated} · bajas/rebotes ${r.suppressed} · respuestas ${r.replied}`);
  });
  console.log('Instantly: comprobando envíos, rebotes, bajas y respuestas cada 5 minutos');
  autopilotStatus.poll = true;
}

// ─── Autopilot: find more leads and send them on, without you clicking anything ──────────────────────────────────
// On/off and the batch size live in the database (campaign_autopilot), set from the dashboard's Envío tab — read fresh
// on every tick, so toggling it there takes effect within one cycle, no redeploy needed.
// Ingest resumes on its own from the last successful run (see ctIngest.js), so this is safe to run forever unattended.
every('0 7 * * *', 'la ingesta diaria de LLCs nuevas', async () => {
  const { enabled } = await getAutopilotSettings(supabase, ownerId);
  if (!enabled) return;
  // The "americanos" (no Latino signal, English campaign) are only kept once their Instantly campaign is set up; owners whose own
  // email domain already has a website are dropped (they would not buy a demo)
  const americans = Boolean((process.env.INSTANTLY_CAMPAIGN_ID_US || '').trim());
  const r = await runCtIngest({ db: supabase, ownerId, americans, checkWebsites: true });
  console.log(`[autopilot] registro de LLCs: ${r.fetched} descargados · ${r.inserted - r.insertedAmericans} leads latinos nuevos${americans ? ` · ${r.insertedAmericans} americanos` : ''} · con web propia descartados: ${r.stats.alreadyHasWebsite ?? 0}`);
  if (r.inserted) await sendTelegram(`🤖 Autopilot: ${r.inserted - r.insertedAmericans} leads nuevos de LLCs${americans ? ` y ${r.insertedAmericans} americanos` : ''}.`);
}, { timezone: 'America/New_York' });
console.log('Autopilot: revisa el registro de LLCs nuevas todos los días a las 7:00 (hora de Nueva York), si está activado');
autopilotStatus.ingest = true;

// Sends the newest "new" leads on a full Instantly config (needs CAMPAIGN_PUBLIC_URL too: it's baked into each lead's
// own link). Respects OUTREACH_DRY_RUN like the dashboard's own button. Picks up CSV imports you do by hand too, not
// just what the ingest above finds — a modest batch each time (pushLimit, 20 by default), so a brand-new, still-warming
// mailbox never gets a sudden flood.
let pushConfig = null;
try { pushConfig = loadInstantlyConfig(process.env, { dryRun: false }); } catch (err) { console.warn(`Autopilot de envío a Instantly desactivado: ${err.message}`); autopilotStatus.notes.push(`envío y demos desactivados: ${err.message}`); }

// Campaign 2 (Google Maps businesses without a website): its own Instantly campaign and copy. Only active when its campaign id
// (INSTANTLY_CAMPAIGN_ID_MAPS) is set; the search itself also needs APIFY_TOKEN.
let mapsPushConfig = null;
if ((process.env.INSTANTLY_CAMPAIGN_ID_MAPS || '').trim()) {
  try { mapsPushConfig = loadInstantlyConfig(process.env, { dryRun: false, campaign: 'maps' }); } catch (err) { console.warn(`Campaña de Google Maps desactivada: ${err.message}`); autopilotStatus.notes.push(`campaña de Maps desactivada: ${err.message}`); }
}

// Campaign 3 ("americanos": new LLCs with no Latino signal, emailed in English): its own Instantly campaign and copy. Active when its
// campaign id (INSTANTLY_CAMPAIGN_ID_US) is set; the leads arrive with the daily registry download above.
let usPushConfig = null;
if ((process.env.INSTANTLY_CAMPAIGN_ID_US || '').trim()) {
  try { usPushConfig = loadInstantlyConfig(process.env, { dryRun: false, campaign: 'us' }); } catch (err) { console.warn(`Campaña de americanos desactivada: ${err.message}`); autopilotStatus.notes.push(`campaña de americanos desactivada: ${err.message}`); }
}

// Demo websites (LEAD_DEMOS=true): the email links to each lead's own site, so the sites are made ahead of the send.
// Every 10 minutes it tops up the "ready" pile to the next send's size (pushLimit) — at most 3 per tick, one after
// another — so money is only spent on sites that are about to be emailed. In "all" mode (dashboard switch) it makes
// every pending lead's site instead (up to 25 minutes per tick; the next tick continues).
const demosOn = pushConfig?.demos;
if (demosOn) {
  const missing = ['ANTHROPIC_API_KEY', 'VERCEL_TOKEN'].filter(k => !process.env[k]);
  if (missing.length) { console.warn(`LEAD_DEMOS=true pero falta ${missing.join(' y ')}: no se crearán webs de demo y no se enviará ningún lead`); autopilotStatus.notes.push(`LEAD_DEMOS=true pero falta ${missing.join(' y ')}`); }
  else {
    every('*/10 * * * *', 'la creación de webs de demo', async () => {
      const { enabled, pushLimit, demoAll } = await getAutopilotSettings(supabase, ownerId);
      if (!enabled) return;
      const log = (m) => console.log(`[demos] ${m}`);
      let r;
      if (demoAll) r = await generateAllDemos({ db: supabase, ownerId, publicUrl: pushConfig.publicUrl, log });
      else {
        // pile of ready demos to keep: one send per campaign, plus a bigger one for the "americanos" (~117 new LLCs a day)
        const target = pushLimit * (mapsPushConfig ? 2 : 1) + (usPushConfig ? 100 : 0);
        const want = Math.min(3, target - await readyDemoCount(supabase, ownerId));
        if (want <= 0) return;
        r = await generateDemos({ db: supabase, ownerId, publicUrl: pushConfig.publicUrl, limit: want, log });
      }
      if (r.failed) await sendTelegram(`⚠️ ${r.failed} web(s) de demo no se pudieron crear. Míralo en el dashboard (LLCs nuevas → Leads).`);
    });
    console.log('Demos: crea las webs de los próximos leads cada 10 minutos (Claude Sonnet 5.5 + Vercel), si el autopilot está activado');
    autopilotStatus.demos = true;
  }
}

// Demo sites are kept online 30 days after the send (the follow-up emails point to them) and then removed from Vercel
if (process.env.VERCEL_TOKEN) {
  every('30 4 * * *', 'la caducidad de webs de demo', async () => {
    const r = await expireDemos({ db: supabase, ownerId, log: (m) => console.log(`[demos] ${m}`) });
    if (r.expired || r.failed) console.log(`[demos] caducadas: ${r.expired} · fallos: ${r.failed}`);
  });
  console.log('Demos: las webs se retiran de Vercel a los 30 días del envío (cada día a las 4:30 UTC)');
}

// Campaign 2, search: every day at 8:00 (New York) it runs the next cities + categories of the rotation (MAPS_RUNS_PER_DAY, 2 by
// default). Each run is capped (MAPS_MAX_PER_SEARCH places per search, MAPS_LOOKUPS_PER_RUN Facebook lookups ≈ $0.015 each, and a
// hard cost cap in Apify), so the daily bill is small and known (≈ $3 a day by default).
if (mapsPushConfig && loadApifyConfig().token) {
  every('0 8 * * *', 'la búsqueda diaria en Google Maps', async () => {
    const { enabled } = await getAutopilotSettings(supabase, ownerId);
    if (!enabled) return;
    const runs = Math.max(1, parseInt(process.env.MAPS_RUNS_PER_DAY, 10) || 2);
    const maxPerSearch = Math.max(1, parseInt(process.env.MAPS_MAX_PER_SEARCH, 10) || 40);
    const lookups = Math.max(0, Number.isFinite(parseInt(process.env.MAPS_LOOKUPS_PER_RUN, 10)) ? parseInt(process.env.MAPS_LOOKUPS_PER_RUN, 10) : 60);
    let inserted = 0;
    for (let i = 0; i < runs; i++) {
      const r = await runMapsProspect({ db: supabase, ownerId, maxPerSearch, lookups });
      inserted += r.inserted;
      console.log(`[maps] ${r.zone}: ${r.places} negocios sin web encontrados · ${r.facebook?.withEmail ?? 0} emails por Facebook · ${r.inserted} leads nuevos · ${r.costUsd == null ? '' : `$${r.costUsd.toFixed(2)} de Apify`}`);
    }
    if (inserted) await sendTelegram(`🤖 Google Maps: ${inserted} leads nuevos de negocios sin web.`);
  }, { timezone: 'America/New_York' });
  console.log('Maps: busca negocios latinos sin web cada día a las 8:00 (hora de Nueva York), si el autopilot está activado');
  autopilotStatus.maps = true;
} else if (mapsPushConfig) {
  autopilotStatus.notes.push('campaña de Maps: falta APIFY_TOKEN, no se buscan negocios nuevos');
}

// "Americanos": everything with a ready demo is sent (the mailboxes' daily limit in Instantly paces the actual sending)
if (usPushConfig) {
  every('40 */3 * * *', 'el envío automático a la campaña de americanos', async () => {
    const { enabled } = await getAutopilotSettings(supabase, ownerId);
    if (!enabled) return;
    const r = await pushLeads({ db: supabase, ownerId, config: usPushConfig, limit: ALL_MODE_SEND_LIMIT });
    if (!r.pushed && !r.rejected) return;
    console.log(`[americanos] ${r.dryRun ? '(modo prueba) ' : ''}enviados a Instantly: ${r.pushed} · rechazados: ${r.rejected}`);
    if (r.pushed && !r.dryRun) {
      const resumed = await resumeIfCompleted(usPushConfig);
      if (resumed !== 'ok') console.log(`[americanos] campaña de Instantly: ${resumed}`);
      await sendTelegram(`🤖 Americanos: ${r.pushed} leads enviados a Instantly.`);
    }
  });
  console.log('Americanos: envía sus leads a su campaña de Instantly cada 3 horas (a los :40), si el autopilot está activado');
  autopilotStatus.us = true;
}

if (mapsPushConfig) {
  every('20 */3 * * *', 'el envío automático a la campaña de Maps', async () => {
    const { enabled, pushLimit, demoAll } = await getAutopilotSettings(supabase, ownerId);
    if (!enabled) return;
    const r = await pushLeads({ db: supabase, ownerId, config: mapsPushConfig, limit: demoAll ? ALL_MODE_SEND_LIMIT : pushLimit });
    if (!r.pushed && !r.rejected) return;
    console.log(`[maps] ${r.dryRun ? '(modo prueba) ' : ''}enviados a Instantly: ${r.pushed} · rechazados: ${r.rejected}`);
    if (r.pushed && !r.dryRun) {
      const resumed = await resumeIfCompleted(mapsPushConfig);
      if (resumed !== 'ok') console.log(`[maps] campaña de Instantly: ${resumed}`);
      await sendTelegram(`🤖 Google Maps: ${r.pushed} leads enviados a Instantly.`);
    }
  });
  console.log('Maps: envía sus leads a su campaña de Instantly cada 3 horas (a los :20), si el autopilot está activado');
}

// Follow-up: those who opened their demo website and have not replied are moved, every 30 minutes, to a separate Instantly campaign
// with 7 emails (one a day). Only active when its campaign id (INSTANTLY_CAMPAIGN_ID_FOLLOWUP) is set. Instantly stops the sequence
// by itself when the lead replies.
if ((process.env.INSTANTLY_CAMPAIGN_ID_FOLLOWUP || '').trim()) {
  let followupConfig = null;
  try { followupConfig = loadInstantlyConfig(process.env, { dryRun: false, campaign: 'followup' }); } catch (err) { console.warn(`Seguimiento desactivado: ${err.message}`); autopilotStatus.notes.push(`seguimiento desactivado: ${err.message}`); }
  let followupUsConfig = null;
  if ((process.env.INSTANTLY_CAMPAIGN_ID_FOLLOWUP_US || '').trim()) {
    try { followupUsConfig = loadInstantlyConfig(process.env, { dryRun: false, campaign: 'followup_us' }); } catch (err) { console.warn(`Seguimiento en inglés desactivado: ${err.message}`); autopilotStatus.notes.push(`seguimiento en inglés desactivado: ${err.message}`); }
  }
  if (followupConfig) {
    every('*/10 * * * *', 'el seguimiento de los que abrieron la web', async () => {
      const { enabled } = await getAutopilotSettings(supabase, ownerId);
      if (!enabled) return;
      // One lane per language: the Spanish one and, if its campaign is set, the English one of the "americanos"
      for (const [audience, config, label] of [['es', followupConfig, 'español'], ['us', followupUsConfig, 'inglés (americanos)']]) {
        if (!config) continue;
        const r = await moveToFollowup({ db: supabase, ownerId, config, audience });
        if (!r.moved && !Object.values(r.skipped).some(Boolean)) continue;
        console.log(`[seguimiento ${label}] ${r.dryRun ? '(modo prueba) ' : ''}pasan al seguimiento: ${r.moved} · omitidos: ${JSON.stringify(r.skipped)}`);
        if (r.moved && !r.dryRun) await sendTelegram(`🤖 Seguimiento (${label}): ${r.moved} leads que abrieron la web pasan a la campaña de recordatorios.`);
      }
    });
    console.log('Seguimiento: pasa a la campaña de recordatorios a los que abren la web, cada 10 minutos, si el autopilot está activado');
    autopilotStatus.followup = true;
  }
}

if (pushConfig) {
  every('0 */3 * * *', 'el envío automático a Instantly', async () => {
    const { enabled, pushLimit, demoAll } = await getAutopilotSettings(supabase, ownerId);
    if (!enabled) return;
    const r = await pushLeads({ db: supabase, ownerId, config: pushConfig, limit: demoAll ? ALL_MODE_SEND_LIMIT : pushLimit });
    if (!r.pushed && !r.rejected) return;
    console.log(`[autopilot] ${r.dryRun ? '(modo prueba) ' : ''}enviados a Instantly: ${r.pushed} · rechazados: ${r.rejected}`);
    if (r.pushed && !r.dryRun) {
      const resumed = await resumeIfCompleted(pushConfig);
      if (resumed !== 'ok') console.log(`[autopilot] campaña de Instantly: ${resumed}`);
    }
    if (r.pushed && !r.dryRun) await sendTelegram(`🤖 Autopilot: ${r.pushed} leads enviados a Instantly.`);
  });
  console.log('Autopilot: envía leads nuevos a Instantly cada 3 horas, si está activado (revisa el límite en el dashboard)');
  autopilotStatus.push = !demosOn || autopilotStatus.demos;   // with demos on but not configured, nothing is sent
  if (demosOn && !autopilotStatus.demos) autopilotStatus.notes.push('envío parado: LEAD_DEMOS=true y no se pueden crear webs');
  if (!demosOn) autopilotStatus.notes.push('LEAD_DEMOS no está en true: se envía el email clásico y no se crean webs');
}
