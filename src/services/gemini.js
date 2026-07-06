import Anthropic from '@anthropic-ai/sdk';
import { buildScrapingPrompt } from '../prompts/scraping.js';
import { extractFromWebsite } from './imageExtractor.js';

let client;

function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export async function scrapeBusinessProfile(business) {
  // Extract images, brand color AND emails from the website in one pass
  const { images, brandColor, emails } = await extractFromWebsite(business.website);

  if (emails.length) {
    console.log(`[scrape] Found emails for "${business.name}":`, emails);
  }

  const prompt = buildScrapingPrompt(business, emails);

  const message = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text.trim();
  const cleaned = text.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
  const data = JSON.parse(cleaned);

  validateProfile(data);

  // If we found emails directly from the site, always prefer those (more reliable than inference)
  if (emails.length) data.email = emails[0];

  data.images = images;
  data.brandColor = brandColor;

  return data;
}

function validateProfile(data) {
  if (!data.description) throw new Error('Missing description in scraped profile');
  if (!Array.isArray(data.services)) data.services = [];
  if (!Array.isArray(data.social_networks)) data.social_networks = [];
  if (!data.language) data.language = 'es';
  if (!data.tone) data.tone = 'profesional';
}
