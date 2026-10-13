import slugify from 'slugify';
import supabase from '../db/supabase.js';
import { scrapeBusinessProfile } from '../services/businessProfile.js';
import { generateWebsite } from '../services/claude.js';
import { deployToVercel } from '../services/vercel.js';

const BATCH = 3; // businesses per stage per run (keep API costs controlled)
const INTER_DELAY = 3000; // ms between API calls

let isRunning = false;

export async function runAutoPipeline() {
  if (isRunning) {
    console.log('[pipeline] Already running, skipping this trigger');
    return { skipped: true };
  }

  isRunning = true;
  const stats = { scraped: 0, generated: 0, errors: 0 };
  const log = [];

  try {
    console.log('[pipeline] ═══ Auto pipeline starting ═══');
    await stageScrap(stats, log);
    await stageGenerate(stats, log);
    console.log(`[pipeline] ═══ Done — scraped:${stats.scraped} generated:${stats.generated} errors:${stats.errors} ═══`);
  } finally {
    isRunning = false;
  }

  return { ...stats, log };
}

// ─── Stage 1: prospected → scraped ─────────────────────────────────────────

async function stageScrap(stats, log) {
  const { data: businesses } = await supabase
    .from('businesses')
    .select('*')
    .eq('status', 'prospected')
    .not('website', 'is', null)
    .limit(BATCH);

  for (const biz of businesses || []) {
    try {
      console.log(`[pipeline] Scraping "${biz.name}"...`);
      const profile = await scrapeBusinessProfile(biz);
      const { description, services, social_networks, hours, language, email, value_proposition } = profile;

      await supabase.from('business_web_data').upsert(
        { business_id: biz.id, description, services, social_networks, hours, language, email, value_proposition, raw_data: profile },
        { onConflict: 'business_id' }
      );

      await supabase.from('businesses').update({ status: 'scraped' }).eq('id', biz.id);

      stats.scraped++;
      log.push({ stage: 'scrape', name: biz.name, status: 'ok', email: email || null });
      console.log(`[pipeline] ✓ Scraped "${biz.name}" — email: ${email || 'not found'}`);
    } catch (err) {
      stats.errors++;
      log.push({ stage: 'scrape', name: biz.name, status: 'error', reason: err.message });
      console.error(`[pipeline] ✗ Scrape failed for "${biz.name}":`, err.message);
    }
    await sleep(INTER_DELAY);
  }
}

// ─── Stage 2: scraped → generated ──────────────────────────────────────────

async function stageGenerate(stats, log) {
  const { data: businesses } = await supabase
    .from('businesses')
    .select('*')
    .eq('status', 'scraped')
    .limit(BATCH);

  for (const biz of businesses || []) {
    try {
      const { data: webData } = await supabase
        .from('business_web_data')
        .select('*')
        .eq('business_id', biz.id)
        .single();

      if (!webData) throw new Error('No web data found — scrape first');

      const slug = slugify(biz.name, { lower: true, strict: true });

      console.log(`[pipeline] Generating site for "${biz.name}"...`);
      const html = await generateWebsite(biz, webData, `${process.env.BASE_URL}/checkout/SITE_ID_PLACEHOLDER`);

      const { data: site, error: sErr } = await supabase
        .from('generated_sites')
        .upsert(
          { business_id: biz.id, slug, html_content: html, preview_url: null, status: 'preview' },
          { onConflict: 'slug' }
        )
        .select('id')
        .single();

      if (sErr) throw sErr;

      const finalHtml = html.replace(/SITE_ID_PLACEHOLDER/g, site.id);

      let previewUrl;
      try {
        previewUrl = await deployToVercel(slug, finalHtml);
        console.log(`[pipeline] ✓ Deployed "${slug}" → ${previewUrl}`);
      } catch (vErr) {
        console.warn(`[pipeline] Vercel failed, using local preview:`, vErr.message);
        previewUrl = `${process.env.BASE_URL}/preview/${slug}`;
      }

      await supabase.from('generated_sites')
        .update({ html_content: finalHtml, preview_url: previewUrl })
        .eq('id', site.id);

      await supabase.from('businesses').update({ status: 'generated' }).eq('id', biz.id);

      stats.generated++;
      log.push({ stage: 'generate', name: biz.name, status: 'ok', preview_url: previewUrl });
    } catch (err) {
      stats.errors++;
      log.push({ stage: 'generate', name: biz.name, status: 'error', reason: err.message });
      console.error(`[pipeline] ✗ Generate failed for "${biz.name}":`, err.message);
    }
    await sleep(INTER_DELAY);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Time zone of the "business hours" (and of the pipeline cron in cron/jobs.js). Fixed on purpose: the server's own clock
// is UTC on Render, which would send at the wrong hours.
export const PIPELINE_TIMEZONE = () => (process.env.PIPELINE_TIMEZONE || 'Europe/Madrid').trim();

// Mon–Fri, 8:00–18:59 in PIPELINE_TIMEZONE
export function isBusinessHours(now = new Date(), timeZone = PIPELINE_TIMEZONE()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).map(p => [p.type, p.value]));
  const hour = Number(parts.hour);
  return !['Sat', 'Sun'].includes(parts.weekday) && hour >= 8 && hour < 19;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
