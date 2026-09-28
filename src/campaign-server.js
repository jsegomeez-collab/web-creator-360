// Starts the public campaign server (see campaignApp.js). Run it with: npm run start:campaign
import 'dotenv/config';
import supabase from './db/supabase.js';
import { createCampaignApp } from './campaignApp.js';

const ownerId = (process.env.NEW_LEADS_OWNER_USER_ID || '').trim();
if (!ownerId) {
  console.error('Falta NEW_LEADS_OWNER_USER_ID: sin él el servidor no sabe a qué usuario pertenecen los leads.');
  process.exit(1);
}

const app = createCampaignApp({
  db: supabase,
  ownerId,
  webhookSecret: (process.env.INSTANTLY_WEBHOOK_SECRET || '').trim(),
  campaignId: (process.env.INSTANTLY_CAMPAIGN_ID || '').trim() || null,
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Campaign server on port ${PORT}`));
