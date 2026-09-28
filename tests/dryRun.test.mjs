// Modo de pruebas OUTREACH_DRY_RUN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDryRun, dryRunLog } from '../src/lib/dryRun.js';

test('OUTREACH_DRY_RUN se lee del entorno (sin importar mayúsculas ni espacios)', () => {
  const prev = process.env.OUTREACH_DRY_RUN;
  try {
    delete process.env.OUTREACH_DRY_RUN;
    assert.equal(isDryRun(), false);
    process.env.OUTREACH_DRY_RUN = ' TRUE ';
    assert.equal(isDryRun(), true);
    process.env.OUTREACH_DRY_RUN = 'false';
    assert.equal(isDryRun(), false);
    process.env.OUTREACH_DRY_RUN = '1';
    assert.equal(isDryRun(), false);                      // solo "true" activa el modo de pruebas
  } finally { if (prev === undefined) delete process.env.OUTREACH_DRY_RUN; else process.env.OUTREACH_DRY_RUN = prev; }
});

test('dryRunLog: escribe una línea JSON en el log y recorta textos largos', () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { dryRunLog('instantly.push', { leads: 3, body: 'x'.repeat(500) }); } finally { console.log = orig; }
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('[dry-run] instantly.push {'));
  assert.ok(lines[0].includes('"leads":3') && lines[0].includes('(+200 chars)'));
});
