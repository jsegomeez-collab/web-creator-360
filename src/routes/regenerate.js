import { Router } from 'express';
import slugify from 'slugify';
import supabase from '../db/supabase.js';
import { generateWebsite } from '../services/claude.js';
import { deployToVercel } from '../services/vercel.js';

const router = Router();

// Regenerate a single site
router.post('/:siteId', async (req, res) => {
  const { siteId } = req.params;

  const { data: site, error: sErr } = await supabase
    .from('generated_sites').select('*').eq('id', siteId).single();
  if (sErr || !site) return res.status(404).json({ error: 'Site not found' });

  try {
    const result = await regenerateSite(site);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[regenerate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Regenerate ALL existing sites — streams NDJSON progress
router.post('/batch/all', async (req, res) => {
  const { data: sites, error } = await supabase
    .from('generated_sites')
    .select('id, slug, business_id')
    .in('status', ['preview', 'sent', 'generated', 'active']);

  if (error) return res.status(500).json({ error: error.message });
  if (!sites?.length) return res.json({ message: 'No sites to regenerate', processed: 0 });

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.flushHeaders();

  let ok = 0, failed = 0;

  for (const site of sites) {
    try {
      const result = await regenerateSite(site);
      ok++;
      res.write(JSON.stringify({ slug: site.slug, status: 'ok', preview_url: result.preview_url }) + '\n');
    } catch (err) {
      failed++;
      console.error(`[regenerate] ${site.slug}:`, err.message);
      res.write(JSON.stringify({ slug: site.slug, status: 'error', reason: err.message }) + '\n');
    }
  }

  res.write(JSON.stringify({ done: true, ok, failed, total: sites.length }) + '\n');
  res.end();
});

// ─── Core logic ───────────────────────────────────────────────────────────────
async function regenerateSite(site) {
  // Fetch business and web data with direct queries (joins fail for nested tables)
  const [{ data: business, error: bErr }, { data: webData, error: wErr }] = await Promise.all([
    supabase.from('businesses').select('*').eq('id', site.business_id).single(),
    supabase.from('business_web_data').select('*').eq('business_id', site.business_id).single(),
  ]);

  if (bErr || !business) throw new Error(`Business not found for site ${site.id}`);
  if (wErr || !webData) throw new Error(`No scraped data for "${business?.name}" — scrape it first`);

  const slug = site.slug || slugify(business.name, { lower: true, strict: true });
  const checkoutUrl = `${process.env.BASE_URL}/checkout/${site.id}`;

  console.log(`[regenerate] Generating HTML for "${business.name}"...`);
  const html = await generateWebsite(business, webData, checkoutUrl);
  const finalHtml = html.replace(/SITE_ID_PLACEHOLDER/g, site.id);

  console.log(`[regenerate] Deploying "${slug}" to Vercel...`);
  let previewUrl;
  try {
    previewUrl = await deployToVercel(slug, finalHtml);
  } catch (vercelErr) {
    console.error('[regenerate] Vercel failed, using local fallback:', vercelErr.message);
    previewUrl = `${process.env.BASE_URL}/preview/${slug}`;
  }

  await supabase
    .from('generated_sites')
    .update({ html_content: finalHtml, preview_url: previewUrl })
    .eq('id', site.id);

  return { preview_url: previewUrl, slug };
}

export default router;
