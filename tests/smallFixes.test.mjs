// Arreglos pequeños: horario del pipeline en su zona horaria, precio de la web en Stripe, Vercel fuera de Windows y los
// contadores de uso de los planes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBusinessHours } from '../src/pipeline/auto.js';
import { sitePrice } from '../src/services/stripe.js';
import { vercelBin } from '../src/services/vercel.js';
import { checkLimit, USAGE_COLUMNS } from '../src/middleware/auth.js';

test('horario del pipeline: se mide en su zona horaria, no en la del servidor (Render va en UTC)', () => {
  // Lunes 29/09/2026 06:30 UTC = 08:30 en Madrid (verano, UTC+2) → dentro; en UTC serían las 6:30 → fuera
  const mondayMorning = new Date('2026-09-29T06:30:00Z');
  assert.equal(isBusinessHours(mondayMorning, 'Europe/Madrid'), true);
  assert.equal(isBusinessHours(mondayMorning, 'UTC'), false);
  // 17:30 UTC = 19:30 en Madrid → fuera
  assert.equal(isBusinessHours(new Date('2026-09-29T17:30:00Z'), 'Europe/Madrid'), false);
  // Sábado a mediodía → fuera
  assert.equal(isBusinessHours(new Date('2026-10-03T10:00:00Z'), 'Europe/Madrid'), false);
});

test('precio de la web: por defecto $497 en dólares, como dicen los emails; configurable', () => {
  assert.deepEqual(sitePrice({}), { amount: 49700, currency: 'usd' });
  assert.deepEqual(sitePrice({ STRIPE_PRICE_AMOUNT: '34700', STRIPE_CURRENCY: ' EUR ' }), { amount: 34700, currency: 'eur' });
});

test('Vercel: vercel.cmd solo en Windows; en Linux (Render) el script normal', () => {
  assert.match(vercelBin('win32'), /[\\/]vercel\.cmd$/);
  assert.match(vercelBin('linux'), /[\\/]vercel$/);
});

test('límites de los planes: leen las columnas de uso que existen en user_settings', async () => {
  assert.deepEqual(USAGE_COLUMNS, { prospects: 'prospects_this_month', sites: 'sites_generated_month', emails: 'emails_sent_month' });
  const run = (resource, settings) => new Promise((resolve) => {
    const res = { status: (code) => ({ json: (body) => resolve({ code, body }) }) };
    checkLimit(resource)({ userSettings: settings }, res, () => resolve({ code: 'next' }));
  });
  // Starter: 50 webs/mes y 500 emails/mes
  assert.equal((await run('sites', { plan: 'starter', sites_generated_month: 50 })).code, 429);
  assert.equal((await run('sites', { plan: 'starter', sites_generated_month: 49 })).code, 'next');
  assert.equal((await run('emails', { plan: 'starter', emails_sent_month: 500 })).code, 429);
  assert.equal((await run('prospects', { plan: 'starter', prospects_this_month: 100 })).code, 429);
});
