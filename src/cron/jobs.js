import cron from 'node-cron';
import supabase from '../db/supabase.js';
import { sendOutreachEmail, nextFollowUpDate } from '../services/resend.js';
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

async function runFollowUps() {
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
      const { data: webData } = await supabase
        .from('business_web_data')
        .select('language')
        .eq('business_id', log.business_id)
        .single();
      const language = webData?.language || 'es';
      await sendOutreachEmail(log.businesses, log.generated_sites, nextFollowUp, language);

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
