// Frees slots in Instantly (the Growth plan allows 1,000 leads): removes, oldest first, the leads that can no longer matter
// (see services/instantlyCleanup.js). The campaign server does it by itself every day when the free slots get low.
//   npm run instantly:cleanup -- --dry-run      shows what it would remove, changes nothing
//   npm run instantly:cleanup -- --force --max 100 --dry-run
//   npm run instantly:cleanup                   removes only what is needed to keep 250 slots free
//   npm run instantly:cleanup -- --force --max 100   removes up to 100 now, even if there is room
//   --min-age N  minimum days since the email was sent (default 8)
import 'dotenv/config';
import supabase from '../src/db/supabase.js';
import { loadInstantlyConfig } from '../src/services/instantly.js';
import { cleanupInstantly, leadHeadroom, MIN_AGE_DAYS, MAX_PER_RUN } from '../src/services/instantlyCleanup.js';

const args = process.argv.slice(2);
const num = (name, fallback) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);

try {
  const ownerId = (process.env.NEW_LEADS_OWNER_USER_ID || '').trim();
  if (!ownerId) throw new Error('Falta NEW_LEADS_OWNER_USER_ID en tu .env');
  const config = loadInstantlyConfig(process.env, { dryRun: true });
  if (!config.apiKey) throw new Error('Falta INSTANTLY_API_KEY en tu .env');
  const max = num('--max', MAX_PER_RUN), minAgeDays = num('--min-age', MIN_AGE_DAYS);
  if (!Number.isInteger(max) || max < 1 || max > 1000) throw new Error('--max debe ser un número entre 1 y 1000');
  if (!Number.isFinite(minAgeDays) || minAgeDays < 1) throw new Error('--min-age debe ser un número de días (mínimo 1)');

  const before = await leadHeadroom(config);
  console.log(`Instantly: ${before.count} leads de ${before.limit} permitidos (${before.free} libres)`);
  const r = await cleanupInstantly({ db: supabase, ownerId, config, max, minAgeDays, force: args.includes('--force'), dryRun: args.includes('--dry-run') });
  if (r.skipped) { console.log(`Nada que limpiar: ${r.skipped}`); process.exit(0); }
  console.log(`${r.dryRun ? '(vista previa: no se ha borrado nada) ' : ''}Objetivo: liberar ${r.need} huecos`);
  console.log(`  ${r.dryRun ? 'Se borrarían' : 'Borrados'}: ${r.removed}  (enviados sin abrir la web: ${r.tier1} · rebotados/bajas/rechazados: ${r.tier2})`);
  console.log(`  Ya no estaban en Instantly: ${r.alreadyGone} (solo se olvida su ID) · Conservados por seguridad: ${r.kept}`);
  if (!r.dryRun) { const after = await leadHeadroom(config); console.log(`Instantly ahora: ${after.count} leads (${after.free} libres)`); }
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
}
