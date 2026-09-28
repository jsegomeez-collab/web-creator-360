// The PUBLIC server of the new-business campaign (deployed on its own, e.g. on Render). It only exposes what has to be
// reachable from the internet: the webhook Instantly calls (and, next, the tracked calendar link). It has no dashboard,
// so it can be public even though the full app's routes have no login.
import express from 'express';
import { instantlyWebhookRouter } from './routes/instantlyWebhook.js';

export function createCampaignApp({ db, ownerId, webhookSecret, campaignId }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);                    // behind Render's proxy: real client IP for rate limits
  app.use(instantlyWebhookRouter(db, { secret: webhookSecret, ownerId, campaignId }));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  return app;
}
