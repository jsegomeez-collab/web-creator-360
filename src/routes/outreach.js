import { Router } from 'express';
import supabase from '../db/supabase.js';
import { sendOutreach } from '../services/outreach.js';

const router = Router();

// ─── Batch send ───────────────────────────────────────────────────────────────
router.post('/batch', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');

  const { data: sites } = await supabase
    .from('generated_sites')
    .select('id, slug, preview_url, business_id')
    .eq('status', 'preview')
    .not('preview_url', 'is', null);

  // Collect sites that have email OR phone — fetch both in parallel per site
  const toSend = [];
  for (const site of sites || []) {
    const [{ data: wd }, { data: biz }] = await Promise.all([
      supabase.from('business_web_data').select('email, language').eq('business_id', site.business_id).single(),
      supabase.from('businesses').select('*').eq('id', site.business_id).single(),
    ]);
    if (wd?.email || biz?.phone) {
      toSend.push({ ...site, email: wd?.email || null, language: wd?.language || 'es', biz });
    }
  }

  res.write(JSON.stringify({ status: 'start', total: toSend.length }) + '\n');

  let sent = 0, errors = 0, skipped = 0;

  for (const item of toSend) {
    try {
      // Skip if already contacted today
      const { data: existing } = await supabase
        .from('outreach_log')
        .select('id')
        .eq('site_id', item.id)
        .gte('sent_at', new Date(Date.now() - 86400000).toISOString())
        .limit(1);

      if (existing?.length) {
        skipped++;
        res.write(JSON.stringify({ status: 'skipped', slug: item.slug, reason: 'ya enviado hoy' }) + '\n');
        continue;
      }

      const biz = item.biz;
      const enrichedSite = { ...item, contact_email: item.email };
      const result = await sendOutreach(biz, enrichedSite, item.email, item.language, 0);

      sent++;
      res.write(JSON.stringify({
        status: 'ok',
        slug: item.slug,
        name: biz.name,
        email: result.emailSent ? item.email : null,
        wa: result.waSent,
        waReason: result.waReason,
        address: biz.address,
        language: item.language,
      }) + '\n');
    } catch (err) {
      errors++;
      res.write(JSON.stringify({ status: 'error', slug: item.slug, reason: err.message }) + '\n');
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  res.write(JSON.stringify({ status: 'done', sent, errors, skipped, total: toSend.length }) + '\n');
  res.end();
});

// ─── Single send ──────────────────────────────────────────────────────────────
router.post('/:siteId', async (req, res) => {
  const { siteId } = req.params;
  const { email: bodyEmail } = req.body;

  const { data: site, error: sErr } = await supabase
    .from('generated_sites')
    .select('*, businesses(*)')
    .eq('id', siteId)
    .single();

  if (sErr || !site) return res.status(404).json({ error: 'Site not found' });

  const business = site.businesses;

  const { data: webData } = await supabase
    .from('business_web_data')
    .select('email, language')
    .eq('business_id', business.id)
    .single();

  const contactEmail = bodyEmail || webData?.email || null;
  const language = webData?.language || 'es';

  // Need at least email or phone
  if (!contactEmail && !business.phone) {
    return res.status(400).json({ error: 'Sin email ni teléfono disponibles para contactar este negocio' });
  }

  // Check not already contacted today
  const { data: existing } = await supabase
    .from('outreach_log')
    .select('id')
    .eq('site_id', siteId)
    .gte('sent_at', new Date(Date.now() - 86400000).toISOString())
    .limit(1);

  if (existing?.length) {
    return res.status(409).json({ error: 'Ya contactado en las últimas 24 horas' });
  }

  try {
    const enrichedSite = { ...site, contact_email: contactEmail };
    const result = await sendOutreach(business, enrichedSite, contactEmail, language, 0);

    res.json({
      success: true,
      email: result.emailSent ? contactEmail : null,
      whatsapp: { sent: result.waSent, reason: result.waReason },
    });
  } catch (err) {
    console.error('Outreach error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
