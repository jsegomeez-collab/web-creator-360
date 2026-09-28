import cron from 'node-cron';
import supabase from '../db/supabase.js';
import { sendOutreachEmail, nextFollowUpDate } from '../services/resend.js';
import { tryWhatsApp } from '../services/outreach.js';
import { runAutoPipeline } from '../pipeline/auto.js';

export function startCronJobs() {
  // Auto pipeline: every 30 min Mon–Fri 8–19h
  cron.schedule('*/30 8-19 * * 1-5', async () => {
    console.log('[cron] Running auto pipeline...');
    await runAutoPipeline();
  });

  // Follow-ups + expiry: daily at 10:00 AM
  cron.schedule('0 10 * * *', async () => {
    await runFollowUps();
    await expirePreviews();
  });

  console.log('Cron jobs scheduled (pipeline every 30min · follow-ups daily at 10:00)');
}

export async function runFollowUps() {
  const { data: pending, error } = await supabase
    .from('outreach_log')
    .select('*, businesses(*), generated_sites(*)')
    .lte('next_follow_up_at', new Date().toISOString())
    .lt('follow_up_number', 2)
    .not('next_follow_up_at', 'is', null);

  if (error) { console.error('Follow-up query error:', error.message); return; }
  if (!pending || pending.length === 0) return;

  for (const log of pending) {
    try {
      const nextFollowUp = log.follow_up_number + 1;

      // Stop (for good) when the site is no longer waiting on a reply (e.g. they already paid)
      if (log.generated_sites?.status !== 'sent') {
        console.log(`Follow-ups stopped for ${log.contact}: la web ya no está pendiente (${log.generated_sites?.status ?? 'sin web'})`);
        await supabase.from('outreach_log').update({ next_follow_up_at: null }).eq('id', log.id);
        continue;
      }

      const { data: webData } = await supabase
        .from('business_web_data')
        .select('language')
        .eq('business_id', log.business_id)
        .single();
      const language = webData?.language || 'es';

      // Follow up over the same channels as the first contact.
      // For email logs `contact` is the address; WhatsApp uses the business phone.
      const channels = (log.channel || 'email').split('+');
      let emailSent = false;
      let waSent = false;

      if (channels.includes('email')) {
        await sendOutreachEmail(log.businesses, { ...log.generated_sites, contact_email: log.contact }, nextFollowUp, language);
        emailSent = true;
      }
      if (channels.includes('whatsapp')) {
        const wa = await tryWhatsApp(log.businesses, log.generated_sites, language, true);
        waSent = wa.sent;
      }

      // Nothing went out (e.g. WhatsApp disconnected): leave it pending and retry on the next run
      if (!emailSent && !waSent) {
        console.warn(`Follow-up ${nextFollowUp} postponed for ${log.contact}: no channel available`);
        continue;
      }

      await supabase.from('outreach_log').update({
        follow_up_number: nextFollowUp,
        next_follow_up_at: nextFollowUpDate(nextFollowUp),
      }).eq('id', log.id);

      console.log(`Follow-up ${nextFollowUp} sent to ${log.contact}`);
    } catch (err) {
      console.error(`Follow-up failed for log ${log.id}:`, err.message);
    }
  }
}

async function expirePreviews() {
  const { error } = await supabase
    .from('generated_sites')
    .update({ status: 'expired' })
    .lt('expires_at', new Date().toISOString())
    .eq('status', 'preview');

  if (error) console.error('Expiry job error:', error.message);
  else console.log('Expiry check complete');
}
