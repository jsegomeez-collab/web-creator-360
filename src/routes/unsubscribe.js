// One-click unsubscribe for the new-business campaign emails.
//   GET  /u/:token   the link in the email footer: unsubscribes right away (as the emails promise "un clic")
//   POST /u/:token   RFC 8058 one-click (List-Unsubscribe-Post header): same effect
// The token is the lead's form_token. HEAD requests (link scanners, previews) never unsubscribe anybody.
import { Router, urlencoded } from 'express';
import { createLimiter } from '../lib/rateLimit.js';
import { page, sendPage, notFoundPage } from '../lib/pages.js';
import { suppress } from '../services/suppressions.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;
// Only leads that haven't converted change status; someone who already filled the form keeps their funnel status
// (but is still suppressed, so no more emails go out)
const PRE_CONVERSION = new Set(['new', 'queued', 'emailed', 'replied', 'sequence_finished']);

export function unsubscribeRouter(db, { limiter = createLimiter({ max: 30, windowMs: 10 * 60_000 }) } = {}) {
  const router = Router();

  const handler = async (req, res) => {
    if (req.method === 'HEAD') return res.status(200).end();
    if (limiter.hit(req.ip)) return sendPage(res, 429, page('Demasiados intentos', '<h1>Demasiados intentos</h1><p>Inténtalo de nuevo en unos minutos.</p>'));

    const { token } = req.params;
    if (!TOKEN_RE.test(token)) return notFoundPage(res);

    const { data: lead } = await db.from('new_business_leads').select('id, user_id, email, status').eq('form_token', token).single();
    if (!lead) return notFoundPage(res);

    try {
      await suppress(db, lead.user_id, lead.email, 'unsubscribed');
      const patch = { next_send_at: null, updated_at: new Date().toISOString() };
      if (PRE_CONVERSION.has(lead.status)) patch.status = 'unsubscribed';
      const { error } = await db.from('new_business_leads').update(patch).eq('id', lead.id);
      if (error) throw new Error(error.message);
    } catch (err) {
      // Never claim success for an unsubscribe that wasn't saved
      console.error('[unsubscribe]', err.message);
      return sendPage(res, 500, page('Error', '<h1>No hemos podido procesar tu baja</h1><p>Inténtalo de nuevo en unos minutos o responde al email y te damos de baja a mano.</p>'));
    }
    sendPage(res, 200, page('Baja confirmada', '<h1>✓ Listo, te hemos dado de baja</h1><p>No volverás a recibir correos nuestros.</p>'));
  };

  router.get('/u/:token', handler);
  router.post('/u/:token', urlencoded({ extended: false, limit: '2kb' }), handler);
  return router;
}
