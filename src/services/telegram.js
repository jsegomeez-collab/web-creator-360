// Alerts to your phone through a Telegram bot: a lead asked for a call, a lead replied to the email.
// An alert never breaks what triggered it: a failure is logged and comes back as { ok: false }, it never throws.
// With OUTREACH_DRY_RUN=true the alert is written to the log instead of being sent.
import { requestJson } from '../lib/http.js';
import { isDryRun, dryRunLog } from '../lib/dryRun.js';
import { esc } from '../lib/pages.js';
import { displayName } from '../prompts/newBusinessEmails.js';

export function loadTelegramConfig(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
  return token && chatId ? { token, chatId } : null;
}

export async function sendTelegram(text, { env = process.env, fetchImpl, sleep, dryRun = isDryRun() } = {}) {
  if (dryRun) {
    dryRunLog('telegram', { text });
    return { ok: true, dryRun: true };
  }
  const config = loadTelegramConfig(env);
  if (!config) {
    console.warn('[telegram] faltan TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID: aviso no enviado');
    return { ok: false, skipped: true };
  }
  try {
    await requestJson({
      service: 'Telegram', url: `https://api.telegram.org/bot${config.token}/sendMessage`, method: 'POST',
      body: { chat_id: config.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true },
      fetchImpl, sleep, hint401: '(¿TELEGRAM_BOT_TOKEN correcto?)',
    });
    return { ok: true };
  } catch (err) {
    const message = err.message.split(config.token).join('***');
    console.error('[telegram]', message);
    return { ok: false, error: message };
  }
}

const place = (lead) => [lead.city, lead.sector].filter(Boolean).join(' · ');

// A lead filled in the form: the call to make right now
export const callRequestMessage = (lead, contact) => [
  `📞 <b>${esc(displayName(lead.name))}</b> quiere que la llames`,
  `Tel: <code>${esc(contact.phone)}</code>`,
  `Cuándo: ${esc(contact.preferred_time)}`,
  contact.name ? `Nombre: ${esc(contact.name)}` : null,
  place(lead) ? esc(place(lead)) : null,
  esc(lead.email),
].filter(Boolean).join('\n');

// A lead answered the cold email (Instantly's inbox has the text)
export const replyMessage = (lead) => [
  `✉️ <b>${esc(displayName(lead.name))}</b> ha respondido a tu email`,
  place(lead) ? esc(place(lead)) : null,
  esc(lead.email),
  'Léelo en Instantly.',
].filter(Boolean).join('\n');

export const alertCallRequest = (lead, contact, options) => sendTelegram(callRequestMessage(lead, contact), options);
export const alertReply = (lead, options) => sendTelegram(replyMessage(lead), options);
