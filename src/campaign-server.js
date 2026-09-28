// Starts the public campaign server (see campaignApp.js). Run it with: npm run start:campaign
import 'dotenv/config';
import cron from 'node-cron';
import supabase from './db/supabase.js';
import { createCampaignApp } from './campaignApp.js';
import { isCalendlyConfigured, loadCalendlyConfig, syncBookings } from './services/calendly.js';

const ownerId = (process.env.NEW_LEADS_OWNER_USER_ID || '').trim();
if (!ownerId) {
  console.error('Falta NEW_LEADS_OWNER_USER_ID: sin él el servidor no sabe a qué usuario pertenecen los leads.');
  process.exit(1);
}

const calendarUrl = (process.env.CALENDAR_URL || '').trim();
if (!/^https?:\/\//i.test(calendarUrl)) {
  console.error('Falta CALENDAR_URL (la página donde se agenda la llamada): el enlace de los emails redirige ahí.');
  process.exit(1);
}

const app = createCampaignApp({
  db: supabase,
  ownerId,
  webhookSecret: (process.env.INSTANTLY_WEBHOOK_SECRET || '').trim(),
  campaignId: (process.env.INSTANTLY_CAMPAIGN_ID || '').trim() || null,
  calendarUrl,
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Campaign server on port ${PORT}`));

// Who booked a call? Calendly's free plan has no webhooks, so we ask its API every 5 minutes
if (isCalendlyConfigured()) {
  const config = loadCalendlyConfig();
  let running = false;
  cron.schedule('*/5 * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const r = await syncBookings({ db: supabase, ownerId, config });
      if (r.booked || r.rescheduled) console.log(`[calendly] ${r.booked} reservas nuevas, ${r.rescheduled} cambiadas de hora`);
    } catch (err) {
      console.error('[calendly] no se pudo comprobar las reservas:', err.message);
    } finally {
      running = false;
    }
  });
  console.log('Calendly: comprobando reservas cada 5 minutos');
} else {
  console.log('Sin CALENDLY_API_TOKEN: las reservas no se detectan solas (usa el botón "Comprobar reservas" del dashboard)');
}
