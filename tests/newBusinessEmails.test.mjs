// Textos de la secuencia: contenido, variantes, pie legal y que ningún email afirme que la web "ya está hecha".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEmail, SEQUENCE_DAYS, SEQUENCE_LENGTH, displayName, sectorLabel, firstSubject } from '../src/prompts/newBusinessEmails.js';

const NOW = new Date('2026-09-28T15:00:00Z');
const ctx = {
  formUrl: 'https://app.example.com/f/TOKEN123', unsubUrl: 'https://app.example.com/u/TOKEN123',
  senderName: 'Jose', companyName: 'Eternity Strategy', companyAddress: '1 Main St, Hartford, CT 06103', now: NOW,
};
const lead = (o = {}) => ({
  name: 'Limpieza Rivera LLC', city: 'Hartford', sector: 'limpieza', latino_strong: true, registered_at: '2026-09-20', first_subject: null, ...o,
});
const all = (l = lead()) => Array.from({ length: SEQUENCE_LENGTH }, (_, i) => renderEmail(l, i, ctx));

test('secuencia: días 0, 3, 7, 12, 18, 25 (6 emails)', () => {
  assert.deepEqual(SEQUENCE_DAYS, [0, 3, 7, 12, 18, 25]);
  assert.equal(SEQUENCE_LENGTH, 6);
  assert.throws(() => renderEmail(lead(), 6, ctx), /fuera de la secuencia/);
  assert.throws(() => renderEmail(lead(), -1, ctx), /fuera de la secuencia/);
});

test('email 0: asunto, saludo, registro público, ciudad, frase latina, sector, gancho, enlace y firma', () => {
  const e = renderEmail(lead(), 0, ctx);
  assert.equal(e.subject, 'Enhorabuena por Limpieza Rivera LLC 🎉');
  for (const s of [
    'Hola:', 'registro público de empresas de Connecticut', 'acabas de registrar Limpieza Rivera LLC en Hartford',
    '¡Enhorabuena por crear tu empresa en Estados Unidos y por aportar a nuestra comunidad latina!',
    'pensada para tu negocio de limpieza', 'gratis y sin compromiso', 'hoy tus clientes te buscan en Google',
    'Google Maps', 'los bancos también se fijan', 'Déjame tu teléfono aquí y yo mismo te llamo: https://app.example.com/f/TOKEN123',
    'Un abrazo,\nJose — Eternity Strategy',
  ]) assert.ok(e.text.includes(s), `falta: ${s}`);
});

test('frase latina solo si latino_strong; si no, la versión corta', () => {
  const weak = renderEmail(lead({ latino_strong: false }), 0, ctx).text;
  assert.ok(weak.includes('¡Enhorabuena por crear tu empresa en Estados Unidos!'));
  assert.ok(!weak.includes('comunidad latina'));
});

test('sector "otro" o desconocido: el texto no lo menciona (ni "de otro")', () => {
  const t = all(lead({ sector: 'otro' })).map(e => e.text).join('\n');
  assert.ok(!/ de otro|de null|de undefined/.test(t));
  assert.ok(renderEmail(lead({ sector: 'otro' }), 0, ctx).text.includes('pensada para tu negocio. El diseño'));
  assert.equal(sectorLabel('otro'), null);
  assert.equal(sectorLabel('construccion'), 'construcción');
});

test('"acabas de registrar" solo si se registró hace ≤30 días; si no, "registraste recientemente"', () => {
  assert.ok(renderEmail(lead({ registered_at: '2026-09-01' }), 0, ctx).text.includes('acabas de registrar'));
  const old = renderEmail(lead({ registered_at: '2026-07-01' }), 0, ctx).text;
  assert.ok(old.includes('registraste recientemente') && !old.includes('acabas de registrar'));
  assert.ok(renderEmail(lead({ registered_at: null }), 0, ctx).text.includes('acabas de registrar'));
});

test('ciudad ausente → "Connecticut"', () => {
  assert.ok(renderEmail(lead({ city: '' }), 0, ctx).text.includes('en Connecticut.'));
});

test('seguimientos: mismo hilo ("Re: asunto original"), cortos y con el texto de cada día', () => {
  const l = lead({ first_subject: 'Enhorabuena por Limpieza Rivera LLC 🎉' });
  const [, d3, d7, d12, d18, d25] = all(l);
  for (const e of [d3, d7, d12, d18, d25]) assert.equal(e.subject, 'Re: Enhorabuena por Limpieza Rivera LLC 🎉');
  assert.ok(d3.text.includes('¿Pudiste ver mi mensaje?') && d3.text.includes('Limpieza Rivera LLC'));
  assert.ok(d7.text.includes('salgan tus servicios de limpieza') && d7.text.includes('tus clientes de Hartford te encuentren en Google'));
  assert.ok(d12.text.includes('respóndeme a este email con un horario y te llamo yo'));
  assert.ok(d18.text.includes('"sí" o un "no"'));
  assert.ok(d25.text.includes('Este es mi último mensaje') && d25.text.includes('Mucho éxito con tu negocio'));
});

test('seguimiento sin first_subject guardado: reconstruye el asunto original', () => {
  assert.equal(renderEmail(lead({ first_subject: null }), 2, ctx).subject, `Re: ${firstSubject(lead())}`);
});

test('el enlace del formulario va en los emails 0,1,2 y 5; los del día 12 y 18 piden respuesta y no lo llevan', () => {
  const emails = all();
  const withForm = emails.map(e => e.text.split('\n\n').slice(0, -2).join('\n\n').includes(ctx.formUrl));   // cuerpo, sin el pie
  assert.deepEqual(withForm, [true, true, true, false, false, true]);
});

test('NINGÚN email dice que la web ya está hecha/lista/diseñada, ni menciona precio', () => {
  for (const e of all()) {
    const t = `${e.subject}\n${e.text}\n${e.html}`;
    assert.ok(!/ya est[aá] (hecha|lista|dise[nñ]ada|terminada)|est[aá] ya (hecha|lista)|ya la (hicimos|dise[nñ]amos)|ya te (dise[nñ]amos|hicimos)/i.test(t), `afirma que ya existe: ${e.subject}`);
    assert.ok(!/\$|USD|€|497|precio|cuesta/i.test(t), 'no debe mencionar precio');
    assert.ok(!/libero la web|última oportunidad|oferta/i.test(t), 'sin falsa escasez');
  }
});

test('todos los emails llevan pie legal: empresa, dirección postal y baja de un clic', () => {
  for (const e of all()) {
    assert.ok(e.text.includes('Eternity Strategy · 1 Main St, Hartford, CT 06103'));
    assert.ok(e.text.includes('darte de baja aquí: https://app.example.com/u/TOKEN123'));
    assert.ok(e.text.includes('registro público de empresas del estado de Connecticut'));
    assert.ok(e.html.includes('href="https://app.example.com/u/TOKEN123"'));
  }
});

test('HTML simple: sin imágenes, el formulario y la baja son los únicos enlaces', () => {
  for (const e of all()) {
    assert.ok(!/<img|<script|<style|<iframe/i.test(e.html));
    const hrefs = [...e.html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
    assert.ok(hrefs.every(h => h === ctx.formUrl || h === ctx.unsubUrl), hrefs.join(','));
    assert.ok(hrefs.includes(ctx.unsubUrl));
  }
});

test('escapa el nombre en el HTML (nada de inyección) pero el texto plano lo deja tal cual', () => {
  const e = renderEmail(lead({ name: 'Evil <script>alert(1)</script> & Co "LLC"' }), 0, ctx);
  assert.ok(!e.html.includes('<script>'));
  assert.ok(e.html.includes('&lt;script&gt;') && e.html.includes('&amp;'));
  assert.ok(e.text.includes('<script>alert(1)</script>'));
});

test('displayName: pasa a título solo si viene todo en mayúsculas', () => {
  assert.equal(displayName('EL RASPA ELECTROMECANICA LLC'), 'El Raspa Electromecanica LLC');
  assert.equal(displayName('MARIA DE LA CRUZ CLEANING LLC'), 'Maria de la Cruz Cleaning LLC');
  assert.equal(displayName('G&N transportation llc'), 'G&N transportation llc');
  assert.equal(displayName('  Enzo   Towing  '), 'Enzo Towing');
});

test('falta configuración → error claro (no se envía un email sin dirección postal o sin baja)', () => {
  for (const key of ['formUrl', 'unsubUrl', 'senderName', 'companyName', 'companyAddress']) {
    assert.throws(() => renderEmail(lead(), 0, { ...ctx, [key]: '' }), new RegExp(key));
  }
  assert.throws(() => renderEmail(lead(), 0, undefined), /falta formUrl/);
});
