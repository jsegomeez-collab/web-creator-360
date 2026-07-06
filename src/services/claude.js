import Anthropic from '@anthropic-ai/sdk';
import { buildGenerationPrompt } from '../prompts/generation.js';

let client;

function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export async function generateWebsite(business, webData, checkoutUrl) {
  const prompt = buildGenerationPrompt(business, webData, checkoutUrl);

  // Use streaming so the API doesn't time out on long generations
  let raw = '';
  let stopReason = 'end_turn';

  const stream = getClient().messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 32000,
    system: 'You are an elite web developer. Return ONLY the raw HTML document starting with <!DOCTYPE html>. Never use markdown code fences. Never add explanations before or after the HTML.',
    messages: [{ role: 'user', content: prompt }],
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      raw += chunk.delta.text;
    }
    if (chunk.type === 'message_delta' && chunk.delta?.stop_reason) {
      stopReason = chunk.delta.stop_reason;
    }
  }

  raw = raw.trim();
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
