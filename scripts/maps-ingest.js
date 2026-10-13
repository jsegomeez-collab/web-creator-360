// Campaign 2: searches Google Maps (through Apify) for businesses WITHOUT a website (any owner) and stores the ones whose email we find on their Facebook page.
//   npm run maps:ingest -- --dry-run                    next city of the rotation, nothing is written (it does spend Apify credit)
//   npm run maps:ingest                                 same, and stores the leads (status "new")
//   npm run maps:ingest -- --zone "Houston, TX" --category "barber shop" --max 10 --lookups 10     one specific search (a cheap test)
//   --lookups N  how many places without email get their Facebook page searched (≈ $0.015 each; default 60) · --latino-only  keep only Latino-signal places
// Needs APIFY_TOKEN (and NEW_LEADS_OWNER_USER_ID + Supabase unless --dry-run).
import 'dotenv/config';
import supabase from '../src/db/supabase.js';
import { runMapsProspect } from '../src/services/mapsProspect.js';
import { ZONES, CATEGORIES } from '../src/services/mapsZones.js';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const dryRun = args.includes('--dry-run');

try {
  const zoneQuery = flag('--zone');
  const lookups = flag('--lookups') != null ? Number(flag('--lookups')) : undefined;
  if (lookups !== undefined && (!Number.isInteger(lookups) || lookups < 0 || lookups > 500)) throw new Error('--lookups debe ser un número entre 0 y 500');
  const categoryText = flag('--category');
  const max = flag('--max') ? Number(flag('--max')) : 40;
  if (!Number.isInteger(max) || max < 1 || max > 200) throw new Error('--max debe ser un número entre 1 y 200');
  const zone = zoneQuery ? (ZONES.find(z => z.query.toLowerCase() === zoneQuery.toLowerCase()) ?? { state: zoneQuery.split(',')[1]?.trim() || null, query: zoneQuery }) : null;
  const categories = categoryText ? [CATEGORIES.find(c => c.search.toLowerCase() === categoryText.toLowerCase()) ?? { search: categoryText, sector: 'otro', latin: false }] : null;

  console.log(`Buscando en Google Maps${zone ? ` (${zone.query})` : ' (siguiente ciudad de la rotación)'}… tarda unos minutos`);
  const r = await runMapsProspect({
    db: dryRun ? null : supabase, ownerId: (process.env.NEW_LEADS_OWNER_USER_ID || '').trim() || null,
    zone, categories, maxPerSearch: max, dryRun, requireLatino: args.includes('--latino-only'), ...(lookups !== undefined ? { lookups } : {}),
  });
  console.log(`\n${r.zone} · ${r.categories.join(', ')}`);
  console.log(`${r.places} negocios sin web encontrados por Apify${r.costUsd == null ? '' : ` ($${r.costUsd.toFixed(3)} de Apify)`}`);
  console.log('Descartados:', r.skips);
  if (r.facebook) console.log(`Facebook: ${r.facebook.searched} buscados · ${r.facebook.pages} páginas encontradas · ${r.facebook.matched} son el mismo negocio · ${r.facebook.withEmail} con email`);
  console.log(`Quedan ${r.leads.length} válidos${dryRun ? ' (vista previa: no se ha guardado nada)' : ` · ${r.inserted} guardados como nuevos`}`);
  for (const l of r.leads.slice(0, 10)) console.log(` · ${l.name} — ${l.city} — ${l.email} — ${l.reviews} reseñas — ${l.notes}`);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
}
