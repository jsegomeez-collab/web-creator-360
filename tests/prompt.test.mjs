// Prompt de generación: el botón flotante de WhatsApp no debe generarse roto en negocios sin teléfono.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGenerationPrompt } from '../src/prompts/generation.js';

const webData = { description: 'd', services: ['a'], language: 'es', raw_data: { images: [] } };

test('negocio SIN teléfono: se le dice al modelo que omita el botón de WhatsApp', () => {
  const p = buildGenerationPrompt({ name: 'X', category: 'c', phone: null, address: 'a' }, webData, 'x');
  assert.ok(p.includes('ESTE NEGOCIO NO TIENE TELÉFONO: OMITE POR COMPLETO ESTE BOTÓN'));
});

test('negocio CON teléfono: el prompt no cambia (sin aviso; WhatsApp, testimonios y precio siguen)', () => {
  const p = buildGenerationPrompt({ name: 'X', category: 'c', rating: 4.5, phone: '+34 600 000 000', address: 'a' }, webData, 'x');
  assert.ok(!p.includes('OMITE POR COMPLETO'));
  assert.ok(p.includes('wa.me/34600000000'));
  assert.ok(p.includes('8. TESTIMONIOS') && p.includes('BARRA DE CONFIANZA'));
  assert.ok(p.includes('✦ Activar mi web · $497'));
});
