import supabase from '../db/supabase.js';
import { sendOutreachEmail, nextFollowUpDate } from './resend.js';
import { getConnectionState, sendText, buildMessage, formatPhone } from './whatsapp.js';

// ─── Core outreach logic (email + WA) ─────────────────────────────────────────
// Shared by the manual routes and the auto pipeline.
// Throws when nothing went out, so the site stays in "preview" and can be retried.
export async function sendOutreach(business, site, contactEmail, language, followUpNumber) {
  const siteId = site.id;
  let emailSent = false;

  // 1. Send email if available
  if (contactEmail) {
    await sendOutreachEmail(business, { ...site, contact_email: contactEmail }, followUpNumber, language);
    emailSent = true;
  }

  // 2. Send WhatsApp if phone available and connected
  const waResult = await tryWhatsApp(business, site, language);
  const waSent = waResult.sent;
  const waReason = waResult.reason || null;

  if (!emailSent && !waSent) {
    throw new Error(`No se pudo enviar por ningún canal (${waReason})`);
  }

  // 3. Log to outreach_log
  const channel = emailSent && waSent ? 'email+whatsapp' : emailSent ? 'email' : 'whatsapp';
  const contact = contactEmail || business.phone;
  await supabase.from('outreach_log').insert({
    business_id: business.id,
    site_id: siteId,
    channel,
    contact,
    follow_up_number: followUpNumber,
    next_follow_up_at: nextFollowUpDate(followUpNumber),
  });

  // 4. Update statuses
  await supabase.from('generated_sites').update({ status: 'sent' }).eq('id', siteId);
  await supabase.from('businesses').update({ status: 'active' }).eq('id', business.id);

  return { emailSent, waSent, waReason };
}

// ─── WhatsApp helper ──────────────────────────────────────────────────────────
export async function tryWhatsApp(business, site, language, isFollowUp = false) {
  if (!business.phone) return { sent: false, reason: 'sin_telefono' };
  try {
    const state = await getConnectionState();
    if (state !== 'open') return { sent: false, reason: 'whatsapp_desconectado' };
    const msg = buildMessage(business, site, language, isFollowUp);
    await sendText(business.phone, msg);
    console.log(`[wa] ✓ ${formatPhone(business.phone)} — "${business.name}"`);
    return { sent: true };
  } catch (err) {
    console.warn(`[wa] ✗ "${business.name}":`, err.message);
    return { sent: false, reason: err.message };
  }
}
