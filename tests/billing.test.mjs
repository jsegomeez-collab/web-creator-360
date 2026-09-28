// /api/billing/setup-products: el precio anual es 10× el mensual (2 meses gratis), como anuncian la landing y billing.html.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_KEY = 'fake';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';

const created = [];
class FakeStripe {
  get products() { return { create: async ({ name }) => ({ id: `prod_${name}` }) }; }
  get prices() { return { create: async (p) => { created.push(p); return { id: `price_${p.nickname}` }; } }; }
}
mock.module('stripe', { exports: { default: FakeStripe } });

const { default: router } = await import('../src/routes/billing.js');

test('setup-products crea mensual y anual con importes correctos (anual = mensual × 10)', async () => {
  const layer = router.stack.find(l => l.route?.path === '/setup-products');
  const handler = layer.route.stack.at(-1).handle;      // el último es el manejador; los anteriores, requireAuth
  let out;
  await handler({}, { json: (b) => { out = b; } });

  const amount = (nick) => created.find(p => p.nickname === nick).unit_amount;
  assert.equal(amount('starter_monthly'), 4700);
  assert.equal(amount('starter_annual'), 47000);
  assert.equal(amount('pro_monthly'), 14700);
  assert.equal(amount('pro_annual'), 147000);
  assert.equal(amount('agency_monthly'), 29700);
  assert.equal(amount('agency_annual'), 297000);
  for (const plan of ['starter', 'pro', 'agency']) assert.equal(amount(`${plan}_annual`), amount(`${plan}_monthly`) * 10);
  assert.equal(created.find(p => p.nickname === 'starter_annual').recurring.interval, 'year');
  assert.deepEqual(Object.keys(out.prices).sort(), ['agency_annual', 'agency_monthly', 'pro_annual', 'pro_monthly', 'starter_annual', 'starter_monthly']);
});
