// Looks in Calendly for leads that booked a call and marks them as "booked".  Usage: npm run calendly:sync
import 'dotenv/config';
import supabase from '../src/db/supabase.js';
import { loadCalendlyConfig, syncBookings } from '../src/services/calendly.js';

const ownerId = (process.env.NEW_LEADS_OWNER_USER_ID || '').trim();
try {
  if (!ownerId) throw new Error('Falta NEW_LEADS_OWNER_USER_ID en tu .env');
  const r = await syncBookings({ db: supabase, ownerId, config: loadCalendlyConfig() });
  console.log(`Llamadas revisadas: ${r.bookings} · leads nuevos con llamada: ${r.booked} · cambiadas de hora: ${r.rescheduled} · de otras personas: ${r.unmatched}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
