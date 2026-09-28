// Runs ONE sending cycle of the new-business email sequence (what the cron will run every 30 minutes).
//
//   npm run ct:send                                   with OUTREACH_DRY_RUN=true: nothing is sent, everything is logged
//   npm run ct:send -- --now "2026-10-05T10:00:00-04:00"   simulate any moment (e.g. a Monday 10:00 in Connecticut)
//   npm run ct:send -- --limit 5                      send at most 5 emails in this cycle
//   npm run ct:send -- --yes                          REAL sending (OUTREACH_DRY_RUN must be false). Needs --yes on purpose.
//   npm run ct:send -- --reset-dry-run                put back to "new" the leads a dry-run marked as emailed
import 'dotenv/config';
import { isDryRun } from '../src/lib/dryRun.js';
import { formatClock, SEND_TZ, OPS_TZ } from '../src/lib/time.js';
import { loadCampaignConfig } from '../src/services/campaignConfig.js';
import { mailboxesForCycle, createMailer, describeMailbox } from '../src/services/coldMailer.js';
import { runSendCycle, resetDryRunLeads } from '../src/services/leadSequence.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const die = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

const ownerId = (process.env.NEW_LEADS_OWNER_USER_ID || '').trim();
if (!ownerId || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) die('Faltan SUPABASE_URL, SUPABASE_SERVICE_KEY o NEW_LEADS_OWNER_USER_ID en tu .env');
const db = (await import('../src/db/supabase.js')).default;

const dryRun = isDryRun();
let now = new Date();
if (val('--now')) {
  now = new Date(val('--now'));
  if (Number.isNaN(now.getTime())) die('--now no es una fecha válida. Ejemplo: --now "2026-10-05T10:00:00-04:00"');
}
const limit = val('--limit') != null ? Number(val('--limit')) : null;
if (limit != null && (!Number.isInteger(limit) || limit < 0)) die('--limit debe ser un número entero ≥ 0');

async function main() {
  if (flag('--reset-dry-run')) {
    const n = await resetDryRunLeads(db, ownerId);
    console.log(`✓ ${n} lead(s) de pruebas devueltos al estado "new".`);
    return;
  }

  if (!dryRun && !flag('--yes')) {
    throw new Error('OUTREACH_DRY_RUN no es "true": esto ENVIARÁ emails reales. Si es lo que quieres, repite el comando añadiendo --yes.\n  (Para probar sin enviar, pon OUTREACH_DRY_RUN=true en tu .env.)');
  }

  const config = loadCampaignConfig(process.env, { dryRun });
  const mailboxes = mailboxesForCycle(process.env, { dryRun });
  console.log(`${dryRun ? '🧪 DRY-RUN (no se envía nada)' : '📨 ENVÍO REAL'} · momento simulado: ${now.toISOString()} (${formatClock(now, SEND_TZ)} en Connecticut · ${formatClock(now, OPS_TZ)} en Madrid)`);
  console.log(`Buzones: ${mailboxes.length ? mailboxes.map(m => `${m.id} (${m.dailyLimit}/día)`).join(', ') : 'ninguno'}`);
  for (const w of config.warnings) if (dryRun) console.log(`ℹ Para enviar de verdad falta: ${w}`);

  const mailer = createMailer({ dryRun });
  const r = await runSendCycle({ db, ownerId, mailboxes, mailer, config, now, dryRun, limit });
  mailer.close();

  if (r.skipped === 'no_mailboxes') throw new Error('No hay buzones. Define COLD_MAILBOXES en tu .env (o pon OUTREACH_DRY_RUN=true para probar con un buzón de mentira).');
  if (r.skipped === 'outside_window') {
    console.log('\nFuera de horario de envío (lunes a viernes, 9:00-17:00 hora de Connecticut). No se ha hecho nada.');
    console.log('Para probar igualmente, simula un momento dentro del horario con --now (ver arriba).');
    return;
  }

  console.log(`\nResultado: ${r.sent} enviados · ${r.bounced} rebotes · ${r.suppressed} suprimidos · ${r.errors} errores · ${r.deferred} aplazados a otro ciclo`);
  for (const [id, m] of Object.entries(r.mailboxes)) {
    console.log(`  buzón ${id}: enviados hoy antes ${m.sentBefore}/${m.dailyLimit} · cuota de este ciclo ${m.quota} · enviados ahora ${m.sent}${m.stopped ? ' · PAUSADO por fallos' : ''}`);
  }
  if (r.released || r.orphaned) console.log(`  liberados ${r.released} · sin poder continuar ${r.orphaned}`);
  if (r.results.length) {
    console.log('\nDetalle:');
    for (const x of r.results) console.log(`  email ${x.step + 1} · ${x.outcome.padEnd(13)} · ${x.mailbox} · ${x.name}`);
  }
  if (dryRun && r.sent) console.log('\n(Los leads de esta prueba quedan marcados; cuando envíes de verdad se restauran solos. También puedes usar --reset-dry-run.)');
}

// Sin process.exit(): en Windows cerrar de golpe con conexiones de red abiertas hace fallar a Node al salir
main().catch((err) => {
  console.error(`
✗ ${err.message}`);
  process.exitCode = 1;
});
