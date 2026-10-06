// Makes the demo website of a lead (template + texts written by Claude Sonnet 5.5, published on Vercel) and prints its address.
//   npm run leads:demo -- correo@ejemplo.com      that lead (remakes it if it already has one)
//   npm run leads:demo -- --limit 3               the newest "new" leads that don't have one yet
// Needs ANTHROPIC_API_KEY, VERCEL_TOKEN and NEW_LEADS_OWNER_USER_ID in your .env. Each site costs roughly $0.08–0.14.
import 'dotenv/config';
import supabase from '../src/db/supabase.js';
import { loadInstantlyConfig } from '../src/services/instantly.js';
import { usageCost } from '../src/sitegen/index.js';
import { createLeadDemo, generateDemos } from '../src/services/leadDemos.js';
import { normEmail } from '../src/services/suppressions.js';
import { demoLink } from '../src/prompts/newBusinessEmails.js';

const args = process.argv.slice(2);
const ownerId = (process.env.NEW_LEADS_OWNER_USER_ID || '').trim();
const cost = (u) => (u ? ` · ${u.input_tokens} tokens de entrada (+${u.cache_creation_input_tokens || 0} a caché, ${u.cache_read_input_tokens || 0} leídos de caché), ${u.output_tokens} de salida ≈ $${usageCost(u).toFixed(3)}` : '');

try {
  if (!ownerId) throw new Error('Falta NEW_LEADS_OWNER_USER_ID en tu .env');
  for (const k of ['ANTHROPIC_API_KEY', 'VERCEL_TOKEN']) if (!process.env[k]) throw new Error(`Falta ${k} en tu .env`);
  const { publicUrl, warnings } = loadInstantlyConfig(process.env, { dryRun: true });
  if (warnings.some(w => w.startsWith('CAMPAIGN_PUBLIC_URL'))) console.warn('Aviso: sin CAMPAIGN_PUBLIC_URL, el botón "La quiero" de la demo apunta a localhost.\n');

  if (args.includes('--limit')) {
    const limit = Number(args[args.indexOf('--limit') + 1]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('--limit debe ser un número entre 1 y 20');
    console.log(`Creando hasta ${limit} webs (cada una tarda alrededor de un minuto)…`);
    const r = await generateDemos({ db: supabase, ownerId, publicUrl, limit, log: (m) => console.log(m) });
    console.log(`\n${r.created} creadas · ${r.failed} fallidas`);
  } else {
    const email = normEmail(args[0]);
    if (!email) throw new Error('Indica el email del lead (npm run leads:demo -- correo@ejemplo.com) o --limit N');
    const { data: lead, error } = await supabase.from('new_business_leads').select('*').eq('user_id', ownerId).eq('email', email).maybeSingle();
    if (error) throw new Error(error.message);
    if (!lead) throw new Error(`No hay ningún lead con el email ${email}`);
    console.log(`Creando la web de ${lead.name} (tarda alrededor de un minuto)…`);
    const r = await createLeadDemo({ db: supabase, ownerId, lead, publicUrl, force: true });
    if (!r.ok) throw new Error(r.error);
    console.log(`\n✓ Plantilla ${r.template}${cost(r.usage)}\n${demoLink(r.url)}`);
  }
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
}
