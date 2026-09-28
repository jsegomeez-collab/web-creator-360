// The PUBLIC server of the new-business campaign (deployed on its own, e.g. on Render). It only exposes what has to be
// reachable from the internet: the webhook Instantly calls and the lead's own link in the emails (the page to ask for the
// call). It has no dashboard, so it can be public even though the full app's routes have no login.
//   onRequested(lead, values)  a lead asked for a call (first time)      → the Telegram alert
//   onReply(lead)              a lead replied to the email (first time)  → the Telegram alert
import express from 'express';
import { instantlyWebhookRouter } from './routes/instantlyWebhook.js';
import { leadLinkRouter } from './routes/leadLink.js';

export function createCampaignApp({ db, ownerId, webhookSecret, campaignId, onRequested = null, onReply = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);                    // behind Render's proxy: real client IP for rate limits
  app.use(instantlyWebhookRouter(db, { secret: webhookSecret, ownerId, campaignId, onReply }));
  app.use(leadLinkRouter(db, { ownerId, onRequested }));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  // Whatever fails before our own code (a body that is too large, broken JSON…): a short answer, never a stack trace
  app.use((err, req, res, next) => {
    console.error('[campaign]', err.message);
    res.status(err.status >= 400 && err.status < 500 ? err.status : 500).type('text/plain').send('Solicitud no válida');
  });
  return app;
}
