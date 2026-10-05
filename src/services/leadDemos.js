// The demo website of a new-business lead, made BEFORE the lead goes to Instantly (the email links to it as {{web}}):
//   template engine (Claude Sonnet 5.5 writes the texts) → demo bar + visit beacon → Vercel → saved on the lead
// A lead is claimed first (demo_status 'generating'), so the autopilot and the dashboard never make the same demo twice.
import slugify from 'slugify';
import { buildSite, chooseTemplate, brandName } from '../sitegen/index.js';
import { deployToVercel } from './vercel.js';
import { esc } from '../lib/pages.js';

const TABLE = 'new_business_leads';

// "Sol Tax" + token → "sol-tax-k3x9" (Vercel project names: lowercase letters, digits and dashes, ≤ 52 characters)
export function demoSlug(lead) {
  const base = slugify(brandName(lead.name).brand, { lower: true, strict: true }).slice(0, 40).replace(/-+$/, '') || 'web';
  const tag = String(lead.link_token || lead.id || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4) || 'demo';
  return `${base}-${tag}`;
}

// What turns a site into the lead's demo: not indexed, a small bar that says it's a sample made for them (with the way to
// ask for it), and a beacon that tells the campaign server the owner opened it (→ "engaged").
export function decorateDemo(html, { brand, requestUrl, beaconUrl }) {
  const bar = `
<!-- demo: barra de muestra + aviso de visita (lo añade Web Creator 360 a cada demo) -->
<style>
.wc-demo{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:14px;max-width:calc(100vw - 24px);padding:10px 10px 10px 18px;border-radius:999px;background:rgba(17,17,17,.92);color:#fff;font:500 14px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 12px 32px -12px rgba(0,0,0,.55)}
.wc-demo span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wc-demo a{flex:none;padding:9px 16px;border-radius:999px;background:#fff;color:#111;font-weight:700;text-decoration:none}
.wc-demo button{flex:none;width:30px;height:30px;border:0;border-radius:50%;background:transparent;color:#fff;font-size:18px;line-height:1;cursor:pointer}
.wc-demo a:focus-visible,.wc-demo button:focus-visible{outline:2px solid #fff;outline-offset:2px}
@media (max-width:760px){.wc-demo{bottom:88px;width:calc(100vw - 24px);border-radius:18px;font-size:12.5px;gap:8px;padding-left:14px}.wc-demo span{white-space:normal;line-height:1.35}}
</style>
<div class="wc-demo" role="complementary" aria-label="Web de muestra">
  <span>Web de muestra para ${esc(brand)} · fotos y datos de ejemplo</span>
  <a href="${esc(requestUrl)}">La quiero</a>
  <button type="button" aria-label="Cerrar" onclick="this.parentNode.remove()">×</button>
</div>
<script>
setTimeout(function(){try{var u=${JSON.stringify(beaconUrl)};if(navigator.sendBeacon)navigator.sendBeacon(u);else fetch(u,{method:'POST',mode:'no-cors',keepalive:true});}catch(e){}},1500);
</script>
`;
  return html
    .replace(/<head([^>]*)>/i, (m) => `${m}\n<meta name="robots" content="noindex, nofollow">`)
    .replace(/<\/body>(?![\s\S]*<\/body>)/i, `${bar}</body>`);
}

// The facts the engine gets from a lead (no phone: the registry doesn't give one, so the template's sample stays)
export const leadBusiness = (lead) => ({
  name: lead.name, city: lead.city, state: 'CT', email: lead.email, sector: lead.sector,
  naics_code: lead.naics_code, activity: lead.naics_code || null, registered_at: lead.registered_at,
});

// Makes, publishes and saves the demo of one lead → { ok, url?, template?, usage?, error?, skipped? }
//   publicUrl: the campaign server (the demo links back to it) · force: remake a demo that is ready or failed
//   build / deploy: replaceable in tests
export async function createLeadDemo({ db, ownerId, lead, publicUrl, force = false, build = buildSite, deploy = deployToVercel, now = () => new Date() }) {
  // Claim: only the call that flips demo_status gets to make it
  const from = lead.demo_status ?? null;
  // A demo stuck in 'generating' for 20+ minutes means the process died half-way: it can be made again
  const stuck = from === 'generating' && Date.parse(lead.updated_at || 0) < now().getTime() - 20 * 60_000;
  if (from === 'generating' && !stuck) return { ok: false, skipped: true, error: 'ya se está creando' };
  if (!force && !stuck && from !== null) return { ok: false, skipped: true, error: `la demo ya está ${from}` };
  let claim = db.from(TABLE).update({ demo_status: 'generating', demo_error: null, updated_at: now().toISOString() }).eq('id', lead.id).eq('user_id', ownerId);
  claim = from === null ? claim.is('demo_status', null) : claim.eq('demo_status', from);
  const { data: claimed, error: claimErr } = await claim.select('id');
  if (claimErr) throw new Error(`reservar lead: ${claimErr.message}`);
  if (!claimed?.length) return { ok: false, skipped: true, error: 'otra tarea la está creando' };

  const business = leadBusiness(lead);
  const template = chooseTemplate(business);
  try {
    const site = await build({ business, template });
    const html = decorateDemo(site.html, {
      brand: brandName(lead.name).brand,
      requestUrl: `${publicUrl}/c/${lead.link_token}`,
      beaconUrl: `${publicUrl}/v/${lead.link_token}`,
    });
    const slug = demoSlug(lead);
    const url = await deploy(slug, html);

    const stamp = now().toISOString();
    const { data: saved, error: siteErr } = await db.from('generated_sites')
      .upsert({ slug, html_content: html, preview_url: url, status: 'demo' }, { onConflict: 'slug' })
      .select('id').single();
    if (siteErr) throw new Error(`guardar la web: ${siteErr.message}`);
    const { error: leadErr } = await db.from(TABLE).update({
      demo_status: 'ready', demo_url: url, demo_template: site.template, demo_at: stamp, demo_error: null, site_id: saved?.id ?? null, updated_at: stamp,
    }).eq('id', lead.id);
    if (leadErr) throw new Error(`guardar la demo en el lead: ${leadErr.message}`);
    return { ok: true, url, template: site.template, usage: site.usage };
  } catch (err) {
    const message = String(err.message || err).slice(0, 500);
    await db.from(TABLE).update({ demo_status: 'failed', demo_error: message, updated_at: now().toISOString() }).eq('id', lead.id);
    return { ok: false, template, error: message };
  }
}

// Makes demos for the newest "new" leads that don't have one yet, one after another → { created, failed, results }
export async function generateDemos({ db, ownerId, publicUrl, limit = 3, build, deploy, log = () => {} }) {
  const { data: leads, error } = await db.from(TABLE).select('*').eq('user_id', ownerId).eq('status', 'new').is('demo_status', null)
    .order('registered_at', { ascending: false }).order('id').limit(limit);
  if (error) throw new Error(`cargar leads: ${error.message}`);
  const results = [];
  for (const lead of leads || []) {
    const r = await createLeadDemo({ db, ownerId, lead, publicUrl, build, deploy });
    log(r.ok ? `✓ ${lead.name} → ${r.url}` : `✗ ${lead.name}: ${r.error}`);
    results.push({ id: lead.id, name: lead.name, ...r });
  }
  return { created: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok && !r.skipped).length, results };
}

// How many "new" leads already have their demo ready (waiting to be sent)
export async function readyDemoCount(db, ownerId) {
  const { data, error } = await db.from(TABLE).select('id').eq('user_id', ownerId).eq('status', 'new').eq('demo_status', 'ready').limit(1000);
  if (error) throw new Error(error.message);
  return (data || []).length;
}

// "All" mode: keeps making demos, a few at a time, until no "new" lead is left without one (failed ones are not retried,
// so it always ends) or `maxMs` runs out — the next cycle picks up where this one stopped.
export async function generateAllDemos({ db, ownerId, publicUrl, batch = 5, maxMs = 25 * 60_000, build, deploy, log = () => {}, now = () => Date.now() }) {
  const deadline = now() + maxMs;
  let created = 0, failed = 0;
  while (now() < deadline) {
    const r = await generateDemos({ db, ownerId, publicUrl, limit: batch, build, deploy, log });
    created += r.created; failed += r.failed;
    if (!r.results.length) break;
  }
  return { created, failed };
}
