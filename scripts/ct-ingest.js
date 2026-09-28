// Downloads new Connecticut companies, keeps the Latino-owned ones with their own email, and (unless --dry-run) stores them.
//
//   npm run ct:ingest -- --days 90 --dry-run     shows how many leads would enter, by sector and priority. Writes NOTHING.
//   npm run ct:ingest                            real run: resumes from the last run (first run: last 90 days)
//   npm run ct:ingest -- --days 30               real run over the last 30 days
//
// Extra options:  --all (dry-run only: also count companies without a Latino signal)
//                 --no-mx (skip the DNS check of email domains)
//                 --json file.json (use a file downloaded earlier instead of the API)
import 'dotenv/config';
import { readFileSync } from 'fs';
import { runCtIngest } from '../src/services/ctIngest.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const val = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const dryRun = flag('--dry-run');
const days = val('--days') != null ? Number(val('--days')) : null;
if (days != null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
  console.error('--days debe ser un número entero entre 1 y 3650');
  process.exit(1);
}
if (flag('--all') && !dryRun) {
  console.error('--all solo se puede usar junto con --dry-run (en una ejecución real solo entran negocios con señal latina)');
  process.exit(1);
}

const n = (x) => Number(x).toLocaleString('es-ES');
const line = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${n(v)}`).join(' · ');

// Database: needed for a real run; in dry-run it's used only to READ (so already-stored leads and unsubscribes are subtracted)
let db = null;
const ownerId = (process.env.NEW_LEADS_OWNER_USER_ID || '').trim() || null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY && ownerId) {
  db = (await import('../src/db/supabase.js')).default;
}
if (!dryRun && !db) {
  console.error('Para una ejecución real hacen falta SUPABASE_URL, SUPABASE_SERVICE_KEY y NEW_LEADS_OWNER_USER_ID en tu .env.');
  console.error('(Sin ellos puedes probar con --dry-run.)');
  process.exit(1);
}

let rows = null;
if (val('--json')) rows = JSON.parse(readFileSync(val('--json'), 'utf8'));

try {
  console.log(rows ? `Usando ${rows.length} registros del archivo ${val('--json')}…` : 'Descargando empresas registradas en Connecticut…');
  const r = await runCtIngest({ db, ownerId, days, dryRun, latinOnly: !flag('--all'), verify: !flag('--no-mx'), rows });

  console.log(`\nVentana: desde ${r.since}${r.watermark ? ` (continúa desde la última ingesta, ${r.watermark}, con 2 días de margen)` : ''}`);
  console.log(`Registros activos con email: ${n(r.fetched)}`);
  console.log('Descartados:');
  console.log(`  · email de gestoría/agente: ${n(r.stats.gestoriaDomain)}   · email compartido por 4+ empresas: ${n(r.stats.sharedEmail)}`);
  console.log(`  · sociedades patrimoniales/financieras: ${n(r.stats.nonOperating)}   · sin señal latina: ${n(r.stats.notLatino)}`);
  const s = r.skipped;
  if (s.existing + s.suppressed + s.emailTaken + s.batchDuplicate) {
    console.log(`  · ya en tu base de datos: ${n(s.existing)}   · en supresiones: ${n(s.suppressed)}   · email ya asignado a otro lead: ${n(s.emailTaken)}   · email repetido en el lote: ${n(s.batchDuplicate)}`);
  }
  if (r.invalid.length) console.log(`  · email que no puede recibir correo (DNS): ${n(r.invalid.length)} (${line(r.invalidReasons)})`);

  const sum = r.summary;
  console.log(`\nLeads que ${dryRun ? 'entrarían' : 'han entrado'}: ${n(sum.total)}`);
  if (sum.total) {
    console.log(`  Prioridad: ${line(sum.byPriority)}   ·   nombre en español (fuerte): ${n(sum.latinoStrong)}   ·   minoría declarada: ${n(sum.minorityOwned)}`);
    console.log(`  Por sector: ${line(sum.bySector)}`);
    console.log(`  Registradas entre ${sum.oldest} y ${sum.newest}`);
  }
  for (const note of r.notes) console.log(`\nℹ ${note}`);
  console.log(dryRun ? '\n[dry-run] No se ha escrito nada en la base de datos ni se ha enviado nada.' : `\n✓ Guardados ${n(r.inserted)} registros (${n(r.invalid.length)} marcados invalid_email).`);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  if (/relation|does not exist|schema cache|column/i.test(err.message)) {
    console.error('  ¿Has ejecutado src/db/schema-new-business-leads.sql en el SQL editor de Supabase?');
  }
  process.exit(1);
}
