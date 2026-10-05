// API of the "LLCs nuevas" pipeline in the dashboard (separate from the Google Maps pipeline).
// Like the rest of the dashboard API it has no login: it is meant for your local app, not for the internet.
//   GET   /stats                   funnel counts + last ingest + Instantly status
//   GET   /                        leads (filters: status, sector, priority, source, batch, demo, q; limit, offset)
//   PATCH /:id                     manual status: replied | called | won | lost
//   POST  /ingest/ct               Connecticut registry ({ days?, dryRun? })
//   POST  /import/csv/preview      read a CSV: columns, first rows and a suggested mapping
//   POST  /import/csv              import a CSV with a column mapping ({ csv, mapping, filename?, dryRun? })
//   GET   /import-batches          past CSV imports still with "new" leads, so you can pick one to send ({ batch, count })
//   POST  /push                    send the newest "new" leads to the Instantly campaign ({ limit, source?, sector?, priority?, batch? })
//   POST  /poll-instantly          check Instantly now for sent/bounced/unsubscribed/replied (the cron does this every 5 min)
//   GET   /autopilot               unattended ingest + send, run by the campaign server's crons: { enabled, pushLimit, demoAll }
//   PUT   /autopilot               change it ({ enabled?, pushLimit?, demoAll? })
//   GET   /email-template          the email text to paste in Instantly (the demo version when LEAD_DEMOS=true)
//   POST  /demos                   make the demo websites of the newest "new" leads that don't have one ({ limit ≤ 5 })
//   POST  /:id/demo                make (or remake) the demo website of one lead
import { Router } from 'express';
import { isDryRun } from '../lib/dryRun.js';
import { selectAll } from '../lib/selectAll.js';
import { runCtIngest, FIRST_RUN_DAYS } from '../services/ctIngest.js';
import { previewCsv, importCsvLeads } from '../services/csvImport.js';
import { loadInstantlyConfig, pushLeads } from '../services/instantly.js';
import { pollInstantlyEvents } from '../services/instantlyPoll.js';
import { getAutopilotSettings, setAutopilotSettings } from '../services/autopilot.js';
import { createLeadDemo, generateDemos } from '../services/leadDemos.js';
import { emailTemplate, templateVariables } from '../prompts/newBusinessEmails.js';

const TABLE = 'new_business_leads';
const MANUAL_STATUSES = new Set(['replied', 'called', 'won', 'lost']);
const LIST_COLUMNS = 'id, name, email, city, zip, sector, priority, status, registered_at, latino_signal, latino_strong, minority_owned, notes, source, pushed_at, emailed_at, engaged_at, replied_at, requested_at, phone, contact_name, preferred_time, site_id, created_at';
const DEMO_COLUMNS = 'demo_url, demo_status, demo_template, demo_error';
// Before schema-new-business-leads.sql is run again, the demo columns don't exist yet: the dashboard keeps working without them
const missingColumn = (err) => /column|schema cache/i.test(String(err?.message || err));

const asList = (v) => String(v ?? '').split(',').map(s => s.trim()).filter(Boolean);

// verifyOptions / fetchImpl: only for tests (a fake DNS resolver and a fake registry download); production uses the real ones
// onReply(lead): the Telegram alert for a lead's first reply, fired from /poll-instantly (the campaign server's cron also polls on its own)
// demoBuild / demoDeploy: only for tests (a fake writer and a fake Vercel); production uses the real ones
export function createLeadsRouter({ db, ownerId, verifyOptions = {}, fetchImpl, onReply = null, demoBuild, demoDeploy }) {
  const router = Router();

  router.use((req, res, next) => {
    if (!ownerId) return res.status(503).json({ error: 'Falta NEW_LEADS_OWNER_USER_ID en tu .env (el UUID de tu usuario de Supabase)' });
    next();
  });

  // Errors of the database (e.g. the SQL wasn't run) come back as readable messages
  const guard = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      const hint = /relation|does not exist|schema cache|column/i.test(err.message) ? ' ¿Has ejecutado src/db/schema-new-business-leads.sql en Supabase?' : '';
      res.status(500).json({ error: `${err.message}${hint}` });
    }
  };

  router.get('/stats', guard(async (req, res) => {
    let data, demoColumns = true;
    try { data = await selectAll(() => db.from(TABLE).select('status, demo_status').eq('user_id', ownerId).order('id')); } catch (err) {
      if (!missingColumn(err)) throw err;
      demoColumns = false;
      data = await selectAll(() => db.from(TABLE).select('status').eq('user_id', ownerId).order('id'));
    }
    const byStatus = {};
    const demos = { ready: 0, failed: 0, generating: 0 };      // among the leads still waiting to be sent ("new")
    for (const l of data) {
      byStatus[l.status] = (byStatus[l.status] || 0) + 1;
      if (l.status === 'new' && demos[l.demo_status] !== undefined) demos[l.demo_status]++;
    }

    const { data: runs } = await db.from('lead_ingest_runs').select('ran_at, newest_registration, fetched, inserted, ok').eq('user_id', ownerId).order('ran_at', { ascending: false }).limit(1);
    const dryRun = isDryRun();
    let instantlyReady = true;
    try { loadInstantlyConfig(process.env, { dryRun: false }); } catch { instantlyReady = false; }

    const cfg = loadInstantlyConfig(process.env, { dryRun: true });
    const demoReady = !!process.env.ANTHROPIC_API_KEY && !!process.env.VERCEL_TOKEN;
    res.json({
      total: data.length, byStatus, lastRun: runs?.[0] ?? null, instantly: { ready: instantlyReady, dryRun },
      demos: { enabled: cfg.demos, configured: demoReady, columns: demoColumns, ...demos },
    });
  }));

  router.get('/', guard(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const statuses = asList(req.query.status);
    // Call requests: the newest first (they are waiting for you); everything else: the most recently registered
    const requests = statuses.length === 1 && statuses[0] === 'requested';
    const list = (columns) => selectAll(() => {
      let query = db.from(TABLE).select(columns).eq('user_id', ownerId);
      if (statuses.length) query = query.in('status', statuses);
      if (req.query.sector) query = query.eq('sector', String(req.query.sector));
      if (req.query.priority) query = query.eq('priority', String(req.query.priority));
      if (req.query.source) query = query.eq('source', String(req.query.source));
      if (req.query.batch) query = query.eq('import_batch', String(req.query.batch));
      if (req.query.demo) query = query.eq('demo_status', String(req.query.demo));
      return query.order(requests ? 'requested_at' : 'registered_at', { ascending: false }).order('id');
    });
    let data;
    try { data = await list(`${LIST_COLUMNS}, ${DEMO_COLUMNS}`); } catch (err) { if (!missingColumn(err)) throw err; data = await list(LIST_COLUMNS); }

    const q = String(req.query.q ?? '').trim().toLowerCase();
    const filtered = q ? data.filter(l => l.name.toLowerCase().includes(q) || l.email.includes(q) || (l.city || '').toLowerCase().includes(q)) : data;
    res.json({ total: filtered.length, leads: filtered.slice(offset, offset + limit) });
  }));

  router.patch('/:id', guard(async (req, res) => {
    const { status } = req.body || {};
    if (!MANUAL_STATUSES.has(status)) return res.status(400).json({ error: `Estado no válido. Usa: ${[...MANUAL_STATUSES].join(', ')}` });
    const { data, error } = await db.from(TABLE).update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('user_id', ownerId).select('id');
    if (error) throw new Error(error.message);
    if (!data?.length) return res.status(404).json({ error: 'Lead no encontrado' });
    res.json({ success: true });
  }));

  router.post('/ingest/ct', guard(async (req, res) => {
    const { days = null, dryRun = false } = req.body || {};
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) return res.status(400).json({ error: 'days debe ser un entero entre 1 y 3650' });
    const r = await runCtIngest({ db, ownerId, days, dryRun: !!dryRun, verifyOptions, fetchImpl });
    res.json({ ...r, firstRunDays: FIRST_RUN_DAYS, leads: undefined, invalid: undefined, invalidEmailCount: r.invalid.length });   // no lists of emails to the screen
  }));

  router.post('/import/csv/preview', guard(async (req, res) => {
    try { res.json(previewCsv(req.body?.csv)); } catch (err) { res.status(400).json({ error: err.message }); }
  }));

  router.post('/import/csv', guard(async (req, res) => {
    const { csv, mapping, filename, dryRun = false } = req.body || {};
    try {
      res.json(await importCsvLeads({ db, ownerId, csv, mapping, filename, dryRun: !!dryRun, verifyOptions }));
    } catch (err) {
      // Problems with the file or the mapping are the user's to fix (400); database errors fall to the guard (500)
      if (/CSV|columna|asignar|filas/i.test(err.message)) return res.status(400).json({ error: err.message });
      throw err;
    }
  }));

  router.post('/push', guard(async (req, res) => {
    const body = req.body || {};
    const limit = Number.isInteger(body.limit) ? body.limit : 100;
    const filters = {};
    for (const k of ['source', 'sector', 'priority', 'batch']) if (body[k]) filters[k] = String(body[k]);
    const dryRun = isDryRun();
    let config;
    try { config = loadInstantlyConfig(process.env, { dryRun }); } catch (err) { return res.status(400).json({ error: err.message }); }
    res.json(await pushLeads({ db, ownerId, config, limit, filters, dryRun }));
  }));

  // Distinct CSV imports that still have leads waiting to send, most leads first — lets you pick "just this file" in Envío
  router.get('/import-batches', guard(async (req, res) => {
    const data = await selectAll(() => db.from(TABLE).select('import_batch').eq('user_id', ownerId).eq('status', 'new').eq('source', 'csv_import').not('import_batch', 'is', null).order('id'));
    const counts = {};
    for (const l of data) counts[l.import_batch] = (counts[l.import_batch] || 0) + 1;
    res.json(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([batch, count]) => ({ batch, count })));
  }));

  router.post('/poll-instantly', guard(async (req, res) => {
    let config;
    try { config = loadInstantlyConfig(process.env, { dryRun: false }); } catch (err) { return res.status(400).json({ error: err.message }); }
    res.json(await pollInstantlyEvents({ db, ownerId, config, fetchImpl, onReply }));
  }));

  router.get('/autopilot', guard(async (req, res) => {
    res.json(await getAutopilotSettings(db, ownerId));
  }));

  router.put('/autopilot', guard(async (req, res) => {
    const { enabled, pushLimit, demoAll } = req.body || {};
    if (enabled !== undefined && typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled debe ser true o false' });
    if (demoAll !== undefined && typeof demoAll !== 'boolean') return res.status(400).json({ error: 'demoAll debe ser true o false' });
    if (pushLimit !== undefined && (!Number.isInteger(pushLimit) || pushLimit < 1 || pushLimit > 1000)) {
      return res.status(400).json({ error: 'pushLimit debe ser un entero entre 1 y 1000' });
    }
    res.json(await setAutopilotSettings(db, ownerId, { enabled, pushLimit, demoAll }));
  }));

  router.get('/email-template', (req, res) => {
    const demos = loadInstantlyConfig(process.env, { dryRun: true }).demos;
    res.json({ ...emailTemplate({ demos }), variables: templateVariables({ demos }), demos });
  });

  // Demo websites (template engine + Vercel). Each one takes about a minute, so the batch is kept small here; the
  // campaign server's autopilot makes them on its own when LEAD_DEMOS=true.
  const demoOptions = () => ({ db, ownerId, publicUrl: loadInstantlyConfig(process.env, { dryRun: true }).publicUrl, build: demoBuild, deploy: demoDeploy });
  const demoConfigError = () => (!process.env.ANTHROPIC_API_KEY ? 'Falta ANTHROPIC_API_KEY en tu .env (Claude escribe las webs)'
    : !process.env.VERCEL_TOKEN ? 'Falta VERCEL_TOKEN en tu .env (las webs se publican en Vercel)' : null);

  router.post('/demos', guard(async (req, res) => {
    const limit = Number.isInteger(req.body?.limit) ? req.body.limit : 3;
    if (limit < 1 || limit > 5) return res.status(400).json({ error: 'limit debe ser un entero entre 1 y 5' });
    if (!demoBuild && demoConfigError()) return res.status(400).json({ error: demoConfigError() });
    res.json(await generateDemos({ ...demoOptions(), limit }));
  }));

  router.post('/:id/demo', guard(async (req, res) => {
    if (!demoBuild && demoConfigError()) return res.status(400).json({ error: demoConfigError() });
    const { data: lead, error } = await db.from(TABLE).select('*').eq('id', req.params.id).eq('user_id', ownerId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
    const r = await createLeadDemo({ ...demoOptions(), lead, force: true });
    if (!r.ok) return res.status(r.skipped ? 409 : 502).json({ error: r.error, template: r.template });
    res.json(r);
  }));

  return router;
}
