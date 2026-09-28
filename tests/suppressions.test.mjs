// Lista de supresiones: nunca escribir a estos emails. Por usuario, en minúsculas, y fallando "cerrado" en el flujo en frío.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { normEmail, getSuppressed, suppressionReason, suppress, statusForReason } from '../src/services/suppressions.js';

const A = 'user-a', B = 'user-b';

test('normEmail: minúsculas y sin espacios', () => {
  assert.equal(normEmail('  Juan@Gmail.COM '), 'juan@gmail.com');
  assert.equal(normEmail(null), '');
});

test('suppress guarda el email en minúsculas, y repetirlo no duplica (mantiene una fila)', async () => {
  const db = createMemoryDb();
  await suppress(db, A, 'Juan@Gmail.com', 'unsubscribed');
  await suppress(db, A, 'juan@gmail.com', 'bounced');
  assert.equal(db.rows('email_suppressions').length, 1);
  assert.deepEqual(db.rows('email_suppressions')[0], { id: db.rows('email_suppressions')[0].id, user_id: A, email: 'juan@gmail.com', reason: 'bounced' });
});

test('suppressionReason / getSuppressed: encuentran por email sin importar mayúsculas', async () => {
  const db = createMemoryDb({ email_suppressions: [{ user_id: A, email: 'juan@gmail.com', reason: 'unsubscribed' }] });
  assert.equal(await suppressionReason(db, A, 'JUAN@gmail.com'), 'unsubscribed');
  assert.equal(await suppressionReason(db, A, 'otro@gmail.com'), null);
  const map = await getSuppressed(db, A, ['juan@gmail.com', 'otro@gmail.com', '', null]);
  assert.deepEqual([...map], [['juan@gmail.com', 'unsubscribed']]);
});

test('es por usuario: la baja de un usuario no bloquea a otro', async () => {
  const db = createMemoryDb({ email_suppressions: [{ user_id: A, email: 'juan@gmail.com', reason: 'unsubscribed' }] });
  assert.equal(await suppressionReason(db, B, 'juan@gmail.com'), null);
});

test('trocea las consultas largas (más de 150 emails)', async () => {
  const emails = Array.from({ length: 400 }, (_, i) => `e${i}@x.com`);
  const db = createMemoryDb({ email_suppressions: [{ user_id: A, email: 'e399@x.com', reason: 'bounced' }] });
  const map = await getSuppressed(db, A, emails);
  assert.equal(map.get('e399@x.com'), 'bounced');
  assert.equal(db.log.filter(l => l.table === 'email_suppressions').length, 3);
});

test('flujo en frío: si la consulta falla, LANZA (no se envía si no se sabe)', async () => {
  const db = createMemoryDb();
  db.failNext('email_suppressions', 'select', 'tabla inexistente');
  await assert.rejects(() => getSuppressed(db, A, ['a@b.com']), /consultar supresiones: tabla inexistente/);
});

test('flujo antiguo (failOpen): si falla, avisa y sigue sin filtrar', async () => {
  const db = createMemoryDb();
  db.failNext('email_suppressions', 'select', 'tabla inexistente');
  const warns = [];
  const orig = console.warn; console.warn = (m) => warns.push(m);
  try { assert.equal(await suppressionReason(db, A, 'a@b.com', { failOpen: true }), null); } finally { console.warn = orig; }
  assert.equal(warns.length, 1);
});

test('suppress propaga los errores de la base de datos', async () => {
  const db = createMemoryDb();
  db.failNext('email_suppressions', 'upsert', 'boom');
  await assert.rejects(() => suppress(db, A, 'a@b.com', 'x'), /guardar supresión: boom/);
});

test('statusForReason', () => {
  assert.equal(statusForReason('bounced'), 'bounced');
  assert.equal(statusForReason('invalid_email'), 'invalid_email');
  assert.equal(statusForReason('unsubscribed'), 'unsubscribed');
  assert.equal(statusForReason('complaint'), 'unsubscribed');
});
