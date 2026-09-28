// Prints the link of a lead (what {{calendario}} becomes in its email), to open the page yourself.
//   npm run leads:link -- correo@ejemplo.com
// Opening it counts as the lead opening its email (status "engaged"): use it with a TEST lead (e.g. import a CSV row with your
// own email), not with a real one.
import 'dotenv/config';
import supabase from '../src/db/supabase.js';
import { loadInstantlyConfig, leadLinkUrl } from '../src/services/instantly.js';
import { normEmail } from '../src/services/suppressions.js';

const ownerId = (process.env.NEW_LEADS_OWNER_USER_ID || '').trim();
const email = normEmail(process.argv[2]);

try {
  if (!ownerId) throw new Error('Falta NEW_LEADS_OWNER_USER_ID en tu .env');
  if (!email) throw new Error('Indica el email del lead: npm run leads:link -- correo@ejemplo.com');

  const { data: lead, error } = await supabase.from('new_business_leads').select('name, status, link_token').eq('user_id', ownerId).eq('email', email).maybeSingle();
  if (error) throw new Error(error.message);
  if (!lead) throw new Error(`No hay ningún lead con el email ${email}. Impórtalo primero desde "LLCs nuevas → Fuentes".`);

  const config = loadInstantlyConfig(process.env, { dryRun: true });
  console.log(`${lead.name} (${lead.status})\n${leadLinkUrl(config, lead.link_token)}`);
  if (config.warnings.some(w => w.startsWith('CAMPAIGN_PUBLIC_URL'))) console.warn('\nAviso: CAMPAIGN_PUBLIC_URL no está en tu .env (o no es una URL https pública): el enlace apunta a localhost.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
