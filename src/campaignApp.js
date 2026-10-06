// The PUBLIC server of the new-business campaign (deployed on its own, e.g. on Render). It only exposes what has to be
// reachable from the internet: the lead's own link in the emails (the page to ask for the call). It has no dashboard, so
// it can be public even though the full app's routes have no login. What happened in Instantly (sent, bounced, replied…)
// is found separately by polling (services/instantlyPoll.js, scheduled in campaign-server.js), not by a route here.
//   onRequested(lead, values)  a lead asked for a call (first time) → the Telegram alert
import express from 'express';
import { leadLinkRouter } from './routes/leadLink.js';

// getStatus(): what the unattended parts are doing right now (see campaign-server.js), shown in /health so a wrong
// setting on the server can be seen from the browser. Only on/off flags and the NAMES of missing variables, never values.
export function createCampaignApp({ db, ownerId, onRequested = null, getStatus = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);                    // behind Render's proxy: real client IP for rate limits
  app.use(leadLinkRouter(db, { ownerId, onRequested }));
  app.get('/health', (req, res) => res.json({ status: 'ok', ...(getStatus ? { autopilot: getStatus() } : {}) }));
  // Whatever fails before our own code (a body that is too large, broken JSON…): a short answer, never a stack trace
  app.use((err, req, res, next) => {
    console.error('[campaign]', err.message);
    res.status(err.status >= 400 && err.status < 500 ? err.status : 500).type('text/plain').send('Solicitud no válida');
  });
  return app;
}
