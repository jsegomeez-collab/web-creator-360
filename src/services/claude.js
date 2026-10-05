import { buildGenerationPrompt } from '../prompts/generation.js';
import { writeWithClaude } from '../lib/claude.js';

// Legacy full-HTML generator of the Google Maps pipeline (Claude Sonnet 5.5 writes the whole page)
export async function generateWebsite(business, webData, checkoutUrl) {
  const prompt = buildGenerationPrompt(business, webData, checkoutUrl);

  const { text, stopReason } = await writeWithClaude({
    system: 'You are an elite web developer. Return ONLY the raw HTML document starting with <!DOCTYPE html>. Never use markdown code fences. Never add explanations before or after the HTML.',
    prompt,
    maxTokens: 32000,
  });

  const raw = text.trim();
  console.log(`[claude] stop_reason=${stopReason} chars=${raw.length}`);

  // Strip markdown code fences if Claude added them
  const html = raw
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  if (!html.startsWith('<!DOCTYPE') && !html.startsWith('<html')) {
    throw new Error(`Claude returned invalid HTML (starts with: ${html.slice(0, 80)})`);
  }

  if (stopReason === 'max_tokens') {
    console.warn('[claude] WARNING: HTML truncated — closing document');
    return html + '\n</body></html>';
  }

  return html;
}
