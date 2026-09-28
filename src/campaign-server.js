// Starts the public campaign server (see campaignApp.js). Run it with: npm run start:campaign
import 'dotenv/config';
import cron from 'node-cron';
import supabase from './db/supabase.js';
import { createCampaignApp } from './campaignApp.js';
import { runCtIngest } from './services/ctIngest.js';
import { loadInstantlyConfig, pushLeads } from './services/instantly.js';
import { pollInstantlyEvents } from './services/instantlyPoll.js';
import { alertCallRequest, alertReply, sendTelegram, loadTelegramConfig } from './services/telegram.js';

const ownerId = (process.env.NEW_LEADS_OWNER_USER_ID || '').trim();
if (!ownerId) {
  console.error('Falta NEW_LEADS_OWNER_USER_ID: sin él el servidor no sabe a qué usuario pertenecen los leads.');
  process.exit(1);
}

const app = createCampaignApp({ db: supabase, ownerId, onRequested: (lead, values) => alertCallRequest(lead, values) });

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
}

// ─── Autopilot: find more leads and send them on, without you clicking anything ──────────────────────────────────
// Ingest resumes on its own from the last successful run (see ctIngest.js), so this is safe to run forever unattended.
every('0 7 * * *', 'la ingesta diaria de Connecticut', async () => {
  const r = await runCtIngest({ db: supabase, ownerId });
  console.log(`[autopilot] registro CT: ${r.fetched} descargados · ${r.inserted} leads nuevos`);
  if (r.inserted) await sendTelegram(`🤖 Autopilot: ${r.inserted} leads nuevos del registro de Connecticut.`);
}, { timezone: 'America/New_York' });
console.log('Autopilot: revisa el registro de Connecticut todos los días a las 7:00 (hora de Nueva York)');

// Sends the newest "new" leads on a full Instantly config (needs CAMPAIGN_PUBLIC_URL too: it's baked into each lead's
// own link). Respects OUTREACH_DRY_RUN like the dashboard's own button. Picks up CSV imports you do by hand too, not
// just what the ingest above finds — AUTOPILOT_PUSH_LIMIT (default 20) per run, so a brand-new, still-warming mailbox
// never gets a sudden flood.
let pushConfig = null;
try { pushConfig = loadInstantlyConfig(process.env, { dryRun: false }); } catch (err) { console.warn(`Autopilot de envío a Instantly desactivado: ${err.message}`); }

if (pushConfig) {
  const limit = Number(process.env.AUTOPILOT_PUSH_LIMIT) || 20;
  every('0 */3 * * *', 'el envío automático a Instantly', async () => {
    const r = await pushLeads({ db: supabase, ownerId, config: pushConfig, limit });
    if (!r.pushed && !r.rejected) return;
    console.log(`[autopilot] ${r.dryRun ? '(modo prueba) ' : ''}enviados a Instantly: ${r.pushed} · rechazados: ${r.rejected}`);
    if (r.pushed && !r.dryRun) await sendTelegram(`🤖 Autopilot: ${r.pushed} leads enviados a Instantly.`);
  });
  console.log(`Autopilot: envía hasta ${limit} leads nuevos a Instantly cada 3 horas`);
}
