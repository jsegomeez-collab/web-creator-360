import { Router } from 'express';
import supabase from '../db/supabase.js';
import { scrapeBusinessProfile } from '../services/gemini.js';

const router = Router();

router.post('/:businessId', async (req, res) => {
  const { businessId } = req.params;

  const { data: business, error: bErr } = await supabase
    .from('businesses')
    .select('*')
    .eq('id', businessId)
    .single();

  if (bErr || !business) return res.status(404).json({ error: 'Business not found' });

  try {
    const profile = await scrapeBusinessProfile(business);

    const { description, services, social_networks, hours, language, email, value_proposition, phone } = profile;

    // Upsert web data
    const { error: insertErr } = await supabase
      .from('business_web_data')
      .upsert(
        { business_id: businessId, description, services, social_networks, hours, language, email, value_proposition, raw_data: profile },
        { onConflict: 'business_id' }
      );

    if (insertErr) throw insertErr;

    // Update businesses status + phone (freshly scraped always wins over Google Places)
    const bizUpdate = { status: 'scraped' };
    if (phone) bizUpdate.phone = phone;
    await supabase.from('businesses').update(bizUpdate).eq('id', businessId);

    res.json({ success: true, profile });
  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
