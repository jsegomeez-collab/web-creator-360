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
import whatsappRouter from './routes/whatsapp.js';
import settingsRouter from './routes/settings.js';
import billingRouter from './routes/billing.js';
import { startCronJobs } from './cron/jobs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

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

app.use(express.json());

// Landing page at root (overrides express.static index)
app.get('/', (req, res) => res.sendFile(join(__dirname, '../public/landing.html')));

app.use(express.static(join(__dirname, '../public')));

app.use('/api/prospect', prospectRouter);
app.use('/api/scrape', scrapeRouter);
app.use('/api/generate', generateRouter);
app.use('/preview', previewRouter);
app.use('/api/outreach', outreachRouter);
app.use('/api/regenerate', regenerateRouter);
app.use('/api/pipeline', pipelineRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/billing', billingRouter);
app.use('/', paymentsRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Public config for frontend Supabase client (anon key is safe to expose)
app.get('/api/config', (req, res) => res.json({
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
}));

app.listen(PORT, () => {
  console.log(`Web Creator 360 running at http://localhost:${PORT}`);
  startCronJobs();
});
