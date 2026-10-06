// Starts the public campaign server (see campaignApp.js). Run it with: npm run start:campaign
import 'dotenv/config';
import cron from 'node-cron';
import supabase from './db/supabase.js';
import { createCampaignApp } from './campaignApp.js';
import { runCtIngest } from './services/ctIngest.js';
import { loadInstantlyConfig, pushLeads } from './services/instantly.js';
import { pollInstantlyEvents } from './services/instantlyPoll.js';
import { getAutopilotSettings, ALL_MODE_SEND_LIMIT } from './services/autopilot.js';
import { generateDemos, generateAllDemos, readyDemoCount } from './services/leadDemos.js';
import { alertCallRequest, alertReply, sendTelegram, loadTelegramConfig } from './services/telegram.js';

const ownerId = (process.env.NEW_LEADS_OWNER_USER_ID || '').trim();
if (!ownerId) {
  console.error('Falta NEW_LEADS_OWNER_USER_ID: sin él el servidor no sabe a qué usuario pertenecen los leads.');
  process.exit(1);
}

// Filled in below as each unattended part starts (or is skipped, with the reason): read by GET /health
const autopilotStatus = { ingest: false, poll: false, push: false, demos: false, notes: [] };
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
every('0 7 * * *', 'la ingesta diaria de Connecticut', async () => {
  const { enabled } = await getAutopilotSettings(supabase, ownerId);
  if (!enabled) return;
  const r = await runCtIngest({ db: supabase, ownerId });
  console.log(`[autopilot] registro CT: ${r.fetched} descargados · ${r.inserted} leads nuevos`);
  if (r.inserted) await sendTelegram(`🤖 Autopilot: ${r.inserted} leads nuevos del registro de Connecticut.`);
}, { timezone: 'America/New_York' });
console.log('Autopilot: revisa el registro de Connecticut todos los días a las 7:00 (hora de Nueva York), si está activado');
autopilotStatus.ingest = true;

// Sends the newest "new" leads on a full Instantly config (needs CAMPAIGN_PUBLIC_URL too: it's baked into each lead's
// own link). Respects OUTREACH_DRY_RUN like the dashboard's own button. Picks up CSV imports you do by hand too, not
// just what the ingest above finds — a modest batch each time (pushLimit, 20 by default), so a brand-new, still-warming
// mailbox never gets a sudden flood.
let pushConfig = null;
try { pushConfig = loadInstantlyConfig(process.env, { dryRun: false }); } catch (err) { console.warn(`Autopilot de envío a Instantly desactivado: ${err.message}`); autopilotStatus.notes.push(`envío y demos desactivados: ${err.message}`); }

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
        const want = Math.min(3, pushLimit - await readyDemoCount(supabase, ownerId));
        if (want <= 0) return;
        r = await generateDemos({ db: supabase, ownerId, publicUrl: pushConfig.publicUrl, limit: want, log });
      }
      if (r.failed) await sendTelegram(`⚠️ ${r.failed} web(s) de demo no se pudieron crear. Míralo en el dashboard (LLCs nuevas → Leads).`);
    });
    console.log('Demos: crea las webs de los próximos leads cada 10 minutos (Claude Sonnet 5.5 + Vercel), si el autopilot está activado');
    autopilotStatus.demos = true;
  }
}

if (pushConfig) {
  every('0 */3 * * *', 'el envío automático a Instantly', async () => {
    const { enabled, pushLimit, demoAll } = await getAutopilotSettings(supabase, ownerId);
    if (!enabled) return;
    const r = await pushLeads({ db: supabase, ownerId, config: pushConfig, limit: demoAll ? ALL_MODE_SEND_LIMIT : pushLimit });
    if (!r.pushed && !r.rejected) return;
    console.log(`[autopilot] ${r.dryRun ? '(modo prueba) ' : ''}enviados a Instantly: ${r.pushed} · rechazados: ${r.rejected}`);
    if (r.pushed && !r.dryRun) await sendTelegram(`🤖 Autopilot: ${r.pushed} leads enviados a Instantly.`);
  });
  console.log('Autopilot: envía leads nuevos a Instantly cada 3 horas, si está activado (revisa el límite en el dashboard)');
  autopilotStatus.push = !demosOn || autopilotStatus.demos;   // with demos on but not configured, nothing is sent
  if (demosOn && !autopilotStatus.demos) autopilotStatus.notes.push('envío parado: LEAD_DEMOS=true y no se pueden crear webs');
  if (!demosOn) autopilotStatus.notes.push('LEAD_DEMOS no está en true: se envía el email clásico y no se crean webs');
}
