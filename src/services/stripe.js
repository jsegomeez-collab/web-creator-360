import Stripe from 'stripe';

let stripeClient;

function getClient() {
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

// What one site costs: the emails and the demo sites announce $497, so that's the default (amount in cents)
export function sitePrice(env = process.env) {
  const amount = parseInt(env.STRIPE_PRICE_AMOUNT || '49700', 10);
  const currency = String(env.STRIPE_CURRENCY || 'usd').trim().toLowerCase();
  return { amount, currency };
}

export async function createCheckoutSession(site, business) {
  const { amount, currency } = sitePrice();

  const session = await getClient().checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: [{
      price_data: {
        currency,
        product_data: {
          name: `Web para ${business.name}`,
          description: `Activación de tu web personalizada en tu propio dominio`,
        },
        unit_amount: amount,
      },
      quantity: 1,
    }],
    metadata: {
      site_id: site.id,
      business_id: business.id,
    },
    success_url: `${process.env.BASE_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.BASE_URL}/preview/${site.slug}`,
  });

  return session;
}

export function constructWebhookEvent(payload, signature) {
  return getClient().webhooks.constructEvent(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}
