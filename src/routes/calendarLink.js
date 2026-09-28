// GET /c/:token — the {{calendario}} link inside each email. It is the lead's own tracked link: it records that they opened
// it ("engaged", the interest signal) and redirects to your booking page with their email prefilled.
// Link scanners and previews (HEAD requests, security bots) are sent to the calendar without registering anything.
import { Router } from 'express';
import { createLimiter } from '../lib/rateLimit.js';
import { page, sendPage, notFoundPage } from '../lib/pages.js';

const TABLE = 'new_business_leads';
const TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;
const ENGAGEABLE = new Set(['new', 'queued', 'emailed']);
const BOT_UA = /bot|crawl|spider|preview|scan|monitor|check|fetch|curl|wget|python|axios|java\/|^node$|undici|headless|microsoft office|proofpoint|mimecast|barracuda|symantec|safelinks|trend ?micro|forcepoint|sophos|cisco|urlscan|slack|whatsapp|telegram|facebookexternalhit|googleimageproxy/i;

// Empty user agents and well-known scanners/previewers are not the person clicking
export const isProbablyBot = (userAgent) => !userAgent || BOT_UA.test(userAgent);

export function calendarLinkRouter(db, { ownerId, calendarUrl, limiter = createLimiter({ max: 60, windowMs: 10 * 60_000 }) }) {
  const router = Router();

  router.get('/c/:token', async (req, res) => {
    if (limiter.hit(req.ip)) {
      return sendPage(res, 429, page('Demasiados intentos', '<h1>Demasiados intentos</h1><p>Inténtalo de nuevo en unos minutos.</p>'));
    }
    const { token } = req.params;
    if (!TOKEN_RE.test(token)) return notFoundPage(res);

    const target = new URL(calendarUrl);
    const { data: lead, error } = await db.from(TABLE).select('id, email, status').eq('user_id', ownerId).eq('link_token', token).maybeSingle();
    if (error) {
      // The calendar must open even if our database has a hiccup: only the tracking is lost
      console.error('[calendar-link] lookup failed:', error.message);
    } else if (!lead) {
      return notFoundPage(res);
    } else {
      target.searchParams.set('email', lead.email);
      if (req.method === 'GET' && !isProbablyBot(req.get('user-agent')) && ENGAGEABLE.has(lead.status)) {
        const now = new Date().toISOString();
        const { error: uErr } = await db.from(TABLE).update({ status: 'engaged', engaged_at: now, updated_at: now }).eq('id', lead.id);
        if (uErr) console.error('[calendar-link] could not mark engaged:', uErr.message);
      }
    }

    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }).redirect(302, target.toString());
  });

  return router;
}
