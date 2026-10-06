// The website engine: template (designed by hand) + texts (written by Claude Sonnet 5.5 for the real business).
//   const { html, template, usage } = await buildSite({ business })
// business: { name, city, state?, email?, phone?, sector?, naics_code?, activity?, registeredYear?, reviews? }
// If words of the template's sample business survive the first pass, only those texts are sent back once more; if
// they still survive, it throws (a site that names someone else's business must never be published).
import { writerItems } from './compile.js';
import { renderSite, findLeftovers } from './render.js';
import { chooseTemplate, loadTemplate, sampleTerms } from './templates.js';
import { writeTexts } from './writer.js';
import { displayName, sectorLabel } from '../prompts/newBusinessEmails.js';

export { chooseTemplate } from './templates.js';

// "RAMIREZ REMODELING LLC" → brand "Ramirez Remodeling", legal "Ramirez Remodeling LLC"
export function brandName(raw) {
  const legal = displayName(raw);
  const brand = legal.replace(/[\s,]+(LLC|L\.L\.C\.|INC|Inc\.?|CORP|Corp\.?|LTD|Ltd\.?|LLP|Co\.)$/i, '').trim();
  return { legal, brand: brand || legal };
}

export function businessFacts(business) {
  const { legal, brand } = brandName(business.name);
  return {
    brand,
    legalName: legal,
    city: business.city || 'Hartford',
    state: business.state || 'CT',
    sector: sectorLabel(business.sector) || business.sector || 'small business',
    activity: business.activity || business.naics_code || null,
    registeredYear: business.registeredYear || (business.registered_at ? String(business.registered_at).slice(0, 4) : null),
    email: business.email || null,
    phone: business.phone || null,
  };
}

const addUsage = (a = {}, b = {}) => ({ input_tokens: (a.input_tokens || 0) + (b.input_tokens || 0), output_tokens: (a.output_tokens || 0) + (b.output_tokens || 0) });

export async function buildSite({ business, template = chooseTemplate(business), write } = {}) {
  const compiled = loadTemplate(template);
  const facts = businessFacts(business);
  const drop = business.reviews?.length ? [] : ['reviews'];
  const items = writerItems(compiled, { drop });
  const terms = sampleTerms(template, { name: facts.brand, city: facts.city, year: facts.registeredYear });
  const renderFacts = { email: facts.email, phone: facts.phone, mapQuery: `${facts.city}, ${facts.state}` };

  const first = await writeTexts({ facts, items, template, sampleTerms: terms, write });
  let texts = first.texts;
  let usage = addUsage({}, first.usage);
  let html = renderSite(compiled, { texts, drop, facts: renderFacts });
  const own = [facts.email, facts.phone].filter(Boolean);   // the business's real contact data is never a leftover
  let leftovers = findLeftovers(html, terms, { ignore: own });

  if (leftovers.length) {
    // Second pass with just the texts that still carry a sample word (as they stand after the first pass)
    const stillBad = items.map(i => {
      const t = texts[i.id];
      const now = t ? { ...i, ...(i.en !== undefined ? { en: t.en || i.en, es: t.es || i.es } : { text: t.en || i.text }) } : i;
      return now;
    }).filter(i => findLeftovers(`${i.en ?? ''} ${i.es ?? ''} ${i.text ?? ''}`, leftovers, { ignore: own }).length);
    if (stillBad.length) {
      const second = await writeTexts({ facts, items: stillBad, template, sampleTerms: leftovers, write });
      texts = { ...texts, ...second.texts };
      usage = addUsage(usage, second.usage);
      html = renderSite(compiled, { texts, drop, facts: renderFacts });
      leftovers = findLeftovers(html, terms, { ignore: own });
    }
  }
  if (leftovers.length) throw new Error(`La web aún menciona el negocio de ejemplo (${leftovers.join(', ')}): no se publica`);
  return { html, template, usage };
}
