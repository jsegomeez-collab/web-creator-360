// The hand-made templates (templates/sites/<key>.html), which one fits a business, and the words of each template's
// sample business that must never survive into a real site (checked after writing: see index.js).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compileTemplate } from './compile.js';

export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../templates/sites');

// sample: the sample business (brand, owners/staff, street). sampleCity: only checked when the real city is different.
export const TEMPLATES = {
  construccion: { sample: ['Ramírez', 'Ramirez', 'Luis', 'Ana', 'Arch St', '2025'], sampleCity: 'New Britain' },
  limpieza: { sample: ['Brillo', 'Daniela', 'Ríos', 'Park St', '2024'], sampleCity: 'Hartford' },
  jardineria: { sample: ['Hernández', 'Hernandez', 'Carlos', 'Ana', 'Thomaston Ave', '2024'], sampleCity: 'Waterbury' },
  comida: { sample: ['Doña Rosa', 'Rosa', 'Hernández', 'Luis', 'East Main St', 'Puebla', '2004'], sampleCity: 'Bridgeport' },
  belleza: { sample: ['Bella Luna', 'Luna', 'Restrepo', 'Andrés', 'Molina', 'Daniela', 'Pérez', 'Bedford St'], sampleCity: 'Stamford' },
  barberia: { sample: ['Filo', 'Héctor', 'Hector', 'Tito', 'Rivera', 'Jay', 'Morales', 'Nando', 'Ortiz', 'Park Avenue', 'Park Ave'], sampleCity: 'Bridgeport' },
  general: { sample: ['Núñez', 'Nunez', 'Carmen', 'Luis', 'East Main St', '2019'], sampleCity: 'Waterbury' },
};

export const templateExists = (key) => !!TEMPLATES[key] && existsSync(join(TEMPLATES_DIR, `${key}.html`));

// Sector (from the NAICS mapping of the registry / CSV) → template. Barber shops get their own template when it exists.
export function chooseTemplate({ sector, naics_code: naics = '', name = '' } = {}) {
  if (sector === 'belleza') {
    const barber = /812111/.test(naics) || /barber/i.test(name);
    return barber && templateExists('barberia') ? 'barberia' : 'belleza';
  }
  return ['construccion', 'limpieza', 'jardineria', 'comida'].includes(sector) ? sector : 'general';
}

const cache = new Map();
export function loadTemplate(key) {
  if (!templateExists(key)) throw new Error(`No existe la plantilla "${key}"`);
  const file = join(TEMPLATES_DIR, `${key}.html`);
  if (!cache.has(key)) cache.set(key, compileTemplate(readFileSync(file, 'utf8'), { key }));
  return cache.get(key);
}

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

// The sample words to look for in a finished site. Words that are also part of the real business (its name or city)
// are left out, so "Luna Barber LLC" can say Luna.
// year: the real year the business was registered — a sample founding year equal to it would be true, so it isn't watched
// Towns around each sample city. The writer is told to list real towns NEAR the business, so a business in Wolcott may truthfully
// name Waterbury: that is not a leftover of the template. The sample city is only a leftover far from its own area.
export const SAMPLE_CITY_AREA = {
  waterbury: ['Wolcott', 'Cheshire', 'Naugatuck', 'Prospect', 'Watertown', 'Middlebury', 'Southbury', 'Oxford', 'Thomaston', 'Plymouth', 'Bristol', 'Beacon Falls', 'Woodbury', 'Bethlehem', 'Seymour', 'Southington', 'Waterville', 'Oakville'],
  'new britain': ['Berlin', 'Kensington', 'Bristol', 'Plainville', 'Southington', 'Newington', 'Farmington', 'West Hartford', 'Wethersfield', 'Rocky Hill', 'Cromwell', 'Meriden', 'Middletown'],
  hartford: ['West Hartford', 'East Hartford', 'Wethersfield', 'Newington', 'Bloomfield', 'Windsor', 'Manchester', 'Glastonbury', 'Farmington', 'Avon', 'South Windsor', 'Rocky Hill', 'New Britain', 'Canton', 'Simsbury', 'East Windsor'],
  bridgeport: ['Stratford', 'Fairfield', 'Trumbull', 'Milford', 'Shelton', 'Monroe', 'Easton', 'Westport', 'Norwalk', 'Orange', 'Derby', 'Ansonia', 'Huntington', 'Devon'],
  stamford: ['Greenwich', 'Darien', 'Norwalk', 'New Canaan', 'Westport', 'Wilton', 'Fairfield', 'Riverside', 'Cos Cob', 'Old Greenwich', 'Ridgefield'],
};

// English-only sites (the "americanos" and Google Maps campaigns): the templates were made for bilingual Latino businesses, so they say
// "Hablamos español", "in English or Spanish"… which would be a FALSE claim for most of these owners. None of it may survive.
export const ENGLISH_ONLY_TERMS = ['español', 'Hablamos', 'Atendemos', 'Spanish', 'bilingual', 'bilingüe'];

export function sampleTerms(key, { name = '', city = '', year = '', audience = 'es' } = {}) {
  const t = TEMPLATES[key] || { sample: [] };
  const terms = [...t.sample, ...(audience === 'en' ? ENGLISH_ONLY_TERMS : [])];
  const area = (SAMPLE_CITY_AREA[fold(t.sampleCity || '')] || []).map(fold);
  if (t.sampleCity && fold(t.sampleCity) !== fold(city) && !area.includes(fold(city))) terms.push(t.sampleCity);
  const own = fold(`${name} ${city}`);
  return terms.filter(term => !own.includes(fold(term)) && term !== String(year));
}
