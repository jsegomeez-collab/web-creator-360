// Verificación de emails: sintaxis, DNS (MX / A), caché por dominio, fallos transitorios y hook de proveedor.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyEmail, verifyMany, clearDomainCache } from '../src/services/emailVerify.js';

beforeEach(() => clearDomainCache());

const dnsErr = (code) => Object.assign(new Error(code), { code });
// Resolver falso: cada método devuelve lo configurado por dominio, o lanza ENOTFOUND
function resolverFor(config) {
  const calls = { mx: [], a: [], aaaa: [] };
  return {
    calls,
    resolveMx: async (d) => { calls.mx.push(d); const r = config[d]?.mx; if (r instanceof Error) throw r; if (r) return r; throw dnsErr('ENOTFOUND'); },
    resolve4: async (d) => { calls.a.push(d); const r = config[d]?.a; if (r instanceof Error) throw r; if (r) return r; throw dnsErr('ENODATA'); },
    resolve6: async (d) => { calls.aaaa.push(d); const r = config[d]?.aaaa; if (r instanceof Error) throw r; if (r) return r; throw dnsErr('ENODATA'); },
  };
}
const mx = [{ exchange: 'mx.example.com', priority: 10 }];
const noProvider = async () => null;

test('sintaxis inválida se rechaza sin consultar DNS', async () => {
  const resolver = resolverFor({});
  for (const bad of ['', 'sin-arroba', 'a@b', 'a b@c.com', '@c.com', 'a@.com', 'x'.repeat(65) + '@c.com']) {
    assert.deepEqual(await verifyEmail(bad, { resolver, provider: noProvider }), { ok: false, reason: 'syntax' }, bad);
  }
  assert.equal(resolver.calls.mx.length, 0);
});

test('dominio con MX → ok', async () => {
  const resolver = resolverFor({ 'gmail.com': { mx } });
  assert.deepEqual(await verifyEmail('Juan@Gmail.com', { resolver, provider: noProvider }), { ok: true, reason: 'mx' });
});

test('sin MX pero con registro A/AAAA → ok (RFC 5321); sin nada → no_mx', async () => {
  const resolver = resolverFor({ 'solo-a.com': { a: ['1.2.3.4'] }, 'solo-aaaa.com': { aaaa: ['::1'] } });
  assert.deepEqual(await verifyEmail('x@solo-a.com', { resolver, provider: noProvider }), { ok: true, reason: 'a_record' });
  assert.deepEqual(await verifyEmail('x@solo-aaaa.com', { resolver, provider: noProvider }), { ok: true, reason: 'a_record' });
  assert.deepEqual(await verifyEmail('x@no-existe.com', { resolver, provider: noProvider }), { ok: false, reason: 'no_mx' });
});

test('null MX (RFC 7505: "este dominio no recibe correo") → no_mx', async () => {
  const resolver = resolverFor({ 'nomail.com': { mx: [{ exchange: '', priority: 0 }] }, 'nomail2.com': { mx: [{ exchange: '.', priority: 0 }] } });
  assert.equal((await verifyEmail('x@nomail.com', { resolver, provider: noProvider })).reason, 'no_mx');
  assert.equal((await verifyEmail('x@nomail2.com', { resolver, provider: noProvider })).reason, 'no_mx');
});

test('fallo transitorio de DNS (timeout, SERVFAIL) NO rechaza el lead y no se cachea', async () => {
  const resolver = resolverFor({ 'lento.com': { mx: dnsErr('ETIMEOUT') } });
  const v = await verifyEmail('x@lento.com', { resolver, provider: noProvider });
  assert.deepEqual([v.ok, v.reason], [true, 'dns_unverified']);
  await verifyEmail('y@lento.com', { resolver, provider: noProvider });
  assert.equal(resolver.calls.mx.length, 2);                 // se volvió a consultar
  const servfail = resolverFor({ 'roto.com': { mx: dnsErr('ESERVFAIL') } });
  assert.equal((await verifyEmail('x@roto.com', { resolver: servfail, provider: noProvider })).ok, true);
});

test('caché por dominio: 3 direcciones de gmail.com = una sola consulta', async () => {
  const resolver = resolverFor({ 'gmail.com': { mx } });
  const results = await verifyMany(['a@gmail.com', 'b@gmail.com', 'C@GMAIL.com', 'a@gmail.com'], { resolver, provider: noProvider });
  assert.equal(results.size, 3);                            // dedupe de direcciones repetidas
  assert.equal(resolver.calls.mx.length, 1);
  assert.ok([...results.values()].every(v => v.ok));
});

test('verifyMany: mezcla de resultados y respeta la concurrencia', async () => {
  const resolver = resolverFor({ 'bueno.com': { mx } });
  const r = await verifyMany(['a@bueno.com', 'b@malo.com', 'sin-arroba'], { resolver, provider: noProvider, concurrency: 2 });
  assert.equal(r.get('a@bueno.com').ok, true);
  assert.equal(r.get('b@malo.com').reason, 'no_mx');
  assert.equal(r.get('sin-arroba').reason, 'syntax');
});

test('hook de proveedor externo: se consulta solo si el DNS pasa, y puede rechazar', async () => {
  const resolver = resolverFor({ 'bueno.com': { mx } });
  const seen = [];
  const provider = async (email) => { seen.push(email); return email.startsWith('bounce') ? { ok: false, reason: 'mailbox_not_found' } : { ok: true }; };
  assert.deepEqual(await verifyEmail('ok@bueno.com', { resolver, provider }), { ok: true, reason: 'mx' });
  assert.deepEqual(await verifyEmail('bounce@bueno.com', { resolver, provider }), { ok: false, reason: 'provider:mailbox_not_found' });
  await verifyEmail('x@malo.com', { resolver, provider });
  assert.deepEqual(seen, ['ok@bueno.com', 'bounce@bueno.com']);      // malo.com no llegó al proveedor
});

test('sin EMAIL_VERIFIER_API_KEY el proveedor por defecto se omite; con clave pero sin implementar avisa una vez y no rechaza', async () => {
  const resolver = resolverFor({ 'bueno.com': { mx } });
  const prev = process.env.EMAIL_VERIFIER_API_KEY;
  delete process.env.EMAIL_VERIFIER_API_KEY;
  assert.equal((await verifyEmail('a@bueno.com', { resolver })).ok, true);
  process.env.EMAIL_VERIFIER_API_KEY = 'k';
  const warns = [];
  const orig = console.warn; console.warn = (m) => warns.push(m);
  try {
    clearDomainCache();
    assert.equal((await verifyEmail('a@bueno.com', { resolver })).ok, true);
    assert.equal((await verifyEmail('b@bueno.com', { resolver })).ok, true);
  } finally { console.warn = orig; if (prev === undefined) delete process.env.EMAIL_VERIFIER_API_KEY; else process.env.EMAIL_VERIFIER_API_KEY = prev; }
  assert.ok(warns.length <= 1);
});
