// API of the "LLCs nuevas" pipeline in the dashboard (separate from the Google Maps pipeline).
// Like the rest of the dashboard API it has no login: it is meant for your local app, not for the internet.
//   GET   /stats                   funnel counts + last ingest + Instantly status
//   GET   /                        leads (filters: status, sector, priority, source, q; limit, offset)
//   PATCH /:id                     manual status: replied | called | won | lost
//   POST  /ingest/ct               Connecticut registry ({ days?, dryRun? })
//   POST  /import/csv/preview      read a CSV: columns, first rows and a suggested mapping
//   POST  /import/csv              import a CSV with a column mapping ({ csv, mapping, dryRun? })
//   POST  /push                    send the newest "new" leads to the Instantly campaign ({ limit })
//   GET   /email-template          the email text to paste in Instantly
import { Router } from 'express';
import { isDryRun } from '../lib/dryRun.js';
import { runCtIngest, FIRST_RUN_DAYS } from '../services/ctIngest.js';
import { previewCsv, importCsvLeads } from '../services/csvImport.js';
import { loadInstantlyConfig, pushLeads } from '../services/instantly.js';
import { EMAIL_SUBJECT, EMAIL_BODY, templateVariables } from '../prompts/newBusinessEmails.js';

const TABLE = 'new_business_leads';
const MANUAL_STATUSES = new Set(['replied', 'called', 'won', 'lost']);
const LIST_COLUMNS = 'id, name, email, city, zip, sector, priority, status, registered_at, latino_signal, latino_strong, minority_owned, notes, source, pushed_at, emailed_at, engaged_at, replied_at, requested_at, phone, contact_name, preferred_time, site_id, created_at';

const asList = (v) => String(v ?? '').split(',').map(s => s.trim()).filter(Boolean);

// verifyOptions / fetchImpl: only for tests (a fake DNS resolver and a fake registry download); production uses the real ones
export function createLeadsRouter({ db, ownerId, verifyOptions = {}, fetchImpl }) {
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
    const { data, error } = await db.from(TABLE).select('status').eq('user_id', ownerId).limit(50000);
    if (error) throw new Error(error.message);
    const byStatus = {};
    for (const l of data || []) byStatus[l.status] = (byStatus[l.status] || 0) + 1;

    const { data: runs } = await db.from('lead_ingest_runs').select('ran_at, newest_registration, fetched, inserted, ok').eq('user_id', ownerId).order('ran_at', { ascending: false }).limit(1);
    const dryRun = isDryRun();
    let instantlyReady = true;
    try { loadInstantlyConfig(process.env, { dryRun: false }); } catch { instantlyReady = false; }

    res.json({ total: (data || []).length, byStatus, lastRun: runs?.[0] ?? null, instantly: { ready: instantlyReady, dryRun } });
  }));

  router.get('/', guard(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let query = db.from(TABLE).select(LIST_COLUMNS).eq('user_id', ownerId);
    const statuses = asList(req.query.status);
    if (statuses.length) query = query.in('status', statuses);
    if (req.query.sector) query = query.eq('sector', String(req.query.sector));
    if (req.query.priority) query = query.eq('priority', String(req.query.priority));
    if (req.query.source) query = query.eq('source', String(req.query.source));
    // Call requests: the newest first (they are waiting for you); everything else: the most recently registered
    const requests = statuses.length === 1 && statuses[0] === 'requested';
    const { data, error } = await query.order(requests ? 'requested_at' : 'registered_at', { ascending: false }).limit(20000);
    if (error) throw new Error(error.message);

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
    const { csv, mapping, dryRun = false } = req.body || {};
    try {
      res.json(await importCsvLeads({ db, ownerId, csv, mapping, dryRun: !!dryRun, verifyOptions }));
    } catch (err) {
      // Problems with the file or the mapping are the user's to fix (400); database errors fall to the guard (500)
      if (/CSV|columna|asignar|filas/i.test(err.message)) return res.status(400).json({ error: err.message });
      throw err;
    }
  }));

  router.post('/push', guard(async (req, res) => {
    const limit = Number.isInteger(req.body?.limit) ? req.body.limit : 100;
    const dryRun = isDryRun();
    let config;
    try { config = loadInstantlyConfig(process.env, { dryRun }); } catch (err) { return res.status(400).json({ error: err.message }); }
    res.json(await pushLeads({ db, ownerId, config, limit, dryRun }));
  }));

  router.get('/email-template', (req, res) => {
    res.json({ subject: EMAIL_SUBJECT, body: EMAIL_BODY, variables: templateVariables() });
  });

  return router;
}
