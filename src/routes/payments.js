import { Router } from 'express';
import supabase from '../db/supabase.js';
import { createCheckoutSession, constructWebhookEvent } from '../services/stripe.js';

const router = Router();

// Redirect to Stripe Checkout
router.get('/checkout/:siteId', async (req, res) => {
  const { siteId } = req.params;

  const { data: site, error: sErr } = await supabase
    .from('generated_sites')
    .select('*, businesses(*)')
    .eq('id', siteId)
    .single();

  if (sErr || !site) return res.status(404).send('Preview not found');

  try {
    const session = await createCheckoutSession(site, site.businesses);
    res.redirect(303, session.url);
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).send('Error creating checkout session');
  }
});

// Stripe webhook — raw body needed
router.post('/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = constructWebhookEvent(req.rawBody, sig);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { site_id, business_id } = session.metadata;

    await supabase.from('payments').insert({
      business_id,
      site_id,
      stripe_session_id: session.id,
      amount: session.amount_total,
      currency: session.currency,
      status: 'completed',
    });

    await supabase.from('generated_sites').update({ status: 'active' }).eq('id', site_id);
    await supabase.from('businesses').update({ status: 'active' }).eq('id', business_id);
  }

  res.json({ received: true });
});

// Payment success page
router.get('/payment/success', async (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Pago completado</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="min-h-screen flex items-center justify-center bg-green-50">
  <div class="text-center p-8 max-w-md">
    <div class="text-6xl mb-4">✓</div>
    <h1 class="text-2xl font-bold text-green-800 mb-2">¡Pago completado!</h1>
    <p class="text-green-700">Tu web ha sido activada. Nos pondremos en contacto contigo en breve para configurar tu dominio.</p>
  </div>
</body>
</html>`);
});

export default router;
