// Turns one hand-made template (templates/sites/<key>.html) into something the engine can fill:
//   - every business text becomes a numbered "unit" (its exact place in the file is remembered, the design is untouched)
//       html  → inner HTML of an element with data-en / data-es (an EN element followed by its ES sibling is ONE pair)
//       text  → a plain text node outside those elements (logo, phone, towns, addresses…)
//       attr  → alt / title / aria-label / placeholder / data-ph-en / data-ph-es / meta description
//   - each unit knows its section (the nearest <!-- slot: … --> comment before it)
//   - OPTIONAL blocks (<!-- slot: reviews · OPTIONAL … --> + the element after it) can be removed at render time
//   - the sample facts (email, phone, map query) are collected so they can be swapped for the real ones
// Nothing here calls the network: compile once, render many times.
import { parse } from 'parse5';

const SKIP = new Set(['script', 'style', 'svg', 'noscript', 'math', 'iframe']);
const TEXT_ATTRS = ['alt', 'title', 'aria-label', 'placeholder', 'data-ph-en', 'data-ph-es'];
const META_TEXT = /^(description|og:title|og:description|twitter:title|twitter:description)$/i;
const hasLetters = (s) => /\p{L}/u.test(s);

const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;

// Offsets of the VALUE inside name="value" (parse5 gives the whole attribute)
function attrValueRange(source, loc) {
  const raw = source.slice(loc.startOffset, loc.endOffset);
  const eq = raw.indexOf('=');
  if (eq < 0) return null;
  let start = eq + 1;
  while (/\s/.test(raw[start])) start++;
  let end = raw.length;
  if (raw[start] === '"' || raw[start] === "'") { start++; end--; }
  return [loc.startOffset + start, loc.startOffset + end];
}

export function compileTemplate(sourceRaw, { key = 'template' } = {}) {
  const source = String(sourceRaw).replace(/\r\n?/g, '\n');   // parse5 offsets are only exact without CR
  const doc = parse(source, { sourceCodeLocationInfo: true });

  const units = [];
  const optional = [];            // { name, range: [start, end] }
  let slot = 'page';
  let pendingOptional = null;
  let openRegion = null;          // an <!-- OPTIONAL --> comment waiting for its <!-- /OPTIONAL -->
  let seq = 0;
  const addUnit = (u) => { const unit = { id: `u${++seq}`, slot, ...u }; units.push(unit); return unit; };

  function visitAttrs(node) {
    const loc = node.sourceCodeLocation?.startTag?.attrs || node.sourceCodeLocation?.attrs;
    if (!loc) return;
    const names = [...TEXT_ATTRS];
    if (node.tagName === 'meta' && META_TEXT.test(attr(node, 'name') || attr(node, 'property') || '')) names.push('content');
    for (const name of names) {
      const value = attr(node, name);
      if (!value || !hasLetters(value) || !loc[name]) continue;
      const range = attrValueRange(source, loc[name]);
      if (range) addUnit({ kind: 'attr', attr: name, lang: name.endsWith('-es') ? 'es' : name.endsWith('-en') ? 'en' : null, range, text: source.slice(...range) });
    }
  }

  function walk(parent) {
    let lastEn = null;            // the last data-en unit among these siblings, waiting for its data-es partner
    const kids = parent.nodeName === 'template' ? parent.content.childNodes : parent.childNodes;
    for (const node of kids || []) {
      if (node.nodeName === '#comment') {
        const text = node.data.trim();
        const loc = node.sourceCodeLocation;
        // Two ways to mark an optional block:
        //   <!-- OPTIONAL: … --> … <!-- /OPTIONAL … -->        (region between the two comments)
        //   <!-- slot: reviews · OPTIONAL … --> <section>…       (just the next element)
        if (/^\/OPTIONAL/i.test(text)) {
          if (openRegion && loc) { optional.push({ name: openRegion.name, range: [openRegion.start, loc.endOffset] }); openRegion = null; }
          continue;
        }
        if (/^OPTIONAL/i.test(text) && loc) {
          openRegion = { start: loc.startOffset, name: /rese(ñ|n)as|reviews/i.test(text) ? 'reviews' : null };
          continue;
        }
        const m = text.match(/slot:\s*([^·(\n]+?)\s*(?:[·(]|$)/i) || text.match(/slot:\s*(\S+)/i);
        if (m) { slot = m[1].trim(); if (openRegion && !openRegion.name) openRegion.name = slot.split(/[\s/]/)[0].toLowerCase(); }
        const opt = text.match(/slot:\s*([\w-]+)[^\n]*OPTIONAL/i);
        if (opt) pendingOptional = opt[1].toLowerCase();
        continue;
      }
      if (node.nodeName === '#text') {
        const loc = node.sourceCodeLocation;
        if (!loc || !hasLetters(node.value)) continue;
        const raw = source.slice(loc.startOffset, loc.endOffset);
        const lead = raw.length - raw.trimStart().length;
        const trail = raw.length - raw.trimEnd().length;
        addUnit({ kind: 'text', range: [loc.startOffset + lead, loc.endOffset - trail], text: raw.trim() });
        continue;
      }
      if (!node.tagName || !node.sourceCodeLocation) continue;
      if (pendingOptional) {
        optional.push({ name: pendingOptional, range: [node.sourceCodeLocation.startOffset, node.sourceCodeLocation.endOffset] });
        pendingOptional = null;
      }
      if (SKIP.has(node.tagName)) { if (node.tagName !== 'script' && node.tagName !== 'style') visitAttrs(node); continue; }
      visitAttrs(node);

      const lang = attr(node, 'data-en') !== undefined ? 'en' : attr(node, 'data-es') !== undefined ? 'es' : null;
      const { startTag, endTag } = node.sourceCodeLocation;
      if (lang && startTag && endTag) {
        const range = [startTag.endOffset, endTag.startOffset];
        const unit = addUnit({ kind: 'html', lang, range, text: source.slice(...range) });
        if (lang === 'en') lastEn = { unit, tag: node.tagName };
        else if (lastEn && lastEn.tag === node.tagName && !lastEn.unit.pair) { lastEn.unit.pair = unit.id; unit.pair = lastEn.unit.id; lastEn = null; }
        continue;
      }
      lastEn = null;
      walk(node);
    }
  }
  walk(doc);

  // Sample facts, swapped for the real business at render time
  const facts = {
    emails: [...new Set([...source.matchAll(/mailto:([^"'?\s>]+)/gi)].map(m => m[1].toLowerCase()))],
    phones: [...new Set([...source.matchAll(/tel:\+?1?(\d{10})/gi)].map(m => m[1]))],
    mapQueries: [...new Set([...source.matchAll(/maps\.google\.com\/(?:maps)?\?q=([^&"'\s]+)/gi)].map(m => m[1]))],
  };

  return { key, source, units, optional, facts };
}

// A pair (EN + ES) is presented to the writer as one item; lone units as another.
// drop: OPTIONAL blocks that will be removed, so their texts aren't sent (nor paid for).
export function writerItems(compiled, { drop = [] } = {}) {
  const byId = new Map(compiled.units.map(u => [u.id, u]));
  const dropped = compiled.optional.filter(o => drop.includes(o.name)).map(o => o.range);
  const items = [];
  for (const u of compiled.units) {
    if (u.pair && u.lang === 'es') continue;
    if (dropped.some(([a, b]) => u.range[0] >= a && u.range[1] <= b)) continue;
    if (u.pair) items.push({ id: u.id, slot: u.slot, kind: u.kind, en: u.text, es: byId.get(u.pair).text });
    else items.push({ id: u.id, slot: u.slot, kind: u.kind, ...(u.attr ? { attr: u.attr } : {}), lang: u.lang ?? undefined, text: u.text });
  }
  return items;
}
