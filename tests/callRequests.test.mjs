// Solicitud de llamada: teléfonos de EE. UU. en cualquier formato, validación del formulario y guardado sin duplicar avisos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { normalizePhone, parseRequest, saveRequest, PREFERRED_TIMES, CONSENT_TEXT, REQUESTABLE } from '../src/services/callRequests.js';

const OWNER = 'owner-1';
const NOW = new Date('2026-09-29T15:00:00.000Z');
const mk = (over = {}) => ({ id: 'L1', user_id: OWNER, status: 'emailed', ...over });
const values = (over = {}) => ({ phone: '+18605550100', name: 'Ana', preferred_time: PREFERRED_TIMES[1], ...over });

test('normalizePhone: formatos de EE. UU. → E.164', () => {
  for (const raw of ['8605550100', '860 555 0100', '(860) 555-0100', '860.555.0100', '1 860 555 0100', '+1 (860) 555-0100', ' 1-860-555-0100 ', '+18605550100']) {
    assert.equal(normalizePhone(raw), '+18605550100', raw);
  }
});

test('normalizePhone: otros países solo con "+" y prefijo; lo demás se rechaza', () => {
  assert.equal(normalizePhone('+34 612 345 678'), '+34612345678');
  assert.equal(normalizePhone('+52 55 1234 5678'), '+525512345678');
  for (const bad of ['', null, undefined, '123', '860 555 010', '0000000000', '1111111111', '860 155 0100', '34612345678', '+1 860 555', '+123', '++', 'llámame', '860555010012345678']) {
    assert.equal(normalizePhone(bad), null, String(bad));
  }
});

test('parseRequest: válido, con nombre limpio y hora elegida', () => {
  const { errors, values: v } = parseRequest({ phone: '(860) 555-0100', name: '  Ana   María  ', when: 'Hoy, más tarde', consent: 'on' });
  assert.deepEqual(errors, {});
  assert.deepEqual(v, { phone: '+18605550100', name: 'Ana María', preferred_time: 'Hoy, más tarde' });
});

test('parseRequest: sin nombre → null; nombre larguísimo se recorta; hora inventada → la primera opción', () => {
  assert.equal(parseRequest({ phone: '8605550100', consent: 'on', name: '   ' }).values.name, null);
  assert.equal(parseRequest({ phone: '8605550100', consent: 'on', name: 'x'.repeat(500) }).values.name.length, 80);
  assert.equal(parseRequest({ phone: '8605550100', consent: 'on', when: 'cuando quiera' }).values.preferred_time, PREFERRED_TIMES[0]);
  assert.equal(parseRequest({ phone: '8605550100', consent: 'on' }).values.preferred_time, PREFERRED_TIMES[0]);
});

test('parseRequest: sin consentimiento o sin teléfono válido hay error por campo; el consentimiento solo vale con "on"', () => {
  assert.deepEqual(Object.keys(parseRequest({ phone: '8605550100' }).errors), ['consent']);
  assert.deepEqual(Object.keys(parseRequest({ phone: '8605550100', consent: 'yes' }).errors), ['consent']);
  assert.deepEqual(Object.keys(parseRequest({ phone: 'abc', consent: 'on' }).errors), ['phone']);
  assert.deepEqual(Object.keys(parseRequest({}).errors).sort(), ['consent', 'phone']);
  assert.deepEqual(Object.keys(parseRequest(undefined).errors).sort(), ['consent', 'phone']);
});

test('saveRequest: primera solicitud → "new" y guarda todo, con el consentimiento como prueba', async () => {
  for (const status of REQUESTABLE) {
    const db = createMemoryDb({ new_business_leads: [mk({ status })] });
    assert.equal(await saveRequest({ db, ownerId: OWNER, lead: mk({ status }), values: values(), ip: '203.0.113.7', now: NOW }), 'new', status);
    assert.deepEqual(db.rows('new_business_leads')[0], {
      id: 'L1', user_id: OWNER, status: 'requested', requested_at: NOW.toISOString(), phone: '+18605550100', contact_name: 'Ana', preferred_time: 'Hoy, más tarde',
      consent_at: NOW.toISOString(), consent_text: CONSENT_TEXT, consent_ip: '203.0.113.7', updated_at: NOW.toISOString(),
    });
  }
});

test('saveRequest: segunda solicitud → "updated": cambia los datos, no la fecha de la solicitud', async () => {
  const db = createMemoryDb({ new_business_leads: [mk()] });
  await saveRequest({ db, ownerId: OWNER, lead: mk(), values: values(), now: NOW });
  const later = new Date(NOW.getTime() + 60_000);
  assert.equal(await saveRequest({ db, ownerId: OWNER, lead: mk({ status: 'requested' }), values: values({ phone: '+12035550111' }), now: later }), 'updated');
  const l = db.rows('new_business_leads')[0];
  assert.deepEqual([l.status, l.phone, l.requested_at, l.consent_at], ['requested', '+12035550111', NOW.toISOString(), later.toISOString()]);
});

test('saveRequest: leads que ya pasaron esa fase o están fuera → "ignored" y no se toca nada', async () => {
  for (const status of ['called', 'won', 'lost', 'unsubscribed', 'bounced', 'invalid_email', 'rejected']) {
    const db = createMemoryDb({ new_business_leads: [mk({ status })] });
    assert.equal(await saveRequest({ db, ownerId: OWNER, lead: mk({ status }), values: values(), now: NOW }), 'ignored', status);
    assert.deepEqual(db.rows('new_business_leads')[0], mk({ status }));
  }
});

test('saveRequest: no toca leads de otro usuario', async () => {
  const db = createMemoryDb({ new_business_leads: [mk({ user_id: 'otro' })] });
  assert.equal(await saveRequest({ db, ownerId: OWNER, lead: mk(), values: values(), now: NOW }), 'ignored');
  assert.equal(db.rows('new_business_leads')[0].status, 'emailed');
});

test('saveRequest: dos a la vez → solo uno es "new"', async () => {
  const db = createMemoryDb({ new_business_leads: [mk()] });
  const results = await Promise.all([1, 2].map(() => saveRequest({ db, ownerId: OWNER, lead: mk(), values: values(), now: NOW })));
  assert.deepEqual(results.sort(), ['new', 'updated']);
});

test('saveRequest: si la base de datos falla, lanza el error (la página lo convierte en aviso)', async () => {
  const db = createMemoryDb({ new_business_leads: [mk()] });
  db.failNext('new_business_leads', 'update', 'disco lleno');
  await assert.rejects(() => saveRequest({ db, ownerId: OWNER, lead: mk(), values: values(), now: NOW }), /disco lleno/);
  assert.equal(db.rows('new_business_leads')[0].status, 'emailed');
});
