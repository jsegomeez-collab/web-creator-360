import { Router } from 'express';
import supabase from '../db/supabase.js';
import { sendOutreachEmail, nextFollowUpDate } from '../services/resend.js';
import { getConnectionState, sendText, buildMessage, formatPhone } from '../services/whatsapp.js';

const router = Router();

router.post('/batch', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');

  const { data: sites } = await supabase
    .from('generated_sites')
    .select('id, slug, preview_url, business_id')
    .eq('status', 'preview')
    .not('preview_url', 'is', null);

  // Collect sites that have a scraped email
  const toSend = [];
  for (const site of sites || []) {
    const { data: wd } = await supabase
      .from('business_web_data')
      .select('email, language')
      .eq('business_id', site.business_id)
      .single();
    if (wd?.email) toSend.push({ ...site, email: wd.email, language: wd.language || 'es' });
  }

  res.write(JSON.stringify({ status: 'start', total: toSend.length }) + '\n');

  let sent = 0, errors = 0, skipped = 0;

  for (const item of toSend) {
    try {
      const { data: existing } = await supabase
        .from('outreach_log')
        .select('id')
        .eq('site_id', item.id)
        .gte('sent_at', new Date(Date.now() - 86400000).toISOString())
        .limit(1);

      if (existing?.length) {
        skipped++;
        res.write(JSON.stringify({ slug: item.slug, status: 'skipped', reason: 'ya enviado hoy' }) + '\n');
        continue;
      }

      const { data: biz } = await supabase.from('businesses').select('*').eq('id', item.business_id).single();
      await sendOutreachEmail(biz, { ...item, contact_email: item.email }, 0, item.language);

      await supabase.from('outreach_log').insert({
        business_id: biz.id,
        site_id: item.id,
        channel: 'email',
        contact: item.email,
        follow_up_number: 0,
        next_follow_up_at: nextFollowUpDate(0),
      });
      await supabase.from('generated_sites').update({ status: 'sent' }).eq('id', item.id);
      await supabase.from('businesses').update({ status: 'active' }).eq('id', biz.id);

      const wa = await tryWhatsApp(biz, { ...item, contact_email: item.email }, item.language);

      sent++;
      res.write(JSON.stringify({ status: 'ok', slug: item.slug, name: biz.name, email: item.email, language: item.language, wa: wa.sent }) + '\n');
    } catch (err) {
      errors++;
      res.write(JSON.stringify({ status: 'error', slug: item.slug, reason: err.message }) + '\n');
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  res.write(JSON.stringify({ status: 'done', sent, errors, skipped, total: toSend.length }) + '\n');
  res.end();
});

router.post('/:siteId', async (req, res) => {
  const { siteId } = req.params;
  const { email } = req.body;

  const { data: site, error: sErr } = await supabase
    .from('generated_sites')
    .select('*, businesses(*)')
    .eq('id', siteId)
    .single();

  if (sErr || !site) return res.status(404).json({ error: 'Site not found' });

  const business = site.businesses;

  // Fetch web_data directly (nested join fails for this FK direction)
  const { data: webData } = await supabase
    .from('business_web_data')
    .select('email, language')
    .eq('business_id', business.id)
    .single();

  const scrapedEmail = webData?.email || null;
  const contactEmail = email || scrapedEmail || null;
  const language = webData?.language || 'es';

  if (!contactEmail) {
    return res.status(400).json({ error: 'No email address available. Provide one in the request body: { "email": "..." }' });
  }

  // Check not already contacted today
  const { data: existing } = await supabase
    .from('outreach_log')
    .select('id')
    .eq('site_id', siteId)
    .gte('sent_at', new Date(Date.now() - 86400000).toISOString())
    .limit(1);

  if (existing && existing.length > 0) {
    return res.status(409).json({ error: 'Already contacted in the last 24 hours' });
  }

  try {
    const enrichedSite = { ...site, contact_email: contactEmail };
    await sendOutreachEmail(business, enrichedSite, 0, language);

    await supabase.from('outreach_log').insert({
      business_id: business.id,
      site_id: siteId,
      channel: 'email',
      contact: contactEmail,
      follow_up_number: 0,
      next_follow_up_at: nextFollowUpDate(0),
    });

    await supabase.from('generated_sites').update({ status: 'sent' }).eq('id', siteId);

    const waResult = await tryWhatsApp(business, { ...site, contact_email: contactEmail }, language);
    res.json({ success: true, contact: contactEmail, whatsapp: waResult });
  } catch (err) {
    console.error('Outreach error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function tryWhatsApp(business, site, language) {
  if (!business.phone) return { sent: false, reason: 'no phone' };
  try {
    const state = await getConnectionState();
    if (state !== 'open') return { sent: false, reason: 'wa_disconnected' };
    const msg = buildMessage(business, site, language);
    await sendText(business.phone, msg);
    console.log(`[wa] Sent to ${formatPhone(business.phone)} for "${business.name}"`);
    return { sent: true };
  } catch (err) {
    console.warn(`[wa] Failed for "${business.name}":`, err.message);
    return { sent: false, reason: err.message };
  }
}

export default router;
