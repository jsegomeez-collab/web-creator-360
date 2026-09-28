import supabase from '../db/supabase.js';
import { sendOutreachEmail, nextFollowUpDate } from './resend.js';
import { getConnectionState, sendText, buildMessage, formatPhone } from './whatsapp.js';
import { LEAD_BUSINESS_SOURCE } from './newLeads.js';
import { suppressionReason } from './suppressions.js';

// ─── Core outreach logic (email + WA) ─────────────────────────────────────────
// Shared by the manual routes and the auto pipeline.
// Throws when nothing went out, so the site stays in "preview" and can be retried.
export async function sendOutreach(business, site, contactEmail, language, followUpNumber) {
  const siteId = site.id;
  let emailSent = false;

  // Businesses of the new-business campaign are contacted ONLY by its own email sequence: they never gave consent
  // for WhatsApp and must not go out through this (Resend / manual) path either.
  if (business.source === LEAD_BUSINESS_SOURCE) {
    throw new Error('Este negocio viene de la campaña de LLCs nuevas: solo se contacta con su secuencia de emails');
  }

  // Never email an address that unsubscribed or bounced, whatever its source
  const owner = business.user_id || process.env.NEW_LEADS_OWNER_USER_ID;
  const suppressed = !!contactEmail && !!owner && !!(await suppressionReason(supabase, owner, contactEmail, { failOpen: true }));
  const email = suppressed ? null : contactEmail;

  // 1. Send email if available
  if (email) {
    await sendOutreachEmail(business, { ...site, contact_email: email }, followUpNumber, language);
    emailSent = true;
  }

  // 2. Send WhatsApp if phone available and connected
  const waResult = await tryWhatsApp(business, site, language);
  const waSent = waResult.sent;
  const waReason = waResult.reason || null;

  if (!emailSent && !waSent) {
    throw new Error(suppressed ? 'Contacto dado de baja o con rebote (lista de supresiones)' : `No se pudo enviar por ningún canal (${waReason})`);
  }

  // 3. Log to outreach_log
  const channel = emailSent && waSent ? 'email+whatsapp' : emailSent ? 'email' : 'whatsapp';
  const contact = email || business.phone;
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
  if (business.source === LEAD_BUSINESS_SOURCE) return { sent: false, reason: 'sin_consentimiento' };   // no automatic WhatsApp for these leads
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
