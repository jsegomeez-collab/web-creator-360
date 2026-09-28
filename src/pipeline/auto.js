import slugify from 'slugify';
import supabase from '../db/supabase.js';
import { scrapeBusinessProfile } from '../services/gemini.js';
import { generateWebsite } from '../services/claude.js';
import { deployToVercel } from '../services/vercel.js';
import { sendOutreach } from '../services/outreach.js';
import { LEAD_BUSINESS_SOURCE } from '../services/newLeads.js';
import { getConnectionState } from '../services/whatsapp.js';

const BATCH = 3; // businesses per stage per run (keep API costs controlled)
const INTER_DELAY = 3000; // ms between API calls

let isRunning = false;

export async function runAutoPipeline() {
  if (isRunning) {
    console.log('[pipeline] Already running, skipping this trigger');
    return { skipped: true };
  }

  isRunning = true;
  const stats = { scraped: 0, generated: 0, sent: 0, errors: 0, skipped_no_email: 0 };
  const log = [];

  try {
    console.log('[pipeline] ═══ Auto pipeline starting ═══');
    await stageScrap(stats, log);
    await stageGenerate(stats, log);
    await stageOutreach(stats, log);
    console.log(`[pipeline] ═══ Done — scraped:${stats.scraped} generated:${stats.generated} sent:${stats.sent} errors:${stats.errors} ═══`);
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
      const { description, services, social_networks, hours, language, email, value_proposition, phone } = profile;

      await supabase.from('business_web_data').upsert(
        { business_id: biz.id, description, services, social_networks, hours, language, email, value_proposition, raw_data: profile },
        { onConflict: 'business_id' }
      );

      // Freshly scraped phone always wins over Google Places (same as routes/scrape.js)
      const bizUpdate = { status: 'scraped' };
      if (phone) bizUpdate.phone = phone;
      await supabase.from('businesses').update(bizUpdate).eq('id', biz.id);

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

// ─── Stage 3: generated (preview) → sent ───────────────────────────────────

async function stageOutreach(stats, log) {
  // Only send emails during business hours Mon–Fri 8:00–19:00 (local time)
  if (!isBusinessHours()) {
    console.log('[pipeline] Outside business hours — skipping outreach');
    return;
  }

  // Sites in preview state with a deployed Vercel URL, not yet sent
  const { data: candidates } = await supabase
    .from('generated_sites')
    .select('id, slug, preview_url, business_id')
    .eq('status', 'preview')
    .not('preview_url', 'is', null);

  // Demos of the new-business campaign leads are never sent from here: their contact is the campaign's own flow.
  // (If the `source` column doesn't exist yet the query returns nothing and everything stays as before.)
  const { data: leadBusinesses } = await supabase.from('businesses').select('id').eq('source', LEAD_BUSINESS_SOURCE);
  const campaignOnly = new Set((leadBusinesses || []).map(b => b.id));
  const sites = (candidates || []).filter(s => !campaignOnly.has(s.business_id)).slice(0, BATCH);

  for (const site of sites) {
    try {
      // Check not already contacted
      const { data: existing } = await supabase
        .from('outreach_log')
        .select('id')
        .eq('site_id', site.id)
        .limit(1);

      if (existing?.length) {
        await supabase.from('generated_sites').update({ status: 'sent' }).eq('id', site.id);
        continue;
      }

      // Fetch business and email
      const [{ data: biz }, { data: webData }] = await Promise.all([
        supabase.from('businesses').select('*').eq('id', site.business_id).single(),
        supabase.from('business_web_data').select('email, language').eq('business_id', site.business_id).single(),
      ]);

      const contactEmail = webData?.email || null;
      const language = webData?.language || 'es';

      // Need at least one channel: an email, or a phone with WhatsApp connected
      const hasWhatsApp = !!biz?.phone && (await getConnectionState()) === 'open';
      if (!contactEmail && !hasWhatsApp) {
        stats.skipped_no_email++;
        log.push({ stage: 'outreach', name: biz?.name, status: 'skipped', reason: 'sin email ni WhatsApp disponible' });
        console.log(`[pipeline] ⚠ No email/WhatsApp for "${biz?.name}" — skipping outreach`);
        continue;
      }

      console.log(`[pipeline] Contacting "${biz.name}"...`);
      const result = await sendOutreach(biz, site, contactEmail, language, 0);

      stats.sent++;
      log.push({ stage: 'outreach', name: biz.name, status: 'ok', email: result.emailSent ? contactEmail : null, wa: result.waSent });
      console.log(`[pipeline] ✓ Sent to "${biz.name}" — email:${result.emailSent} wa:${result.waSent}`);
    } catch (err) {
      stats.errors++;
      log.push({ stage: 'outreach', name: sites.find(s => s.id === site.id)?.slug, status: 'error', reason: err.message });
      console.error(`[pipeline] ✗ Outreach failed for site ${site.id}:`, err.message);
    }
    await sleep(INTER_DELAY);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isBusinessHours() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  const hour = now.getHours();
  return day >= 1 && day <= 5 && hour >= 8 && hour < 19;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
