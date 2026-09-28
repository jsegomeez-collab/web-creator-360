// POST /webhooks/instantly — what Instantly tells us about each lead of the campaign. Only Instantly can call it: it
// sends our secret in the x-webhook-secret header (set when the webhook is created, see scripts/instantly-webhook.js).
//
//   email_sent          new/queued            → emailed
//   email_bounced       new/queued/emailed    → bounced      (+ email goes to the suppression list)
//   lead_unsubscribed   new/queued/emailed    → unsubscribed (+ suppression list)
//   reply_received      new/queued/emailed    → replied      (replied_at is always recorded)
// Any other event, or a lead we don't know, is acknowledged and ignored. A lead that already engaged (opened the calendar
// link) or later never goes backwards.
import { timingSafeEqual } from 'crypto';
import { Router, json } from 'express';
import { normEmail, suppress } from '../services/suppressions.js';

const TABLE = 'new_business_leads';
const BEFORE_ENGAGING = new Set(['new', 'queued', 'emailed']);

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

// What each event does to a lead → { patch, suppressAs } (null = nothing to do)
function effectOf(type, lead, at) {
  switch (type) {
    case 'email_sent':
      return ['new', 'queued'].includes(lead.status) ? { patch: { status: 'emailed', emailed_at: at } } : null;
    case 'email_bounced':
      return { patch: BEFORE_ENGAGING.has(lead.status) ? { status: 'bounced' } : {}, suppressAs: 'bounced' };
    case 'lead_unsubscribed':
      return { patch: BEFORE_ENGAGING.has(lead.status) ? { status: 'unsubscribed' } : {}, suppressAs: 'unsubscribed' };
    case 'reply_received':
      return { patch: { replied_at: at, ...(BEFORE_ENGAGING.has(lead.status) ? { status: 'replied' } : {}) } };
    default:
      return null;
  }
}

// db: Supabase client · secret: INSTANTLY_WEBHOOK_SECRET · ownerId: NEW_LEADS_OWNER_USER_ID · campaignId: only this campaign
export function instantlyWebhookRouter(db, { secret, ownerId, campaignId = null }) {
  const router = Router();

  router.post('/webhooks/instantly', json({ limit: '1mb' }), async (req, res) => {
    if (!secret) return res.status(503).json({ error: 'webhook sin configurar (falta INSTANTLY_WEBHOOK_SECRET)' });
    if (!safeEqual(req.get('x-webhook-secret'), secret)) return res.status(401).json({ error: 'no autorizado' });

    const event = req.body || {};
    const email = normEmail(event.lead_email);
    if (!event.event_type || !email) return res.json({ ok: true, ignored: 'sin evento o sin email' });
    if (campaignId && event.campaign_id && event.campaign_id !== campaignId) return res.json({ ok: true, ignored: 'otra campaña' });

    try {
      const { data: lead, error } = await db.from(TABLE).select('id, status').eq('user_id', ownerId).eq('email', email).maybeSingle();
      if (error) throw new Error(error.message);
      if (!lead) return res.json({ ok: true, ignored: 'lead desconocido' });

      const at = Number.isNaN(Date.parse(event.timestamp)) ? new Date().toISOString() : new Date(event.timestamp).toISOString();
      const effect = effectOf(event.event_type, lead, at);
      if (!effect) return res.json({ ok: true, ignored: 'evento sin efecto' });

      if (effect.suppressAs) await suppress(db, ownerId, email, effect.suppressAs);
      if (Object.keys(effect.patch).length) {
        const { error: uErr } = await db.from(TABLE).update({ ...effect.patch, updated_at: new Date().toISOString() }).eq('id', lead.id);
        if (uErr) throw new Error(uErr.message);
      }
      res.json({ ok: true, event: event.event_type, lead: lead.id });
    } catch (err) {
      // 500 so Instantly can retry; nothing is claimed as done
      console.error('[instantly-webhook]', err.message);
      res.status(500).json({ error: 'no se pudo procesar el evento' });
    }
  });

  return router;
}
