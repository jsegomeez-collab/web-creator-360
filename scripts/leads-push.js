// Sends the newest leads that are still "new" to the Instantly campaign (Instantly then emails them on its own schedule).
//
//   npm run leads:push                 pushes up to 100 leads (with OUTREACH_DRY_RUN=true nothing is sent: it is only logged)
//   npm run leads:push -- --limit 300
import 'dotenv/config';
import supabase from '../src/db/supabase.js';
import { isDryRun } from '../src/lib/dryRun.js';
import { loadInstantlyConfig, pushLeads } from '../src/services/instantly.js';

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 100;

async function main() {
  const ownerId = (process.env.NEW_LEADS_OWNER_USER_ID || '').trim();
  if (!ownerId) throw new Error('Falta NEW_LEADS_OWNER_USER_ID en tu .env');
  const dryRun = isDryRun();
  const config = loadInstantlyConfig(process.env, { dryRun });

  console.log(dryRun ? '🧪 DRY-RUN: no se envía nada a Instantly ni se cambia ningún estado.' : '📨 Enviando leads a Instantly…');
  if (dryRun) for (const w of config.warnings) console.log(`ℹ Para enviar de verdad falta: ${w}`);

  const r = await pushLeads({ db: supabase, ownerId, config, limit, dryRun });
  if (!r.pushed && !r.rejected) return console.log('No hay leads nuevos pendientes de enviar.');
  console.log(dryRun
    ? `\nSe enviarían ${r.pushed} leads.`
    : `\n✓ ${r.pushed} leads en cola en Instantly${r.rejected ? ` · ${r.rejected} rechazados por Instantly (ya estaban en tu workspace, lista de bloqueo o email inválido)` : ''}.`);
}

// Sin process.exit(): en Windows cerrar de golpe con conexiones abiertas hace fallar a Node al salir
main().catch((err) => { console.error(`\n✗ ${err.message}`); process.exitCode = 1; });
