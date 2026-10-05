import { Router } from 'express';
import supabase from '../db/supabase.js';
import { selectAll } from '../lib/selectAll.js';

const router = Router();

// Every row's status (all pages: Supabase caps a single response at 1000 rows)
const statuses = (table) => selectAll(() => supabase.from(table).select('id, status').order('id'));

// business_id → web data row, only for the given businesses (a full-table read would stop at 1000 rows)
async function webDataFor(businessIds, columns) {
  const ids = [...new Set(businessIds.filter(Boolean))];
  const map = {};
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await supabase.from('business_web_data').select(`business_id, ${columns}`).in('business_id', ids.slice(i, i + 150));
    for (const wd of data || []) map[wd.business_id] = wd;
  }
  return map;
}

router.get('/stats', async (req, res) => {
  try {
    const [bData, sData, oData, pData] = await Promise.all([
      statuses('businesses'),
      statuses('generated_sites').then(rows => rows.filter(r => r.status !== 'demo')),   // LLC demos live in their own tab
      selectAll(() => supabase.from('outreach_log').select('id').order('id')),
      statuses('payments'),
    ]);

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
      outreach: { total: oData.length },
      payments: {
        total: pData.length,
        completed: pData.filter(p => p.status === 'completed').length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/businesses', async (req, res) => {
  const { data: businesses, error } = await supabase.from('businesses').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: error.message });

  const wdMap = await webDataFor((businesses || []).map(b => b.id), 'email, description, services');
  const flat = (businesses || []).map(b => ({
    ...b,
    email: wdMap[b.id]?.email || null,
    description: wdMap[b.id]?.description || null,
    services: wdMap[b.id]?.services || [],
  }));

  res.json(flat);
});

router.get('/sites', async (req, res) => {
  const { data, error } = await supabase
    .from('generated_sites')
    .select('id, business_id, slug, preview_url, status, expires_at, created_at, businesses(name, category)')
    .neq('status', 'demo')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });

  const wdMap = await webDataFor((data || []).map(s => s.business_id), 'email');
  const withEmail = (data || []).map(s => ({ ...s, scraped_email: wdMap[s.business_id]?.email || null }));
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
