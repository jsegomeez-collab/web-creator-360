import { Router } from 'express';
import slugify from 'slugify';
import supabase from '../db/supabase.js';
import { generateWebsite } from '../services/claude.js';
import { deployToVercel } from '../services/vercel.js';

const router = Router();

router.post('/:businessId', async (req, res) => {
  const { businessId } = req.params;

  const [{ data: business, error: bErr }, { data: webData, error: wErr }] = await Promise.all([
    supabase.from('businesses').select('*').eq('id', businessId).single(),
    supabase.from('business_web_data').select('*').eq('business_id', businessId).single(),
  ]);

  if (bErr || !business) return res.status(404).json({ error: 'Business not found' });
  if (wErr || !webData) return res.status(400).json({ error: 'Business has not been scraped yet. Run scraping first.' });

  try {
    const slug = slugify(business.name, { lower: true, strict: true });
    const placeholderCheckout = `${process.env.BASE_URL}/checkout/SITE_ID_PLACEHOLDER`;

    // 1. Generate HTML with Claude
    console.log(`[generate] Generating HTML for "${business.name}"...`);
    const html = await generateWebsite(business, webData, placeholderCheckout);

    // 2. Insert/update record (without final checkout URL yet)
    const { data: site, error: sErr } = await supabase
      .from('generated_sites')
      .upsert(
        { business_id: businessId, slug, html_content: html, preview_url: null, status: 'preview' },
        { onConflict: 'slug' }
      )
      .select('id')
      .single();

    if (sErr) throw sErr;

    // 3. Patch checkout URL with real site id
    const checkoutUrl = `${process.env.BASE_URL}/checkout/${site.id}`;
    const finalHtml = html.replace(/SITE_ID_PLACEHOLDER/g, site.id);

    // 4. Deploy to Vercel
    console.log(`[generate] Deploying "${slug}" to Vercel...`);
    let previewUrl;
    try {
      previewUrl = await deployToVercel(slug, finalHtml);
      console.log(`[generate] Deployed: ${previewUrl}`);
    } catch (vercelErr) {
      console.error('[generate] Vercel deploy failed, falling back to local preview:', vercelErr.message);
      previewUrl = `${process.env.BASE_URL}/preview/${slug}`;
    }

    // 5. Save final HTML + Vercel URL
    await supabase
      .from('generated_sites')
      .update({ html_content: finalHtml, preview_url: previewUrl })
      .eq('id', site.id);

    await supabase.from('businesses').update({ status: 'generated' }).eq('id', businessId);

    res.json({ success: true, slug, preview_url: previewUrl, site_id: site.id });
  } catch (err) {
    console.error('[generate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
