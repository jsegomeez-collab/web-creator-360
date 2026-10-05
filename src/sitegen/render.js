// Puts the new texts into a compiled template (see compile.js) without touching the design, removes OPTIONAL blocks
// that have no data, and swaps the sample facts (email, phone, map) for the real ones.
//   texts: { [itemId]: { en, es } }  — for lone items the text is in `en`
//   drop:  names of OPTIONAL blocks to remove (e.g. ['reviews'] when the business has no Google reviews)

const TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g;
const escText = (s) => String(s).replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
const tagName = (tok) => tok.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/)[1].toLowerCase();
const VOID = new Set(['br', 'wbr', 'img', 'hr', 'input']);

// The writer may only reuse the inline tags the original text had (same tag, same attributes), properly nested.
// Anything else (a new tag, a changed class, broken nesting) → the tags are dropped and the words kept as plain text.
export function sanitizeFragment(value, original) {
  const allowed = new Set(original.match(TAG_RE) || []);
  const tokens = String(value).match(TAG_RE) || [];
  let ok = tokens.every(t => allowed.has(t));
  if (ok) {
    const stack = [];
    for (const t of tokens) {
      const name = tagName(t);
      if (VOID.has(name) || t.endsWith('/>')) continue;
      if (t.startsWith('</')) { if (stack.pop() !== name) { ok = false; break; } } else stack.push(name);
    }
    if (stack.length) ok = false;
  }
  const parts = String(value).split(TAG_RE);
  if (!ok) return escText(parts.join(''));
  return parts.map((text, i) => escText(text) + (tokens[i] ?? '')).join('');
}

const clean = (unit, value) => (unit.kind === 'html' ? sanitizeFragment(value, unit.text) : unit.kind === 'attr' ? escAttr(value) : escText(value));

// The new text for one unit, or undefined to keep the original
function newTextFor(unit, texts) {
  if (unit.pair && unit.lang === 'es') return texts[unit.pair]?.es || undefined;
  const t = texts[unit.id];
  if (!t) return undefined;
  if (unit.pair) return t.en || undefined;
  return (t.en || t.text || t.es) || undefined;
}

// 10 digits → the ways a phone is written in the templates
const phoneForms = (d) => [
  `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`, `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`,
  `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`, `+1 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`, `+1${d}`, d,
];

export function renderSite(compiled, { texts = {}, drop = [], facts = {} } = {}) {
  const dropped = compiled.optional.filter(o => drop.includes(o.name)).map(o => o.range);
  const inside = (r) => dropped.some(([a, b]) => r[0] >= a && r[1] <= b);

  const edits = dropped.map(([start, end]) => ({ start, end, value: '' }));
  for (const unit of compiled.units) {
    if (inside(unit.range)) continue;
    const value = newTextFor(unit, texts);
    if (value === undefined) continue;
    edits.push({ start: unit.range[0], end: unit.range[1], value: clean(unit, value) });
  }
  let html = compiled.source;
  for (const e of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, e.start) + e.value + html.slice(e.end);

  // Sample facts → real facts (everywhere: visible text, links, the map)
  if (facts.email) for (const sample of compiled.facts.emails) html = html.replace(new RegExp(sample.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), facts.email);
  const phone = String(facts.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (phone.length === 10) {
    for (const sample of compiled.facts.phones) {
      const from = phoneForms(sample), to = phoneForms(phone);
      from.forEach((f, i) => { html = html.split(f).join(to[i]); });
    }
  }
  if (facts.mapQuery) {
    const q = encodeURIComponent(facts.mapQuery).replace(/%20/g, '+').replace(/%2C/gi, ',');
    for (const sample of compiled.facts.mapQueries) html = html.split(`q=${sample}`).join(`q=${q}`);
  }
  return html;
}

// Words of the sample business still visible in the page (outside scripts, styles and tags) → [] when clean
export function findLeftovers(html, terms) {
  const visible = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ')
    .replace(/<[^>]*\balt="([^"]*)"[^>]*>/gi, ' $1 ').replace(/<[^>]+>/g, ' ');
  return terms.filter(t => new RegExp(`(^|[^\\p{L}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'iu').test(visible));
}
