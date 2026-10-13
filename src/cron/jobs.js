import cron from 'node-cron';
import supabase from '../db/supabase.js';
import { runAutoPipeline, PIPELINE_TIMEZONE } from '../pipeline/auto.js';

export function startCronJobs() {
  const timezone = PIPELINE_TIMEZONE();

  // Auto pipeline (Google Maps businesses: scrape → full site with Claude → email): every 30 min Mon–Fri 8–19h.
  // OFF unless AUTO_PIPELINE=true: each site it generates costs ≈ $0.25–0.30 of Claude (≈20k output tokens), and it runs by
  // itself all day on every pending business. The LLC campaign doesn't use it.
  const autoPipeline = String(process.env.AUTO_PIPELINE || '').trim().toLowerCase() === 'true';
  if (autoPipeline) {
    cron.schedule('*/30 8-19 * * 1-5', async () => {
      console.log('[cron] Running auto pipeline...');
      await runAutoPipeline();
    }, { timezone });
  }

  // Expiry of old previews: daily at 10:00 AM. (Emails and follow-ups are sent by Instantly, not by this app.)
  cron.schedule('0 10 * * *', async () => {
    await expirePreviews();
  }, { timezone });

  console.log(`Cron jobs scheduled (${autoPipeline ? 'pipeline every 30min' : 'pipeline OFF (AUTO_PIPELINE=true to enable)'} · preview expiry daily at 10:00, ${timezone})`);
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
