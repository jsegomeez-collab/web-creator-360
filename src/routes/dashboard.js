import { Router } from 'express';
import supabase from '../db/supabase.js';

const router = Router();

router.get('/stats', async (req, res) => {
  const [businesses, sites, outreach, payments] = await Promise.all([
    supabase.from('businesses').select('status'),
    supabase.from('generated_sites').select('status'),
    supabase.from('outreach_log').select('id'),
    supabase.from('payments').select('status'),
  ]);

  const bData = businesses.data || [];
  const sData = sites.data || [];

  res.json({
    businesses: {
      total: bData.length,
      prospected: bData.filter(b => b.status === 'prospected').length,
      scraped: bData.filter(b => b.status === 'scraped').length,
      generated: bData.filter(b => b.status === 'generated').length,
      active: bData.filter(b => b.status === 'active').length,
    },
    sites: {
      total: sData.length,
      preview: sData.filter(s => s.status === 'preview').length,
      sent: sData.filter(s => s.status === 'sent').length,
      active: sData.filter(s => s.status === 'active').length,
      expired: sData.filter(s => s.status === 'expired').length,
    },
    outreach: { total: (outreach.data || []).length },
    payments: {
      total: (payments.data || []).length,
      completed: (payments.data || []).filter(p => p.status === 'completed').length,
    },
  });
});

router.get('/businesses', async (req, res) => {
  const [{ data: businesses, error }, { data: webDataRows }] = await Promise.all([
    supabase.from('businesses').select('*').order('created_at', { ascending: false }).limit(200),
    supabase.from('business_web_data').select('business_id, email, description, services'),
  ]);

  if (error) return res.status(500).json({ error: error.message });

  // Index web_data by business_id for O(1) lookup
  const wdMap = {};
  for (const wd of webDataRows || []) wdMap[wd.business_id] = wd;

  const flat = (businesses || []).map(b => ({
    ...b,
    email: wdMap[b.id]?.email || null,
    description: wdMap[b.id]?.description || null,
    services: wdMap[b.id]?.services || [],
  }));

  res.json(flat);
});

router.get('/sites', async (req, res) => {
  const [{ data, error }, { data: wdRows }] = await Promise.all([
    supabase
      .from('generated_sites')
      .select('id, business_id, slug, preview_url, status, expires_at, created_at, businesses(name, category, phone)')
      .order('created_at', { ascending: false })
      .limit(100),
    supabase.from('business_web_data').select('business_id, email'),
  ]);

  if (error) return res.status(500).json({ error: error.message });

  const wdMap = {};
  for (const wd of wdRows || []) wdMap[wd.business_id] = wd.email;

  const withEmail = (data || []).map(s => ({ ...s, scraped_email: wdMap[s.business_id] || null }));
  res.json(withEmail);
});

router.get('/outreach', async (req, res) => {
  const { data, error } = await supabase
    .from('outreach_log')
    .select('*, businesses(name), generated_sites(slug)')
    .order('sent_at', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/payments', async (req, res) => {
  const { data, error } = await supabase
    .from('payments')
    .select('*, businesses(name), generated_sites(slug, preview_url)')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;
