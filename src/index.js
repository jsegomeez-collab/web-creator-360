import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import prospectRouter from './routes/prospect.js';
import scrapeRouter from './routes/scrape.js';
import generateRouter from './routes/generate.js';
import previewRouter from './routes/preview.js';
import outreachRouter from './routes/outreach.js';
import paymentsRouter from './routes/payments.js';
import dashboardRouter from './routes/dashboard.js';
import regenerateRouter from './routes/regenerate.js';
import pipelineRouter from './routes/pipeline.js';
import settingsRouter from './routes/settings.js';
import billingRouter from './routes/billing.js';
import { createLeadsRouter } from './routes/leads.js';
import { alertReply } from './services/telegram.js';
import { dashboardAuth } from './middleware/dashboardAuth.js';
import supabase from './db/supabase.js';
import { startCronJobs } from './cron/jobs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// This app has no per-route login: everything (dashboard, prospecting, sending real emails/leads) is open to whoever
// can reach it. Set DASHBOARD_USER + DASHBOARD_PASSWORD (in production, always) to lock it behind one shared login.
app.use(dashboardAuth);

// Raw body capture for Stripe webhooks (must come before json middleware)
app.use((req, res, next) => {
  const isStripeWebhook = req.path === '/webhooks/stripe' || req.path === '/api/billing/webhook';
  if (isStripeWebhook) {
    let data = Buffer.alloc(0);
    req.on('data', chunk => { data = Buffer.concat([data, chunk]); });
    req.on('end', () => { req.rawBody = data; next(); });
  } else {
    next();
  }
});

// A CSV travels inside the JSON body: give the import routes room before the default 100 kb parser sees them
app.use('/api/leads/import', express.json({ limit: '10mb' }));
app.use(express.json());

const SAAS_MODE = !!process.env.SAAS_MODE;

// In SaaS mode (production): / → landing page. Locally: / → dashboard directly.
if (SAAS_MODE) {
  app.get('/', (req, res) => res.sendFile(join(__dirname, '../public/landing.html')));
}

app.use(express.static(join(__dirname, '../public')));

app.use('/api/prospect', prospectRouter);
app.use('/api/scrape', scrapeRouter);
app.use('/api/generate', generateRouter);
app.use('/preview', previewRouter);
app.use('/api/outreach', outreachRouter);
app.use('/api/regenerate', regenerateRouter);
app.use('/api/pipeline', pipelineRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/leads', createLeadsRouter({ db: supabase, ownerId: (process.env.NEW_LEADS_OWNER_USER_ID || '').trim(), onReply: (lead) => alertReply(lead) }));
app.use('/', paymentsRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Public config for frontend
app.get('/api/config', (req, res) => res.json({
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  saasMode: SAAS_MODE,
}));

// On Vercel the app runs as a serverless function: it can't listen on a port or keep cron jobs alive
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Web Creator 360 running at http://localhost:${PORT}`);
    startCronJobs();
  });
}

export default app;
