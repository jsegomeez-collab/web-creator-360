// Claude Sonnet 5.5 rewrites the texts of a template for one real business. It receives the template's texts (with the
// section each belongs to) and returns only the ones it changes, as JSON (structured outputs: always valid).
import { writeWithClaude } from '../lib/claude.js';

const BANNED = [
  'dream / de tus sueños', 'excellence / excelencia', 'passion / pasión', 'integral solutions / soluciones integrales',
  'unparalleled / inigualable', 'elevate', 'seamless', 'top-notch', 'one-stop', 'cutting-edge', 'state-of-the-art',
  '"Ready to…?" / "¿Listo para…?"', 'your trusted partner / tu socio de confianza', "we've got you covered",
  'calidad y profesionalidad', 'perfect / perfecto in headlines',
];

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, en: { type: 'string' }, es: { type: 'string' } },
        required: ['id', 'en', 'es'],
        additionalProperties: false,
      },
    },
  },
  required: ['units'],
  additionalProperties: false,
};

export const SYSTEM = `You adapt the copy of a hand-designed small-business website template to a real business. The design is fixed; you only rewrite texts. The result is a free demo website shown to the business owner (a Hispanic/Latino entrepreneur in the United States), so it must read as if written for their business by a good local copywriter: specific, warm, plain, never generic marketing talk.`;

// The prompt in two parts. STABLE = rules + the template's texts: identical for every business that uses the same template,
// so it is sent as a cacheable prefix (reading it from the cache costs a tenth of normal input). VARIABLE = the real business.
// facts: { brand, legalName, city, state, activity, sector, registeredYear, email, phone }
export function buildPromptParts(facts, items, { template, sampleTerms = [] } = {}) {
  const stable = `TEMPLATE: "${template}". Each item below is a text of the page as it is now, written for a FICTIONAL sample business. Items have an id, the page section ("slot") they belong to, and either an English + Spanish pair ("en"/"es") or a single text ("text", with "lang" when it is language-specific, and "attr" when it is an HTML attribute such as alt text or a placeholder). The real business is described after the items.

YOUR TASK
Rewrite every item that refers to the sample business so it fits the real business. Return ONLY the items you change.
- Anything specific to the sample must go: its name, the names of its owners and staff, its street address, its city and nearby towns, its founding story and years, its specific jobs, dishes or services, its photo captions.
- Keep unchanged (so: do not return) generic interface labels that fit any business, like "Menu", "Call", "Send request", "FAQ".
- Brand: use the real brand wherever the sample brand appears (logo, titles, footer); the legal name only in the copyright line.
- Place: for town lists use real towns near the real city. Never write a street address; say the town instead. Map and directions texts refer to the real city.
- Services, menus, prices, FAQ: make them right for the real activity. If the name reveals a specialty (a cuisine, a trade like painting or tile, a country), follow it. Prices must be realistic for Connecticut and keep the original format.
- The business is new: NEVER invent facts that could be false claims — no years of experience, numbers of clients or jobs, awards, certifications, ratings or reviews. Keep placeholders such as license numbers ("HIC.0000000", "#0000000") exactly as they are. Opening hours: keep them exactly as they are.
- People: the owners are unknown. Don't name anyone; write as "we", "our team" or "the owner". Where the sample shows a person's name as a caption or signature, use the brand or a role instead.
- Keep each text about the same length as the original (±20%) and in the same role (a headline stays a short headline).
- HTML: some texts contain inline tags (<em>, <br>, <span class="…">…). Keep exactly the same tags with the same attributes, in the same structure; only change the words. Write & as &amp;.
- English: natural American English. Spanish: natural US Latino Spanish, keeping the same tú/usted as the original.
- Never use these words or phrases: ${BANNED.join('; ')}. No emojis.

OUTPUT: JSON {"units":[{"id","en","es"}]} with only the changed items. For a pair, "en" and "es" are the new English and Spanish. For a single text, put the new text in "en" and leave "es" empty.

ITEMS
${JSON.stringify(items)}`;

  const variable = `BUSINESS (the real one)
${JSON.stringify(facts, null, 2)}

For this business:
- Words of the sample that must not survive${sampleTerms.length ? `: ${sampleTerms.join(', ')}` : ''}.
- Brand: "${facts.brand}"; legal name (copyright line only): "${facts.legalName}".
- Place: ${facts.city}, ${facts.state}.
- Activity: ${facts.activity || facts.sector}. Registered in ${facts.registeredYear || 'recent years'}: a new business.
- Contact: email ${facts.email || '(keep the sample email)'}; phone ${facts.phone || '(unknown: keep the sample phone number exactly as it is)'}.`;
  return { stable, variable };
}

// The whole prompt as one text (previews and tests)
export function buildPrompt(facts, items, options) {
  const { stable, variable } = buildPromptParts(facts, items, options);
  return `${stable}\n\n${variable}`;
}

// → { texts: { id: { en, es } }, usage }
export async function writeTexts({ facts, items, template, sampleTerms, write = writeWithClaude }) {
  const { text, usage, stopReason } = await write({
    system: SYSTEM,
    ...(({ stable, variable }) => ({ cachedPrefix: stable, prompt: variable }))(buildPromptParts(facts, items, { template, sampleTerms })),
    maxTokens: 32000,
    effort: 'low',
    format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
  });
  if (stopReason === 'max_tokens') throw new Error('La respuesta de Claude se cortó antes de terminar (max_tokens)');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Claude no devolvió un JSON válido'); }
  const known = new Set(items.map(i => i.id));
  const texts = {};
  for (const u of data.units || []) if (known.has(u.id)) texts[u.id] = { en: u.en ?? '', es: u.es ?? '' };
  return { texts, usage };
}
