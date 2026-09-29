// El interruptor del autopilot (encendido/apagado y cuántos manda por ciclo): un valor por defecto sensato sin fila
// guardada, y guardar solo cambia lo que se le pide sin tocar lo demás.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { getAutopilotSettings, setAutopilotSettings } from '../src/services/autopilot.js';

const OWNER = 'owner-1';
const fresh = () => createMemoryDb({ campaign_autopilot: [] });

test('sin fila guardada: activado por defecto, 20 por ciclo (así no se para nada la primera vez)', async () => {
  const db = fresh();
  assert.deepEqual(await getAutopilotSettings(db, OWNER), { enabled: true, pushLimit: 20 });
});

test('guardar solo "enabled": no toca pushLimit (se queda en su valor, aunque sea el de por defecto)', async () => {
  const db = fresh();
  const r = await setAutopilotSettings(db, OWNER, { enabled: false });
  assert.deepEqual(r, { enabled: false, pushLimit: 20 });
  assert.deepEqual(await getAutopilotSettings(db, OWNER), { enabled: false, pushLimit: 20 });
});

test('guardar solo "pushLimit": no toca enabled', async () => {
  const db = fresh();
  await setAutopilotSettings(db, OWNER, { enabled: false });
  const r = await setAutopilotSettings(db, OWNER, { pushLimit: 50 });
  assert.deepEqual(r, { enabled: false, pushLimit: 50 });
  assert.deepEqual(await getAutopilotSettings(db, OWNER), { enabled: false, pushLimit: 50 });
});

test('guardar los dos a la vez', async () => {
  const db = fresh();
  const r = await setAutopilotSettings(db, OWNER, { enabled: true, pushLimit: 5 });
  assert.deepEqual(r, { enabled: true, pushLimit: 5 });
});

test('activar/desactivar varias veces seguidas deja el último valor', async () => {
  const db = fresh();
  await setAutopilotSettings(db, OWNER, { enabled: true });
  await setAutopilotSettings(db, OWNER, { enabled: false });
  const r = await setAutopilotSettings(db, OWNER, { enabled: true });
  assert.equal(r.enabled, true);
  assert.equal(db.rows('campaign_autopilot').length, 1);   // una sola fila, no una por cada guardado
});

test('nunca toca los ajustes de otro usuario', async () => {
  const db = fresh();
  await setAutopilotSettings(db, 'otro-owner', { enabled: false, pushLimit: 1 });
  assert.deepEqual(await getAutopilotSettings(db, OWNER), { enabled: true, pushLimit: 20 });
});

test('un fallo de la base de datos al leer o al guardar se propaga con un mensaje claro', async () => {
  const db1 = fresh();
  db1.failNext('campaign_autopilot', 'select', 'timeout');
  await assert.rejects(() => getAutopilotSettings(db1, OWNER), /timeout/);

  const db2 = fresh();
  db2.failNext('campaign_autopilot', 'upsert', 'disco lleno');
  await assert.rejects(() => setAutopilotSettings(db2, OWNER, { enabled: false }), /disco lleno/);
});
