// Starts the public campaign server (see campaignApp.js). Run it with: npm run start:campaign
import 'dotenv/config';
import cron from 'node-cron';
import supabase from './db/supabase.js';
import { createCampaignApp } from './campaignApp.js';
import { loadInstantlyConfig } from './services/instantly.js';
import { pollInstantlyEvents } from './services/instantlyPoll.js';
import { alertCallRequest, alertReply, loadTelegramConfig } from './services/telegram.js';

const ownerId = (process.env.NEW_LEADS_OWNER_USER_ID || '').trim();
if (!ownerId) {
  console.error('Falta NEW_LEADS_OWNER_USER_ID: sin él el servidor no sabe a qué usuario pertenecen los leads.');
  process.exit(1);
}

const app = createCampaignApp({ db: supabase, ownerId, onRequested: (lead, values) => alertCallRequest(lead, values) });

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Campaign server on port ${PORT}`));
if (!loadTelegramConfig()) console.warn('Sin TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID: no recibirás avisos en el móvil (las solicitudes sí quedan en el dashboard)');

// What happened in Instantly (sent, bounced, unsubscribed, replied): its webhooks need a paid plan, so we ask its API
// instead, every 5 minutes. `running` stops two ticks from overlapping if one is still going. Polling only needs the API
// key and the campaign (dryRun:true so a missing CAMPAIGN_PUBLIC_URL — irrelevant here — doesn't stop it).
const rawConfig = loadInstantlyConfig(process.env, { dryRun: true });
const instantlyConfig = rawConfig.apiKey && rawConfig.campaignId ? rawConfig : null;
if (!instantlyConfig) console.warn(`Sin comprobación automática de Instantly: falta ${rawConfig.warnings.filter(w => !w.startsWith('CAMPAIGN_PUBLIC_URL')).join(', ') || 'configurar Instantly'} en tu .env`);

if (instantlyConfig) {
  let running = false;
  cron.schedule('*/5 * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const r = await pollInstantlyEvents({ db: supabase, ownerId, config: instantlyConfig, onReply: (lead) => alertReply(lead) });
      if (r.updated || r.suppressed) console.log(`[instantly] revisados ${r.checked} · actualizados ${r.updated} · bajas/rebotes ${r.suppressed} · respuestas ${r.replied}`);
    } catch (err) {
      console.error('[instantly] no se pudo comprobar el estado de los leads:', err.message);
    } finally {
      running = false;
    }
  });
  console.log('Instantly: comprobando envíos, rebotes, bajas y respuestas cada 5 minutos');
}
