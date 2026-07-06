import { Router } from 'express';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function stripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// Price IDs — set these after running /api/billing/setup-products (or create manually in Stripe dashboard)
const PRICES = {
  starter_monthly: process.env.STRIPE_STARTER_MONTHLY,
  starter_annual:  process.env.STRIPE_STARTER_ANNUAL,
  pro_monthly:     process.env.STRIPE_PRO_MONTHLY,
  pro_annual:      process.env.STRIPE_PRO_ANNUAL,
  agency_monthly:  process.env.STRIPE_AGENCY_MONTHLY,
  agency_annual:   process.env.STRIPE_AGENCY_ANNUAL,
};

// POST /api/billing/checkout — create Stripe Checkout session
router.post('/checkout', requireAuth, async (req, res) => {
  const { plan, interval } = req.body; // plan: starter|pro|agency, interval: monthly|annual
  const priceKey = `${plan}_${interval}`;
  const priceId = PRICES[priceKey];
  if (!priceId) return res.status(400).json({ error: 'Plan no válido' });

  const s = req.userSettings;
  let customerId = s.stripe_customer_id;

  // Create Stripe customer if not exists
  if (!customerId) {
    const customer = await stripe().customers.create({
      email: req.user.email,
      metadata: { user_id: req.user.id },
    });
    customerId = customer.id;
    await supabase.from('user_settings')
      .update({ stripe_customer_id: customerId })
      .eq('user_id', req.user.id);
  }

  const session = await stripe().checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.BASE_URL}/app.html?checkout=success`,
    cancel_url: `${process.env.BASE_URL}/billing.html`,
    subscription_data: {
      metadata: { user_id: req.user.id, plan, interval },
    },
  });

  res.json({ url: session.url });
});

// POST /api/billing/portal — Stripe Customer Portal
router.post('/portal', requireAuth, async (req, res) => {
  const customerId = req.userSettings?.stripe_customer_id;
  if (!customerId) return res.status(400).json({ error: 'No hay suscripción activa' });

  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${process.env.BASE_URL}/billing.html`,
  });

  res.json({ url: session.url });
});

// POST /api/billing/webhook — Stripe webhook handler
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe().webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const s = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      if (s.mode !== 'subscription') break;
      const sub = await stripe().subscriptions.retrieve(s.subscription);
      await updateUserPlan(sub);
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.created':
      await updateUserPlan(s);
      break;
    case 'customer.subscription.deleted':
      await cancelUserPlan(s.customer);
      break;
    case 'invoice.payment_failed':
      await supabase.from('user_settings')
        .update({ plan_status: 'past_due' })
        .eq('stripe_customer_id', s.customer);
      break;
  }

  res.json({ received: true });
});

async function updateUserPlan(sub) {
  const planName = sub.metadata?.plan || derivePlanFromPrice(sub.items?.data?.[0]?.price?.id);
  const status = sub.status === 'active' || sub.status === 'trialing' ? 'active' : sub.status;
  const expiresAt = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;

  await supabase.from('user_settings')
    .update({
      stripe_subscription_id: sub.id,
      plan: planName,
      plan_status: status,
      plan_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_customer_id', sub.customer);
}

async function cancelUserPlan(customerId) {
  await supabase.from('user_settings')
    .update({ plan: 'free', plan_status: 'canceled', stripe_subscription_id: null })
    .eq('stripe_customer_id', customerId);
}

function derivePlanFromPrice(priceId) {
  for (const [key, pid] of Object.entries(PRICES)) {
    if (pid === priceId) return key.replace('_monthly', '').replace('_annual', '');
  }
  return 'starter';
}

// POST /api/billing/setup-products — create Stripe products+prices (run once)
router.post('/setup-products', requireAuth, async (req, res) => {
  const plans = [
    { name: 'Starter', key: 'starter', monthly: 4700, annual: 47000 * 10 },
    { name: 'Pro',     key: 'pro',     monthly: 14700, annual: 147000 * 10 },
    { name: 'Agency',  key: 'agency',  monthly: 29700, annual: 297000 * 10 },
  ];

  const created = {};
  for (const p of plans) {
    const product = await stripe().products.create({ name: `Web Creator 360 ${p.name}` });
    const monthly = await stripe().prices.create({
      product: product.id,
      currency: 'eur',
      unit_amount: p.monthly,
      recurring: { interval: 'month' },
      nickname: `${p.key}_monthly`,
    });
    const annual = await stripe().prices.create({
      product: product.id,
      currency: 'eur',
      unit_amount: p.annual,
      recurring: { interval: 'year' },
      nickname: `${p.key}_annual`,
    });
    created[`${p.key}_monthly`] = monthly.id;
    created[`${p.key}_annual`] = annual.id;
  }

  res.json({
    message: 'Añade estos IDs a tu .env:',
    prices: created,
  });
});

export default router;
