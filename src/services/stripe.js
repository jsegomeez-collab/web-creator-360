import Stripe from 'stripe';

let stripeClient;

function getClient() {
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

export async function createCheckoutSession(site, business) {
  const amount = parseInt(process.env.STRIPE_PRICE_AMOUNT || '29900', 10);

  const session = await getClient().checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'eur',
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
