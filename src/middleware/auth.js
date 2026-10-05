import supabase, { getSupabase } from '../db/supabase.js';

export async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  const { data: { user }, error } = await getSupabase().auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Token inválido o expirado' });

  // Attach user + settings to request
  const { data: settings } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', user.id)
    .single();

  req.user = user;
  req.userSettings = settings || {};
  next();
}

export async function requireActivePlan(req, res, next) {
  const plan = req.userSettings?.plan || 'free';
  const status = req.userSettings?.plan_status || 'inactive';
  if (plan === 'free' || status !== 'active') {
    return res.status(402).json({ error: 'Se requiere un plan activo', redirect: '/billing.html' });
  }
  next();
}

// Plan limits per action
const LIMITS = {
  free:    { prospects: 10,   sites: 3,    emails: 10 },
  starter: { prospects: 100,  sites: 50,   emails: 500 },
  pro:     { prospects: 500,  sites: 200,  emails: 2000 },
  agency:  { prospects: 9999, sites: 9999, emails: 9999 },
};

// The usage counter of each resource in user_settings (see schema-saas.sql)
export const USAGE_COLUMNS = { prospects: 'prospects_this_month', sites: 'sites_generated_month', emails: 'emails_sent_month' };

export function checkLimit(resource) {
  return async (req, res, next) => {
    const s = req.userSettings;
    if (!s) return next();
    const plan = s.plan || 'free';
    const limit = LIMITS[plan]?.[resource] ?? 0;
    const used = s[USAGE_COLUMNS[resource]] || 0;
    if (used >= limit) {
      return res.status(429).json({
        error: `Has alcanzado el límite de ${resource} de tu plan ${plan} (${limit}/mes)`,
        upgrade: '/billing.html',
      });
    }
    next();
  };
}
