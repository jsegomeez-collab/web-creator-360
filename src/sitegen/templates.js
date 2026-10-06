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
export function sampleTerms(key, { name = '', city = '', year = '' } = {}) {
  const t = TEMPLATES[key] || { sample: [] };
  const terms = [...t.sample];
  if (t.sampleCity && fold(t.sampleCity) !== fold(city)) terms.push(t.sampleCity);
  const own = fold(`${name} ${city}`);
  return terms.filter(term => !own.includes(fold(term)) && term !== String(year));
}
