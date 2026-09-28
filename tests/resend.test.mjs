// Resend real (SDK) con fetch simulado: un envío rechazado por la API debe lanzar error, no contarse como enviado.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.RESEND_API_KEY = 're_fake';
process.env.RESEND_FROM_EMAIL = 'hola@dominio.com';

const { sendOutreachEmail } = await import('../src/services/resend.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubResend(status, body) {
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      sent.push(JSON.parse(opts.body));
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, opts);
  };
  return sent;
}

const business = { name: 'Bar Pepe' };
const site = { preview_url: 'https://x.vercel.app', contact_email: 'pepe@bar.com' };

test('envío rechazado por Resend (p. ej. dominio sin verificar) → lanza error', async () => {
  stubResend(403, { statusCode: 403, name: 'validation_error', message: 'The domain is not verified' });
  await assert.rejects(() => sendOutreachEmail(business, site, 0, 'es'), /Resend: The domain is not verified/);
});

test('envío correcto: asunto en español, destinatario y HTML con enlace y precio', async () => {
  const sent = stubResend(200, { id: 'abc' });
  await sendOutreachEmail(business, site, 0, 'es');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'pepe@bar.com');
  assert.equal(sent[0].from, 'hola@dominio.com');
  assert.equal(sent[0].subject, 'Bar Pepe, te hemos creado una web — mírala');
  assert.ok(sent[0].html.includes('https://x.vercel.app') && sent[0].html.includes('$497'));
});

test('con CALENDAR_URL el email lleva el botón de la llamada (sin WhatsApp); sin ella, no hay botón', async () => {
  const prev = process.env.CALENDAR_URL;
  try {
    process.env.CALENDAR_URL = 'https://cal.example.com/jose/15min';
    let sent = stubResend(200, { id: 'abc' });
    await sendOutreachEmail(business, site, 0, 'es');
    assert.ok(sent[0].html.includes('href="https://cal.example.com/jose/15min"') && sent[0].html.includes('Agenda una llamada de 15 minutos'));
    sent = stubResend(200, { id: 'abc' });
    await sendOutreachEmail(business, site, 0, 'en');
    assert.ok(sent[0].html.includes('Book a 15-minute call'));
    delete process.env.CALENDAR_URL;
    sent = stubResend(200, { id: 'abc' });
    await sendOutreachEmail(business, site, 0, 'es');
    assert.ok(!sent[0].html.includes('Agenda una llamada') && !/whatsapp|wa.me/i.test(sent[0].html));
  } finally { if (prev === undefined) delete process.env.CALENDAR_URL; else process.env.CALENDAR_URL = prev; }
});

test('seguimiento en inglés', async () => {
  const sent = stubResend(200, { id: 'abc' });
  await sendOutreachEmail(business, site, 1, 'en');
  assert.equal(sent[0].subject, 'Hey, the website we built for Bar Pepe is still waiting');
});

test('sin contact_email usa business.email', async () => {
  const sent = stubResend(200, { id: 'abc' });
  await sendOutreachEmail({ name: 'X', email: 'x@y.com' }, { preview_url: 'https://x' }, 0, 'es');
  assert.equal(sent[0].to, 'x@y.com');
});
