// Where and what to look for in the Google Maps campaign (English, any owner): cities of Florida, Texas and New Jersey, and
// local businesses that usually have no website. Each run takes the next (zone, categories) pair of the rotation.
export const ZONES = [
  // Florida
  { state: 'FL', query: 'Hialeah, FL' }, { state: 'FL', query: 'Miami, FL' }, { state: 'FL', query: 'Kissimmee, FL' },
  { state: 'FL', query: 'Orlando, FL' }, { state: 'FL', query: 'Homestead, FL' }, { state: 'FL', query: 'Tampa, FL' },
  { state: 'FL', query: 'Doral, FL' }, { state: 'FL', query: 'West Palm Beach, FL' }, { state: 'FL', query: 'Fort Myers, FL' },
  // Texas
  { state: 'TX', query: 'Houston, TX' }, { state: 'TX', query: 'San Antonio, TX' }, { state: 'TX', query: 'El Paso, TX' },
  { state: 'TX', query: 'Dallas, TX' }, { state: 'TX', query: 'McAllen, TX' }, { state: 'TX', query: 'Laredo, TX' },
  { state: 'TX', query: 'Brownsville, TX' }, { state: 'TX', query: 'Austin, TX' }, { state: 'TX', query: 'Fort Worth, TX' },
  // New Jersey
  { state: 'NJ', query: 'Union City, NJ' }, { state: 'NJ', query: 'Paterson, NJ' }, { state: 'NJ', query: 'Elizabeth, NJ' },
  { state: 'NJ', query: 'Perth Amboy, NJ' }, { state: 'NJ', query: 'Passaic, NJ' }, { state: 'NJ', query: 'Newark, NJ' },
  { state: 'NJ', query: 'West New York, NJ' }, { state: 'NJ', query: 'Camden, NJ' },
];

// `search` is what is typed in Maps; `sector` picks the website template. Kinds of business where a website brings customers.
export const CATEGORIES = [
  { search: 'barber shop', sector: 'belleza' }, { search: 'hair salon', sector: 'belleza' }, { search: 'nail salon', sector: 'belleza' },
  { search: 'taco restaurant', sector: 'comida' }, { search: 'bakery', sector: 'comida' }, { search: 'food truck', sector: 'comida' },
  { search: 'catering service', sector: 'comida' },
  { search: 'house cleaning service', sector: 'limpieza' }, { search: 'landscaping service', sector: 'jardineria' },
  { search: 'painter', sector: 'construccion' }, { search: 'roofing contractor', sector: 'construccion' },
  { search: 'plumber', sector: 'construccion' }, { search: 'electrician', sector: 'construccion' },
  { search: 'remodeling contractor', sector: 'construccion' }, { search: 'handyman', sector: 'construccion' },
  { search: 'auto repair shop', sector: 'auto' }, { search: 'mobile mechanic', sector: 'auto' }, { search: 'car detailing', sector: 'auto' },
  { search: 'moving company', sector: 'transporte' }, { search: 'pressure washing', sector: 'limpieza' },
  { search: 'tax preparation service', sector: 'taxes' }, { search: 'insurance agency', sector: 'seguros' },
  { search: 'event decorator', sector: 'eventos' }, { search: 'DJ service', sector: 'eventos' }, { search: 'photographer', sector: 'eventos' },
  { search: 'tattoo shop', sector: 'otro' }, { search: 'daycare', sector: 'otro' }, { search: 'dog groomer', sector: 'otro' },
];

// The i-th run in a fixed rotation: zones change fastest, so each run covers a new city; every full turn moves on to the next categories
export function pickRun(index, { categoriesPerRun = 3 } = {}) {
  const zone = ZONES[index % ZONES.length];
  const turn = Math.floor(index / ZONES.length);
  const categories = Array.from({ length: categoriesPerRun }, (_, k) => CATEGORIES[(turn * categoriesPerRun + k) % CATEGORIES.length]);
  return { zone, categories };
}
