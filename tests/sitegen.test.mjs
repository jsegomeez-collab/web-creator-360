// Motor de webs: plantilla hecha a mano + textos escritos por Claude para el negocio real. Aquí Claude es un
// redactor simulado, así que no se gasta nada ni hace falta red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileTemplate, writerItems } from '../src/sitegen/compile.js';
import { renderSite, sanitizeFragment, findLeftovers } from '../src/sitegen/render.js';
import { chooseTemplate, loadTemplate, sampleTerms, TEMPLATES, templateExists } from '../src/sitegen/templates.js';
import { buildSite, brandName } from '../src/sitegen/index.js';
import { buildPrompt, OUTPUT_SCHEMA } from '../src/sitegen/writer.js';

const MINI = `<!DOCTYPE html><html lang="en"><head><title>Núñez Tax · Waterbury</title>
<meta name="description" content="Taxes in Waterbury by the Núñez family"></head><body>
<!-- slot: hero -->
<h1><span data-en>Tax help in <em>Waterbury</em></span><span data-es>Impuestos en <em>Waterbury</em></span></h1>
<a href="tel:+12035550142">(203) 555-0142</a> <a href="mailto:hola@nuneztax.com">hola@nuneztax.com</a>
<img src="x.jpg" alt="Carmen Núñez at her desk">
<p class="sign">Carmen Núñez</p>
<iframe src="https://maps.google.com/maps?q=Waterbury,+CT&z=11&output=embed"></iframe>
<!-- OPTIONAL: solo si hay reseñas reales de Google; si no, se elimina -->
<!-- slot: reviews -->
<section id="reviews"><p data-en>Great service</p><p data-es>Gran servicio</p><p>Maria G.</p></section>
<!-- /OPTIONAL reviews -->
<script>var hours = "Mon-Fri";</script>
</body></html>`;

test('compile: textos emparejados EN/ES, textos sueltos, atributos, secciones, bloque opcional y datos de ejemplo', () => {
  const c = compileTemplate(MINI, { key: 'mini' });
  const pair = c.units.find(u => u.kind === 'html' && u.lang === 'en');
  assert.equal(pair.text, 'Tax help in <em>Waterbury</em>');
  assert.equal(c.units.find(u => u.id === pair.pair).text, 'Impuestos en <em>Waterbury</em>');
  assert.equal(pair.slot, 'hero');
  assert.ok(c.units.some(u => u.kind === 'attr' && u.attr === 'alt' && u.text === 'Carmen Núñez at her desk'));
  assert.ok(c.units.some(u => u.kind === 'attr' && u.attr === 'content'));
  assert.ok(c.units.some(u => u.kind === 'text' && u.text === 'Carmen Núñez'));
  assert.ok(!c.units.some(u => /Mon-Fri/.test(u.text)), 'el texto de los <script> no es contenido');
  assert.deepEqual(c.optional.map(o => o.name), ['reviews']);
  assert.deepEqual(c.facts, { emails: ['hola@nuneztax.com'], phones: ['2035550142'], mapQueries: ['Waterbury,+CT'], directions: [] });
  // los textos del bloque de reseñas no se envían al redactor si ese bloque se quita
  assert.ok(writerItems(c).some(i => i.en === 'Great service'));
  assert.ok(!writerItems(c, { drop: ['reviews'] }).some(i => i.en === 'Great service'));
});

test('render: pone cada texto en su sitio (inglés y español), quita las reseñas y cambia email, teléfono y mapa', () => {
  const c = compileTemplate(MINI);
  const pair = c.units.find(u => u.kind === 'html' && u.lang === 'en');
  const sign = c.units.find(u => u.kind === 'text' && u.text === 'Carmen Núñez');
  const html = renderSite(c, {
    texts: { [pair.id]: { en: 'Tax help in <em>Hartford</em>', es: 'Impuestos en <em>Hartford</em>' }, [sign.id]: { en: 'Sol Tax & Books', es: '' } },
    drop: ['reviews'],
    facts: { email: 'sol@gmail.com', phone: '(860) 555-0199', mapQuery: 'Hartford, CT' },
  });
  assert.match(html, /<span data-en>Tax help in <em>Hartford<\/em><\/span><span data-es>Impuestos en <em>Hartford<\/em><\/span>/);
  assert.match(html, /<p class="sign">Sol Tax &amp; Books<\/p>/);
  assert.doesNotMatch(html, /Great service|Maria G\.|id="reviews"/);
  assert.match(html, /mailto:sol@gmail\.com">sol@gmail\.com/);
  assert.match(html, /tel:\+18605550199">\(860\) 555-0199/);
  assert.match(html, /maps\?q=Hartford,\+CT&z=11/);
  assert.match(html, /var hours = "Mon-Fri"/, 'los scripts quedan intactos');
});

test('sanitizeFragment: solo se aceptan las etiquetas que ya tenía el texto; lo demás queda como texto plano', () => {
  const original = 'Tax help in <em>Waterbury</em>';
  assert.equal(sanitizeFragment('Help in <em>Hartford</em> & more', original), 'Help in <em>Hartford</em> &amp; more');
  assert.equal(sanitizeFragment('Help <strong>now</strong>', original), 'Help now');
  assert.equal(sanitizeFragment('Help in <em>Hartford', original), 'Help in Hartford', 'etiquetas sin cerrar → texto plano');
  assert.equal(sanitizeFragment('<script>alert(1)</script>Hi', original), 'alert(1)Hi');
  assert.equal(sanitizeFragment('Rock &amp; roll', 'x'), 'Rock &amp; roll', 'las entidades válidas se respetan');
});

test('findLeftovers: encuentra palabras del negocio de ejemplo en el texto visible (también en alt), no en scripts', () => {
  const html = '<p>Hola</p><img alt="Carmen at work"><script>var Núñez=1</script>';
  assert.deepEqual(findLeftovers(html, ['Carmen', 'Núñez', 'Luis']), ['Carmen']);
  assert.deepEqual(findLeftovers('<p>Banana</p>', ['Ana']), [], 'palabra entera, no trozos');
});

test('las 7 plantillas reales se leen bien: textos emparejados, reseñas opcionales y datos de ejemplo', () => {
  for (const key of ['construccion', 'limpieza', 'jardineria', 'comida', 'belleza', 'barberia', 'general']) {
    const c = loadTemplate(key);
    assert.ok(c.units.length > 200, `${key}: ${c.units.length} textos`);
    assert.ok(c.optional.some(o => o.name === 'reviews'), `${key}: bloque de reseñas opcional`);
    assert.equal(c.facts.emails.length, 1, `${key}: un email de ejemplo`);
    assert.ok(c.facts.phones.length >= 1 && c.facts.mapQueries.length >= 1, key);
    // Renderizar sin textos nuevos y sin quitar nada devuelve la plantilla tal cual (salvo saltos de línea)
    assert.equal(renderSite(c), c.source, key);
  }
});

test('chooseTemplate: sector → plantilla; barberías a la suya si existe; el resto a la general', () => {
  assert.equal(chooseTemplate({ sector: 'construccion' }), 'construccion');
  assert.equal(chooseTemplate({ sector: 'comida' }), 'comida');
  assert.equal(chooseTemplate({ sector: 'taxes' }), 'general');
  assert.equal(chooseTemplate({ sector: 'otro' }), 'general');
  assert.equal(chooseTemplate({ sector: 'belleza', name: 'Glow Nails LLC' }), 'belleza');
  assert.ok(templateExists('barberia'));
  assert.equal(chooseTemplate({ sector: 'belleza', name: 'KINGS BARBER SHOP LLC' }), 'barberia');
  assert.equal(chooseTemplate({ sector: 'belleza', naics_code: 'Barber Shops (812111)' }), 'barberia');
  assert.equal(chooseTemplate({ sector: 'belleza', naics_code: 'Beauty Salons (812112)' }), 'belleza');
});

test('sampleTerms: no vigila palabras que forman parte del negocio real (nombre o ciudad)', () => {
  assert.ok(sampleTerms('belleza', { name: 'Glow', city: 'Hartford' }).includes('Luna'));
  assert.ok(!sampleTerms('belleza', { name: 'Luna Nails', city: 'Hartford' }).includes('Luna'));
  assert.ok(!sampleTerms('general', { name: 'Sol Tax', city: 'Waterbury' }).includes('Waterbury'), 'misma ciudad que el ejemplo');
  assert.ok(sampleTerms('general', { name: 'Sol Tax', city: 'Hartford' }).includes('Waterbury'));
  for (const key of Object.keys(TEMPLATES)) assert.ok(Array.isArray(sampleTerms(key, {})), key);
});

test('brandName: marca sin "LLC" para la web y nombre legal para el copyright', () => {
  assert.deepEqual(brandName('RAMIREZ REMODELING LLC'), { legal: 'Ramirez Remodeling LLC', brand: 'Ramirez Remodeling' });
  assert.deepEqual(brandName('Sol y Luna Tax, LLC'), { legal: 'Sol y Luna Tax, LLC', brand: 'Sol y Luna Tax' });
});

// Redactor simulado: cambia las palabras del ejemplo según `swap` (lo que haría Claude), y cuenta las llamadas
function fakeWriter(swap, { skipFirst = [] } = {}) {
  const calls = [];
  const write = async ({ prompt, format }) => {
    calls.push(prompt);
    assert.deepEqual(format, { type: 'json_schema', schema: OUTPUT_SCHEMA });
    const items = JSON.parse(prompt.slice(prompt.lastIndexOf('ITEMS\n') + 6));
    const change = (s) => Object.entries(swap).reduce((t, [a, b]) => t.split(a).join(b), s ?? '');
    const units = items.map(i => (i.en !== undefined ? { id: i.id, en: change(i.en), es: change(i.es) } : { id: i.id, en: change(i.text), es: '' }))
      .filter(u => calls.length > 1 || !skipFirst.some(w => items.find(i => i.id === u.id) && JSON.stringify(items.find(i => i.id === u.id)).includes(w)));
    return { text: JSON.stringify({ units }), stopReason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 } };
  };
  return { write, calls };
}

const SWAP_GENERAL = { 'Núñez Tax &amp; Insurance': 'Sol Tax &amp; Books', 'Núñez Tax & Insurance': 'Sol Tax & Books', 'Núñez': 'Sol', 'Nunez': 'Sol', 'Carmen': 'our team', 'Luis': 'our team', 'East Main St': 'downtown', 'Waterbury': 'Hartford', '2019': '2026' };

test('buildSite: escribe la plantilla general para un negocio real, sin rastro del ejemplo y con sus datos', async () => {
  const { write, calls } = fakeWriter(SWAP_GENERAL);
  const r = await buildSite({ business: { name: 'SOL TAX LLC', city: 'Hartford', email: 'sol@gmail.com', sector: 'taxes', registered_at: '2026-09-14' }, write });
  assert.equal(r.template, 'general');
  assert.equal(calls.length, 1);
  assert.deepEqual(r.usage, { input_tokens: 1000, output_tokens: 500 });
  assert.deepEqual(findLeftovers(r.html, ['Núñez', 'Carmen', 'Waterbury']), []);
  assert.match(r.html, /sol@gmail\.com/);
  assert.doesNotMatch(r.html, /hola@nuneztax\.com/);
  assert.match(r.html, /maps\.google\.com\/maps\?q=Hartford,\+CT/);
  assert.doesNotMatch(r.html, /id="reviews"/, 'sin reseñas reales, el bloque se quita');
  // El encargo lleva los datos reales y las reglas clave
  assert.match(calls[0], /"brand": "Sol Tax"/);
  assert.match(calls[0], /NEVER invent facts/);
  assert.match(calls[0], /Carmen/, 'le dice qué nombres del ejemplo quitar');
});

test('buildSite: si tras la primera pasada queda un nombre del ejemplo, repasa solo esos textos', async () => {
  const { write, calls } = fakeWriter(SWAP_GENERAL, { skipFirst: ['Carmen'] });
  const r = await buildSite({ business: { name: 'SOL TAX LLC', city: 'Hartford', email: 'sol@gmail.com', sector: 'taxes' }, write });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /Carmen/);
  assert.ok(calls[1].length < calls[0].length / 3, 'la segunda pasada solo lleva los textos pendientes');
  assert.deepEqual(r.usage, { input_tokens: 2000, output_tokens: 1000 });
  assert.deepEqual(findLeftovers(r.html, ['Carmen']), []);
});

test('buildSite: si el ejemplo sigue apareciendo tras el repaso, no devuelve la web', async () => {
  const lazy = async ({ prompt }) => ({ text: JSON.stringify({ units: [] }), stopReason: 'end_turn', usage: {} });
  await assert.rejects(buildSite({ business: { name: 'SOL TAX LLC', city: 'Hartford', sector: 'taxes' }, write: lazy }), /negocio de ejemplo/);
});

test('buildSite: errores claros si la respuesta se corta o no es JSON', async () => {
  const cut = async () => ({ text: '{"units":[', stopReason: 'max_tokens', usage: {} });
  await assert.rejects(buildSite({ business: { name: 'X LLC', city: 'Hartford', sector: 'taxes' }, write: cut }), /max_tokens/);
  const junk = async () => ({ text: 'lo siento', stopReason: 'end_turn', usage: {} });
  await assert.rejects(buildSite({ business: { name: 'X LLC', city: 'Hartford', sector: 'taxes' }, write: junk }), /JSON/);
});

test('buildPrompt: sin teléfono conocido pide conservar el de ejemplo', () => {
  const p = buildPrompt({ brand: 'Sol', legalName: 'Sol LLC', city: 'Hartford', state: 'CT', email: 'a@b.com', phone: null }, [], { template: 'general' });
  assert.match(p, /unknown: keep the sample phone/);
});

test('el texto dentro de un SVG (sello giratorio) y el enlace "cómo llegar" también se adaptan al negocio', () => {
  const page = `<html><body><!-- slot: story -->
<svg viewBox="0 0 10 10"><defs><path id="c" d="M0 0"/></defs><text><textPath href="#c">DE PUEBLA · A BRIDGEPORT · DESDE 2004</textPath></text></svg>
<a href="https://www.google.com/maps/dir/?api=1&amp;destination=742+East+Main+St+Bridgeport+CT+06608">Directions</a></body></html>`;
  const c = compileTemplate(page);
  const seal = c.units.find(u => /PUEBLA/.test(u.text));
  assert.ok(seal, 'el texto del sello se extrae');
  assert.deepEqual(c.facts.directions, ['742+East+Main+St+Bridgeport+CT+06608']);
  const html = renderSite(c, { texts: { [seal.id]: { en: 'HECHO EN HARTFORD', es: '' } }, facts: { mapQuery: 'Hartford, CT' } });
  assert.match(html, /<textPath href="#c">HECHO EN HARTFORD<\/textPath>/);
  assert.match(html, /destination=Hartford\+CT"/);
  assert.doesNotMatch(html, /Bridgeport|2004/);
});

test('findLeftovers: el email o el teléfono REAL del negocio no cuenta como resto del ejemplo ("ramirez11@gmail.com")', () => {
  const html = '<a href="mailto:ramirez11mejia123@gmail.com">ramirez11mejia123@gmail.com</a>';
  assert.deepEqual(findLeftovers(html, ['Ramirez']), ['Ramirez'], 'sin ignorar el email, sí lo marcaría');
  assert.deepEqual(findLeftovers(html, ['Ramirez'], { ignore: ['ramirez11mejia123@gmail.com'] }), []);
});

test('sampleTerms: los años de fundación del ejemplo se vigilan, salvo el año real de registro del negocio', () => {
  assert.ok(sampleTerms('comida', { name: 'Sol', city: 'Hartford' }).includes('2004'));
  assert.ok(sampleTerms('general', { name: 'Sol', city: 'Hartford' }).includes('2019'));
  assert.ok(!sampleTerms('general', { name: 'Sol', city: 'Hartford', year: '2019' }).includes('2019'), 'si se registró en 2019, decir 2019 es verdad');
});
