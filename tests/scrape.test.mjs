// scrapeBusinessProfile real contra un servidor local (webs de prueba + "API de Anthropic" falsa). No sale nada a internet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

let server, base, scrapeBusinessProfile;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/messages')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: JSON.stringify({ description: 'Negocio de prueba', services: ['a'], value_proposition: 'v', hours: null, language: 'es', email: null, social_networks: [], tone: 'cercano' }) }],
      }));
    }
    if (req.url === '/ok') {
      res.setHeader('content-type', 'text/html');
      return res.end('<html><a href="tel:+34 672 577 986">llamar</a><a href="mailto:hola@negocio.es">mail</a></html>');
    }
    res.statusCode = 404; res.end('nope');
  });
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'fake-key';
  process.env.ANTHROPIC_BASE_URL = base;
  ({ scrapeBusinessProfile } = await import('../src/services/businessProfile.js'));
});
after(() => { server.closeAllConnections?.(); server.close(); });

const biz = (website) => ({ name: 'Test', address: 'X', phone: null, website, category: 'c', rating: 4 });

test('web que responde 404: el scraping no falla y devuelve el perfil sin email', async () => {
  const p = await scrapeBusinessProfile(biz(`${base}/404`));
  assert.equal(p.email, null);
  assert.ok(Array.isArray(p.images));
});

test('negocio sin website (null)', async () => {
  const p = await scrapeBusinessProfile(biz(null));
  assert.equal(p.description, 'Negocio de prueba');
});

test('web con tel: y mailto: → usa el email de la web y NO extrae teléfonos', async () => {
  const p = await scrapeBusinessProfile(biz(`${base}/ok`));
  assert.equal(p.email, 'hola@negocio.es');
  assert.equal('phone' in p, false);
});
