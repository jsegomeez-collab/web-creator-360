import supabase from '../db/supabase.js';
import { sendOutreachEmail, nextFollowUpDate } from './resend.js';
import { LEAD_BUSINESS_SOURCE } from './newLeads.js';
import { suppressionReason } from './suppressions.js';

// True when this address unsubscribed or bounced (any source). The lookup is per user; if the table can't be read it lets the send through.
export async function isSuppressedFor(business, email) {
  const owner = business.user_id || process.env.NEW_LEADS_OWNER_USER_ID;
  return !!owner && !!(await suppressionReason(supabase, owner, email, { failOpen: true }));
}

// Sends the outreach email for a generated site and records it.
// Shared by the manual routes and the auto pipeline.
// Throws when the email doesn't go out, so the site stays in "preview" and can be retried.
export async function sendOutreach(business, site, contactEmail, language, followUpNumber) {
  // Businesses of the new-business campaign are contacted only by that campaign (Instantly), never through this path
  if (business.source === LEAD_BUSINESS_SOURCE) {
    throw new Error('Este negocio viene de la campaña de LLCs nuevas: se contacta solo desde su propio flujo');
  }
  if (!contactEmail) throw new Error('Sin email disponible para contactar este negocio');

  if (await isSuppressedFor(business, contactEmail)) {
    throw new Error('Contacto dado de baja o con rebote (lista de supresiones)');
  }

  await sendOutreachEmail(business, { ...site, contact_email: contactEmail }, followUpNumber, language);

  await supabase.from('outreach_log').insert({
    business_id: business.id,
    site_id: site.id,
    channel: 'email',
    contact: contactEmail,
    follow_up_number: followUpNumber,
    next_follow_up_at: nextFollowUpDate(followUpNumber),
  });

  await supabase.from('generated_sites').update({ status: 'sent' }).eq('id', site.id);
  await supabase.from('businesses').update({ status: 'active' }).eq('id', business.id);
}
