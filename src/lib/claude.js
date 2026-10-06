// One place to talk to Claude Sonnet 5.5, the model that writes the websites (both the template copy and the legacy
// full-HTML generator). Streamed, so long answers never hit HTTP timeouts.
//   - output_config.effort: "low" is the recommended level for content generation (less thinking, lower cost)
//   - server-side refusal fallback ("fallbacks: default", Claude API only): if the model declines a request in a
//     category that has a fallback, the API re-runs it on another model inside the same call
//   - format: optional JSON schema (structured outputs) → the answer is guaranteed to be valid JSON of that shape
import Anthropic from '@anthropic-ai/sdk';

export const WRITER_MODEL = 'claude-sonnet-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let client;
export const getClaude = () => (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

// → { text, stopReason, usage }. Throws on a refusal (with its category) so callers never publish a half answer.
// cachedPrefix: text that is the same across many requests (rules + a template's texts): sent first and cached for an hour,
// so the following requests read it from the cache at a tenth of the price. `prompt` is the part that changes.
export async function writeWithClaude({ system, prompt, cachedPrefix = null, maxTokens = 16000, effort = 'low', format = null, anthropic = getClaude() }) {
  const stream = anthropic.beta.messages.stream({
    model: WRITER_MODEL,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: cachedPrefix ? [{ type: 'text', text: cachedPrefix, cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: prompt }] : prompt }],
    output_config: { effort, ...(format ? { format } : {}) },
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    throw new Error(`Claude no ha querido escribir este contenido (${message.stop_details?.category ?? 'sin categoría'})`);
  }
  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, stopReason: message.stop_reason, usage: message.usage };
}
