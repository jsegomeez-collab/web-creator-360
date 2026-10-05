// Webhooks de Stripe: la firma se comprueba sobre los bytes exactos, así que la ruta necesita el cuerpo sin procesar.
// Antes el cuerpo se leía a mano y luego express.json() intentaba leerlo otra vez → 500 "stream is not readable".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { stripeRawBody, STRIPE_WEBHOOK_PATHS } from '../src/lib/rawBody.js';

let server, base;
before(async () => {
  const app = express();
  app.use(STRIPE_WEBHOOK_PATHS, stripeRawBody());
  app.use(express.json());
  for (const path of STRIPE_WEBHOOK_PATHS) app.post(path, (req, res) => res.json({ raw: req.rawBody.toString('utf8') }));
  app.post('/api/otra', (req, res) => res.json({ body: req.body, raw: req.rawBody ?? null }));
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

test('los dos webhooks de Stripe llegan a su ruta con el cuerpo exacto, byte a byte', async () => {
  const body = '{ "id": "evt_1",  "type": "checkout.session.completed" }';   // espacios raros: deben conservarse
  for (const path of STRIPE_WEBHOOK_PATHS) {
    const r = await post(path, body);
    assert.equal(r.status, 200, path);
    assert.equal((await r.json()).raw, body, path);
  }
});

test('el resto de rutas siguen recibiendo el JSON ya interpretado (y sin rawBody)', async () => {
  const r = await post('/api/otra', '{"a":1}');
  assert.deepEqual(await r.json(), { body: { a: 1 }, raw: null });
});
