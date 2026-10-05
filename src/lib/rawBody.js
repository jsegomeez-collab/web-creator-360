// Stripe signs the exact bytes it sends, so its webhooks need the raw body (req.rawBody) instead of parsed JSON.
// express.raw() reads it and flags the request as parsed, so the express.json() mounted after it leaves it alone (reading
// the stream by hand and then letting express.json() try again fails with "stream is not readable" → 500 to Stripe).
//   app.use(STRIPE_WEBHOOK_PATHS, stripeRawBody());   // before app.use(express.json())
import express from 'express';

export const STRIPE_WEBHOOK_PATHS = ['/webhooks/stripe', '/api/billing/webhook'];

export function stripeRawBody() {
  const raw = express.raw({ type: () => true, limit: '1mb' });
  return (req, res, next) => raw(req, res, (err) => {
    if (err) return next(err);
    req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    next();
  });
}
