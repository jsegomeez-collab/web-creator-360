// Checks Instantly now for what happened to the leads you've already pushed: sent, bounced, unsubscribed, replied.
// The campaign server does this every 5 minutes on its own; run this by hand from your machine when you want to check
// sooner (e.g. right after a test send).  Usage: npm run instantly:poll
import 'dotenv/config';
import supabase from '../src/db/supabase.js';
import { loadInstantlyConfig } from '../src/services/instantly.js';
import { pollInstantlyEvents } from '../src/services/instantlyPoll.js';

const ownerId = (process.env.NEW_LEADS_OWNER_USER_ID || '').trim();
try {
  if (!ownerId) throw new Error('Falta NEW_LEADS_OWNER_USER_ID en tu .env');
  const config = loadInstantlyConfig(process.env, { dryRun: false });
  const r = await pollInstantlyEvents({ db: supabase, ownerId, config });
  console.log(`Leads revisados: ${r.checked} · actualizados: ${r.updated} · bajas/rebotes: ${r.suppressed} · respuestas nuevas: ${r.replied}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
