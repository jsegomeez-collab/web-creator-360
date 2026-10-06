// /c/:token — the lead's own page: it asks for their phone so you can call them (GET shows the form, POST saves it and
// fires onRequested → the Telegram alert). It is the {{calendario}} link of the classic email, and the "La quiero" button of
// the lead's demo website (demo email). /v/:token is the beacon inside that demo website.
//   opening the page or the demo → "engaged" (interest, but not yet a call request)
//   sending the form             → "requested" (+ phone, name, when they prefer, and the consent to be called)
// Link scanners and previews (HEAD requests, security bots) see the page without registering anything.
import { Router, urlencoded } from 'express';
import { createLimiter } from '../lib/rateLimit.js';
import { esc, page, sendPage, notFoundPage } from '../lib/pages.js';
import { LINK_TOKEN_RE } from '../services/newLeads.js';
import { CONSENT_TEXT, PREFERRED_TIMES, parseRequest, saveRequest } from '../services/callRequests.js';
import { displayName, demoLink } from '../prompts/newBusinessEmails.js';

const TABLE = 'new_business_leads';
const ENGAGEABLE = new Set(['new', 'queued', 'emailed']);
const BOT_UA = /bot|crawl|spider|preview|scan|monitor|check|fetch|curl|wget|python|axios|java\/|^node$|undici|headless|microsoft office|proofpoint|mimecast|barracuda|symantec|safelinks|trend ?micro|forcepoint|sophos|cisco|urlscan|slack|whatsapp|telegram|facebookexternalhit|googleimageproxy/i;

// Empty user agents and well-known scanners/previewers are not the person clicking
export const isProbablyBot = (userAgent) => !userAgent || BOT_UA.test(userAgent);

// Their demo website (when it exists) opens in a new tab, in Spanish
const demoButton = (lead) => (lead.demo_url && lead.demo_status !== 'expired'
  ? `<a class="btn" style="margin:0 0 22px;background:transparent;border:1px solid rgba(255,255,255,.25)" href="${esc(demoLink(lead.demo_url))}" target="_blank" rel="noopener">Ver mi web</a>`
  : '');

const formPage = (lead, { values = {}, errors = {} } = {}) => page(`Tu web para ${displayName(lead.name)}`, `
  <h1>Hola, ${esc(displayName(lead.name))} 👋</h1>
  <p>Déjame tu teléfono y <strong>te llamo para enseñarte en directo la web de tu negocio</strong> (15 minutos, sin compromiso).</p>
  ${demoButton(lead)}
  <form method="post">
    <div class="hp" aria-hidden="true"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>
    <label for="phone">Tu teléfono</label>
    <input type="tel" id="phone" name="phone" inputmode="tel" autocomplete="tel" required value="${esc(values.phone)}" placeholder="860 555 0100">
    ${errors.phone ? `<p class="err">${esc(errors.phone)}</p>` : ''}
    <label for="name">Tu nombre <span style="font-weight:400;color:#94A3B8">(opcional)</span></label>
    <input type="text" id="name" name="name" autocomplete="name" maxlength="80" value="${esc(values.name)}">
    <label for="when">¿Cuándo te viene bien?</label>
    <select id="when" name="when">${PREFERRED_TIMES.map(t => `<option${t === (values.preferred_time || PREFERRED_TIMES[0]) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
    <label class="check"><input type="checkbox" name="consent" required${values.consent ? ' checked' : ''}><span>${esc(CONSENT_TEXT)}</span></label>
    ${errors.consent ? `<p class="err">${esc(errors.consent)}</p>` : ''}
    <button type="submit">Llámame</button>
  </form>`);

const thanksPage = (values) => page('Recibido', `
  <h1>¡Recibido! 🙌</h1>
  <p>Te llamo en breve al <strong>${esc(values.phone)}</strong> (${esc(values.preferred_time.toLowerCase())}).</p>
  <p>Si el número no es correcto o prefieres otra hora, vuelve a abrir el enlace del email y cámbialo.</p>`);

const alreadyPage = () => page('Ya lo tenemos', `
  <h1>Ya tenemos tu solicitud</h1>
  <p>Gracias. Si necesitas algo más, responde al email y te contesto.</p>`);

const problemPage = (res, status, title, text) => sendPage(res, status, page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`));

// db: Supabase client · ownerId: NEW_LEADS_OWNER_USER_ID · onRequested(lead, values): alert for the first request of a lead
export function leadLinkRouter(db, { ownerId, onRequested = null, limiter = createLimiter({ max: 60, windowMs: 10 * 60_000 }), postLimiter = createLimiter({ max: 15, windowMs: 10 * 60_000 }) }) {
  const router = Router();

  async function findLead(token) {
    const { data, error } = await db.from(TABLE).select('*').eq('user_id', ownerId).eq('link_token', token).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  router.get('/c/:token', async (req, res) => {
    if (limiter.hit(req.ip)) return problemPage(res, 429, 'Demasiados intentos', 'Inténtalo de nuevo en unos minutos.');
    const { token } = req.params;
    if (!LINK_TOKEN_RE.test(token)) return notFoundPage(res);

    let lead;
    try { lead = await findLead(token); } catch (err) {
      console.error('[lead-link] lookup failed:', err.message);
      return problemPage(res, 503, 'Vuelve a intentarlo', 'No hemos podido cargar la página. Inténtalo de nuevo en unos minutos.');
    }
    if (!lead) return notFoundPage(res);

    if (req.method === 'GET' && !isProbablyBot(req.get('user-agent')) && ENGAGEABLE.has(lead.status)) {
      const now = new Date().toISOString();
      const { error } = await db.from(TABLE).update({ status: 'engaged', engaged_at: now, updated_at: now }).eq('id', lead.id);
      if (error) console.error('[lead-link] could not mark engaged:', error.message);
    }
    sendPage(res, 200, formPage(lead, { values: { phone: lead.phone, name: lead.contact_name, preferred_time: lead.preferred_time } }));
  });

  // The beacon inside the lead's demo website (services/leadDemos.js): the owner opened it → "engaged".
  // Always 204 with no body (nobody reads it); scanners and previews don't count.
  router.post('/v/:token', async (req, res) => {
    res.status(204).set('Cache-Control', 'no-store');
    if (limiter.hit(req.ip) || !LINK_TOKEN_RE.test(req.params.token) || isProbablyBot(req.get('user-agent'))) return res.end();
    try {
      const lead = await findLead(req.params.token);
      if (lead && ENGAGEABLE.has(lead.status)) {
        const now = new Date().toISOString();
        const { error } = await db.from(TABLE).update({ status: 'engaged', engaged_at: now, updated_at: now })
          .eq('id', lead.id).in('status', [...ENGAGEABLE]);
        if (error) console.error('[lead-link] could not mark engaged (demo visit):', error.message);
      }
    } catch (err) {
      console.error('[lead-link] demo visit:', err.message);
    }
    res.end();
  });

  router.post('/c/:token', urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
    if (postLimiter.hit(req.ip)) return problemPage(res, 429, 'Demasiados intentos', 'Inténtalo de nuevo en unos minutos.');
    const { token } = req.params;
    if (!LINK_TOKEN_RE.test(token)) return notFoundPage(res);

    let lead;
    try { lead = await findLead(token); } catch (err) {
      console.error('[lead-link] lookup failed:', err.message);
      return problemPage(res, 503, 'Vuelve a intentarlo', 'No hemos podido guardar tu solicitud. Inténtalo de nuevo en unos minutos.');
    }
    if (!lead) return notFoundPage(res);

    const body = req.body || {};
    if (body.website) return sendPage(res, 200, alreadyPage());          // hidden field only bots fill in: pretend it worked

    const { errors, values } = parseRequest(body);
    if (Object.keys(errors).length) {
      return sendPage(res, 400, formPage(lead, { errors, values: { phone: body.phone, name: values.name, preferred_time: values.preferred_time, consent: body.consent === 'on' } }));
    }

    let outcome;
    try {
      outcome = await saveRequest({ db, ownerId, lead, values, ip: req.ip });
    } catch (err) {
      // Losing a request is the one thing that must not happen silently
      console.error('[lead-link] could not save the request:', err.message);
      return problemPage(res, 500, 'No se ha podido guardar', 'Ha habido un problema al guardar tu solicitud. Inténtalo de nuevo en un minuto.');
    }

    if (outcome === 'new' && onRequested) {
      // Not awaited: the person doesn't wait for Telegram. A failing alert never affects them.
      Promise.resolve().then(() => onRequested({ ...lead, status: 'requested', phone: values.phone }, values))
        .catch(err => console.error('[lead-link] onRequested failed:', err.message));
    }
    sendPage(res, 200, outcome === 'ignored' ? alreadyPage() : thanksPage(values));
  });

  return router;
}
