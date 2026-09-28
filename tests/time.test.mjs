// Horario de envío (Connecticut) y conversión a Madrid: con horario de verano y sin depender de la hora del servidor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSendWindow, nextSendWindowStart, slotInMadrid, zonedParts, zonedTimeToUtc, formatClock } from '../src/lib/time.js';
import { isDryRun, dryRunLog, realDemoInDryRun } from '../src/lib/dryRun.js';

const at = (iso) => new Date(iso);

test('isSendWindow: lunes-viernes 9:00–17:00 hora de Connecticut (verano, UTC-4)', () => {
  assert.equal(isSendWindow(at('2026-09-28T13:00:00Z')), true);    // lunes 09:00 NY
  assert.equal(isSendWindow(at('2026-09-28T12:59:00Z')), false);   // lunes 08:59 NY
  assert.equal(isSendWindow(at('2026-09-28T20:59:00Z')), true);    // lunes 16:59 NY
  assert.equal(isSendWindow(at('2026-09-28T21:00:00Z')), false);   // lunes 17:00 NY (fin exclusivo)
  assert.equal(isSendWindow(at('2026-10-02T20:30:00Z')), true);    // viernes 16:30 NY
});

test('isSendWindow: fines de semana cerrados', () => {
  assert.equal(isSendWindow(at('2026-10-03T15:00:00Z')), false);   // sábado 11:00 NY
  assert.equal(isSendWindow(at('2026-10-04T15:00:00Z')), false);   // domingo 11:00 NY
});

test('isSendWindow: usa la hora de Connecticut, no la UTC del servidor (Render)', () => {
  // 09:30 UTC parece "horario de oficina" en UTC, pero en Connecticut son las 05:30
  assert.equal(isSendWindow(at('2026-09-28T09:30:00Z')), false);
  // 22:00 UTC son las 18:00 en Connecticut: cerrado
  assert.equal(isSendWindow(at('2026-09-28T22:00:00Z')), false);
});

test('isSendWindow: tras el cambio de hora de EE. UU. (1-nov-2026, UTC-5) sigue siendo 9:00 local', () => {
  assert.equal(isSendWindow(at('2026-11-02T14:00:00Z')), true);    // lunes 09:00 EST
  assert.equal(isSendWindow(at('2026-11-02T13:59:00Z')), false);   // lunes 08:59 EST
});

test('nextSendWindowStart: dentro de horario devuelve el mismo instante', () => {
  const d = at('2026-09-28T15:00:00Z');
  assert.equal(nextSendWindowStart(d).getTime(), d.getTime());
});

test('nextSendWindowStart: antes de abrir → hoy 9:00; tras cerrar → mañana 9:00; viernes noche → lunes 9:00', () => {
  assert.equal(nextSendWindowStart(at('2026-09-28T12:00:00Z')).toISOString(), '2026-09-28T13:00:00.000Z');   // lunes 08:00 NY → 09:00 NY
  assert.equal(nextSendWindowStart(at('2026-09-28T22:00:00Z')).toISOString(), '2026-09-29T13:00:00.000Z');   // lunes 18:00 → martes 09:00
  assert.equal(nextSendWindowStart(at('2026-10-02T22:00:00Z')).toISOString(), '2026-10-05T13:00:00.000Z');   // viernes 18:00 → lunes 09:00
  assert.equal(nextSendWindowStart(at('2026-10-03T15:00:00Z')).toISOString(), '2026-10-05T13:00:00.000Z');   // sábado → lunes
});

test('nextSendWindowStart: cruzando el cambio de hora la apertura sigue siendo 9:00 local', () => {
  // viernes 30-oct-2026 18:00 NY (EDT) → lunes 2-nov 09:00 NY (EST = 14:00Z)
  assert.equal(nextSendWindowStart(at('2026-10-30T22:00:00Z')).toISOString(), '2026-11-02T14:00:00.000Z');
});

test('zonedParts y zonedTimeToUtc son inversos (también en el día del cambio de hora)', () => {
  const p = zonedParts(at('2026-09-28T13:00:00Z'), 'America/New_York');
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.weekday], [2026, 9, 28, 9, 1]);
  assert.equal(zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 9 }, 'America/New_York').toISOString(), '2026-09-28T13:00:00.000Z');
  assert.equal(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 12 }, 'America/New_York').toISOString(), '2026-11-01T17:00:00.000Z'); // ya en EST
  assert.equal(formatClock(at('2026-09-28T13:00:00Z'), 'Europe/Madrid'), '15:00');
});

test('slotInMadrid: Madrid va 6 h por delante en septiembre', () => {
  const d = at('2026-09-28T16:00:00Z');
  assert.equal(slotInMadrid('manana', d), '15:00–18:00');
  assert.equal(slotInMadrid('tarde', d), '18:00–23:00');
  assert.equal(slotInMadrid('noche', d), '23:00–02:00');
});

test('slotInMadrid: entre el 25-oct y el 1-nov (Europa ya en invierno, EE. UU. aún no) la diferencia es 5 h', () => {
  assert.equal(slotInMadrid('manana', at('2026-10-27T16:00:00Z')), '14:00–17:00');
});

test('slotInMadrid: con ambos en horario de invierno vuelve a 6 h; slot desconocido → null', () => {
  assert.equal(slotInMadrid('manana', at('2026-11-02T16:00:00Z')), '15:00–18:00');
  assert.equal(slotInMadrid('madrugada'), null);
});

test('slotInMadrid: usa el día de Connecticut aunque en UTC ya sea el día siguiente', () => {
  // 2026-11-01T02:00Z sigue siendo 31-oct 22:00 EDT en Connecticut
  assert.equal(slotInMadrid('manana', at('2026-11-01T02:00:00Z')), '14:00–17:00');
});

test('dryRun: OUTREACH_DRY_RUN y DRY_RUN_REAL_DEMO se leen del entorno', () => {
  const prev = { a: process.env.OUTREACH_DRY_RUN, b: process.env.DRY_RUN_REAL_DEMO };
  delete process.env.OUTREACH_DRY_RUN; delete process.env.DRY_RUN_REAL_DEMO;
  assert.equal(isDryRun(), false);
  assert.equal(realDemoInDryRun(), false);
  process.env.OUTREACH_DRY_RUN = 'TRUE';
  assert.equal(isDryRun(), true);
  process.env.OUTREACH_DRY_RUN = 'false';
  assert.equal(isDryRun(), false);
  process.env.DRY_RUN_REAL_DEMO = 'true';
  assert.equal(realDemoInDryRun(), true);
  if (prev.a === undefined) delete process.env.OUTREACH_DRY_RUN; else process.env.OUTREACH_DRY_RUN = prev.a;
  if (prev.b === undefined) delete process.env.DRY_RUN_REAL_DEMO; else process.env.DRY_RUN_REAL_DEMO = prev.b;
});

test('dryRunLog: escribe en el log una línea JSON y recorta textos largos', () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { dryRunLog('email', { to: 'a@b.com', body: 'x'.repeat(500) }); } finally { console.log = orig; }
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('[dry-run] email {'));
  assert.ok(lines[0].includes('"to":"a@b.com"') && lines[0].includes('(+200 chars)'));
});
