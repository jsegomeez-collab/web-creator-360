import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ALLOWED_KEYS = [
  'anthropic_api_key', 'resend_api_key', 'resend_from_email',
  'google_places_api_key', 'vercel_token', 'vercel_scope',
];

// GET /api/settings — return user settings (mask secret keys)
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', req.user.id)
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Mask API keys (show last 4 chars only)
  const masked = { ...data };
  for (const k of ALLOWED_KEYS) {
    if (masked[k]) masked[k] = '••••••••' + masked[k].slice(-4);
  }

  res.json(masked);
});

// PUT /api/settings — update API keys
router.put('/', requireAuth, async (req, res) => {
  const updates = {};
  for (const k of ALLOWED_KEYS) {
    if (req.body[k] !== undefined && !req.body[k].startsWith('••••')) {
      updates[k] = req.body[k] || null;
    }
  }
  updates.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from('user_settings')
    .update(updates)
    .eq('user_id', req.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// GET /api/settings/plan — plan info
router.get('/plan', requireAuth, async (req, res) => {
  const s = req.userSettings;
  res.json({
    plan: s.plan || 'free',
    status: s.plan_status || 'inactive',
    expires_at: s.plan_expires_at,
    usage: {
      prospects: s.prospects_this_month || 0,
      sites: s.sites_generated_month || 0,
      emails: s.emails_sent_month || 0,
    },
  });
});

export default router;
