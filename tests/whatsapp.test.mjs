// Mensajes de WhatsApp (primer contacto y seguimiento) y formato de teléfonos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, formatPhone } from '../src/services/whatsapp.js';

const b = { name: 'Coolfy Clima' };
const s = { preview_url: 'https://coolfy.vercel.app' };

test('buildMessage primer contacto (ES/EN)', () => {
  const es = buildMessage(b, s, 'es');
  assert.ok(es.startsWith('Hola 👋') && es.includes('*Coolfy Clima*') && es.includes('https://coolfy.vercel.app') && es.includes('$497'));
  assert.ok(buildMessage(b, s, 'en').startsWith('Hi 👋'));
});

test('buildMessage seguimiento (ES/EN) es distinto del primer contacto', () => {
  const es = buildMessage(b, s, 'es', true);
  assert.ok(es.startsWith('Hola de nuevo 👋') && es.includes('Hace unos días') && es.includes('https://coolfy.vercel.app'));
  const en = buildMessage(b, s, 'en', true);
  assert.ok(en.startsWith('Hi again 👋') && en.includes('A few days ago'));
  assert.notEqual(es, buildMessage(b, s, 'es'));
});

test('formatPhone: España y EE. UU.', () => {
  assert.equal(formatPhone('672577986'), '34672577986');          // móvil español
  assert.equal(formatPhone('912345678'), '34912345678');          // fijo español
  assert.equal(formatPhone('0034672577986'), '34672577986');      // prefijo 00
  assert.equal(formatPhone('+34 672 577 986'), '34672577986');
  assert.equal(formatPhone('(203) 555-0123'), '12035550123');     // 10 dígitos → EE. UU.
  assert.equal(formatPhone('1 203 555 0123'), '12035550123');     // ya lleva el 1
});
