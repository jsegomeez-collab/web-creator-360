// Prompt de generación: sin WhatsApp; el botón "Activar mi web" abre el calendario de la llamada si CALENDAR_URL está definida.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildGenerationPrompt } from '../src/prompts/generation.js';

const webData = { description: 'd', services: ['a'], language: 'es', raw_data: { images: [] } };
const business = { name: 'X', category: 'c', rating: 4.5, phone: '+34 600 000 000', address: 'a' };

const prev = process.env.CALENDAR_URL;
afterEach(() => { if (prev === undefined) delete process.env.CALENDAR_URL; else process.env.CALENDAR_URL = prev; });

test('el prompt no menciona WhatsApp ni wa.me, con o sin teléfono', () => {
  for (const b of [business, { ...business, phone: null }]) {
    const p = buildGenerationPrompt(b, webData, 'x');
    assert.ok(!/whatsapp|wa\.me/i.test(p));
  }
});

test('con CALENDAR_URL: el botón "Activar mi web · $497" abre el calendario', () => {
  process.env.CALENDAR_URL = ' https://cal.example.com/jose/15min ';
  const p = buildGenerationPrompt(business, webData, 'x');
  assert.ok(p.includes('href="https://cal.example.com/jose/15min"'));
  assert.ok(p.includes('✦ Activar mi web · $497'));
});

test('sin CALENDAR_URL: el botón no se genera (no hay a dónde llevarlo)', () => {
  delete process.env.CALENDAR_URL;
  const p = buildGenerationPrompt(business, webData, 'x');
  assert.ok(!p.includes('Activar mi web'));
  assert.ok(p.includes('Selector de idioma EN/ES'));
});

test('el resto del prompt sigue igual (testimonios, barra de confianza, teléfono del negocio)', () => {
  const p = buildGenerationPrompt(business, webData, 'x');
  assert.ok(p.includes('8. TESTIMONIOS') && p.includes('BARRA DE CONFIANZA'));
  assert.ok(p.includes('Teléfono: +34 600 000 000'));
  assert.ok(buildGenerationPrompt({ ...business, phone: null }, webData, 'x').includes('Teléfono: No disponible'));
});
