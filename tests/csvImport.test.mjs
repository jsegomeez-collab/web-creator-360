// Importación de CSV con mapeo de columnas: detección automática, limpieza de valores, validación y guardado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { LEAD_FIELDS, suggestMapping, mapRows, parseDate, previewCsv, importCsvLeads, CSV_SOURCE } from '../src/services/csvImport.js';
import { parseCsv } from '../src/lib/csv.js';
import { clearDomainCache } from '../src/services/emailVerify.js';

const OWNER = 'owner-1';
const mx = [{ exchange: 'mx.example.com', priority: 10 }];
const resolver = {
  resolveMx: async (d) => { if (d === 'gmail.com') return mx; throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); },
  resolve4: async () => { throw Object.assign(new Error('x'), { code: 'ENODATA' }); },
  resolve6: async () => { throw Object.assign(new Error('x'), { code: 'ENODATA' }); },
};
const verifyOptions = { resolver, provider: async () => null };

// El CSV exacto que escribe el script de Python
const PYTHON_CSV = `prioridad,fecha_registro,empresa,email,sector,actividad_naics,señal_latina,declara_minoria,ciudad,zip,direccion,id_ct,motivo_descarte
A,2026-09-14,Enzo towing&Recovery LLC,enzoramos122320@gmail.com,auto,All Other Automotive Repair and Maintenance (811198),email: ramos,,New Britain,06053,100 Silver Street,3515900,
A,2026-09-18,EL RASPA ELECTROMECANICA LLC,mf5210982@gmail.com,auto,Specialized Automotive Repair (811114),nombre: 'el',SI,New Milford,06776,22 BRIDGE ST,3518914,
DESCARTAR,2026-09-10,Remi Richards Builds LLC,rr@gmail.com,construccion,Residential Building Construction (236115),nombre: 'mi',,Hartford,06103,1 Main St,3510001,"""mi"" es parte de ""Remi"""
B,2026-09-11,Acme Trading LLC,contacto@dominio-que-no-existe-xyz.com,otro,Tire Dealers (441340),email: garcia,,Stamford,06901,5 Elm St,3510002,
`;

test('detecta las columnas del CSV de Python sin tocar nada (todas asignadas a su campo)', () => {
  const { headers } = parseCsv(PYTHON_CSV);
  assert.deepEqual(suggestMapping(headers), {
    name: 'empresa', email: 'email', city: 'ciudad', zip: 'zip', address: 'direccion', registered_at: 'fecha_registro', naics_code: 'actividad_naics',
    sector: 'sector', priority: 'prioridad', external_id: 'id_ct', latino_signal: 'señal_latina', minority_owned: 'declara_minoria',
  });
});

test('detecta cabeceras en inglés, con mayúsculas, acentos y guiones, sin repetir columnas', () => {
  const m = suggestMapping(['Business Name', 'E-mail', 'CITY', 'ZipCode', 'Categoría', 'Fecha', 'Otra cosa']);
  assert.equal(m.email, 'E-mail');
  assert.equal(m.city, 'CITY');
  assert.equal(m.zip, 'ZipCode');
  assert.equal(m.sector, 'Categoría');
  assert.equal(m.registered_at, 'Fecha');
  assert.equal(m.name, 'Business Name');
  const dup = suggestMapping(['id', 'id_ct']);
  assert.equal(dup.external_id, 'id_ct');            // el alias más específico manda y "id" no se usa dos veces
});

test('cabeceras desconocidas → sin asignar (null), sin adivinar', () => {
  const m = suggestMapping(['columna_a', 'columna_b']);
  assert.ok(Object.values(m).every(v => v === null));
  assert.equal(LEAD_FIELDS.filter(f => f.required).length, 2);
});

// ─── limpieza de valores ─────────────────────────────────────────────────────
test('parseDate: ISO, ISO con hora, EE. UU. (M/D/A), europeo cuando es inequívoco, y fechas imposibles → null', () => {
  assert.equal(parseDate('2026-09-14'), '2026-09-14');
  assert.equal(parseDate('2026-09-14T00:00:00.000'), '2026-09-14');
  assert.equal(parseDate('09/14/2026'), '2026-09-14');
  assert.equal(parseDate('14/09/2026'), '2026-09-14');
  assert.equal(parseDate('9-4-2026'), '2026-09-04');
  for (const bad of ['', 'ayer', '2026-13-40', '02/30/2026', null, undefined]) assert.equal(parseDate(bad), null, String(bad));
});

const FULL = { name: 'empresa', email: 'email', city: 'ciudad', zip: 'zip', address: 'direccion', registered_at: 'fecha_registro', naics_code: 'actividad_naics', sector: 'sector', priority: 'prioridad', external_id: 'id_ct', latino_signal: 'señal_latina', minority_owned: 'declara_minoria' };

test('mapRows con el CSV de Python: campos limpios, DESCARTAR fuera, señal fuerte solo por el nombre', () => {
  const { rows } = parseCsv(PYTHON_CSV);
  const { leads, invalid } = mapRows(rows, FULL);
  assert.equal(leads.length, 3);
  assert.deepEqual(invalid, [{ line: 4, name: 'Remi Richards Builds LLC', reason: 'descartada (prioridad DESCARTAR)' }]);
  assert.deepEqual(leads[0], {
    external_id: '3515900', name: 'Enzo towing&Recovery LLC', email: 'enzoramos122320@gmail.com', city: 'New Britain', zip: '06053', address: '100 Silver Street',
    registered_at: '2026-09-14', naics_code: 'All Other Automotive Repair and Maintenance (811198)', sector: 'auto', priority: 'A',
    latino_signal: true, latino_strong: false, minority_owned: false, notes: 'señal latina: email: ramos',
  });
  assert.equal(leads[1].city, 'New Milford');
  assert.equal(leads[1].latino_strong, true);        // "El Raspa": palabra en español en el nombre
  assert.equal(leads[1].minority_owned, true);       // "SI"
  assert.equal(leads[2].priority, 'B');              // sector "otro"
});

test('sin mapear el sector se deduce del NAICS; sin prioridad se calcula; sin id se usa el email', () => {
  const rows = [{ e: 'Limpieza Sol LLC', m: 'sol@gmail.com', n: 'Janitorial Services (561720)' }];
  const { leads } = mapRows(rows, { name: 'e', email: 'm', naics_code: 'n' });
  assert.deepEqual([leads[0].sector, leads[0].priority, leads[0].external_id, leads[0].latino_strong], ['limpieza', 'A', 'csv:sol@gmail.com', true]);
  const other = mapRows([{ e: 'Acme Corp', m: 'a@gmail.com', n: 'Widgets (999999)' }], { name: 'e', email: 'm', naics_code: 'n' }).leads[0];
  assert.deepEqual([other.sector, other.priority], ['otro', 'B']);
});

test('un sector escrito con acentos o mayúsculas se reconoce; uno desconocido cae al NAICS o a "otro"', () => {
  const m = { name: 'e', email: 'm', sector: 's', naics_code: 'n' };
  const map = (s, n = '') => mapRows([{ e: 'X LLC', m: 'x@gmail.com', s, n }], m).leads[0].sector;
  assert.equal(map('Construcción'), 'construccion');
  assert.equal(map('LIMPIEZA'), 'limpieza');
  assert.equal(map('algo raro', 'Plumbing (238220)'), 'construccion');
  assert.equal(map('algo raro'), 'otro');
});

test('señal latina y minoría: "no", "0", "false" y vacío son falso; la prioridad A/B mapeada manda', () => {
  const m = { name: 'e', email: 'm', latino_signal: 'l', minority_owned: 'x', priority: 'p' };
  const row = (l, x, p = '') => mapRows([{ e: 'Acme LLC', m: 'a@gmail.com', l, x, p }], m).leads[0];
  assert.equal(row('no', 'NO').latino_signal, false);
  assert.equal(row('0', 'false').minority_owned, false);
  assert.equal(row('', '').notes, null);
  assert.equal(row('sí', 'Sí').latino_signal, true);
  assert.equal(row('nombre: la', '').notes, 'señal latina: nombre: la');
  assert.equal(row('', '', 'b').priority, 'B');                     // minúscula también vale
  assert.equal(row('', '', 'A').priority, 'A');
});

test('filas inválidas: sin nombre, sin email o con email mal formado, con su número de línea', () => {
  const rows = [
    { e: '', m: 'a@gmail.com' }, { e: 'Sin email', m: '' }, { e: 'Mal email', m: 'no-es-email' }, { e: 'Bien LLC', m: 'BIEN@Gmail.com' },
  ];
  const { leads, invalid } = mapRows(rows, { name: 'e', email: 'm' });
  assert.deepEqual(invalid.map(i => [i.line, i.reason]), [[2, 'sin nombre de empresa'], [3, 'email vacío o inválido'], [4, 'email vacío o inválido']]);
  assert.deepEqual(leads.map(l => l.email), ['bien@gmail.com']);        // en minúsculas
});

test('ciudad TODO en mayúsculas → título; en minúsculas o mixta se respeta; zip a 5 dígitos', () => {
  const m = { name: 'e', email: 'm', city: 'c', zip: 'z' };
  const lead = (c, z = '') => mapRows([{ e: 'X LLC', m: 'x@gmail.com', c, z }], m).leads[0];
  assert.equal(lead('NEW BRITAIN').city, 'New Britain');
  assert.equal(lead('new haven').city, 'new haven');
  assert.equal(lead('06053-1234', '06053-1234').zip, '06053');
});

// ─── previsualización ────────────────────────────────────────────────────────
test('previewCsv: cabeceras, primeras filas, total, sugerencia y definición de los campos', () => {
  const p = previewCsv(PYTHON_CSV);
  assert.equal(p.totalRows, 4);
  assert.equal(p.sample.length, 4);
  assert.equal(p.headers.length, 13);
  assert.equal(p.suggestedMapping.name, 'empresa');
  assert.deepEqual(p.fields.filter(f => f.required).map(f => f.key), ['name', 'email']);
  assert.equal(previewCsv('a,b\n1,2\n3,4\n5,6\n7,8\n9,10\n11,12').sample.length, 5);
});

test('previewCsv: archivo vacío o solo cabecera → error claro', () => {
  assert.throws(() => previewCsv(''), /vacío/);
  assert.throws(() => previewCsv('a,b\n'), /solo tiene la fila de cabecera/);
});

// ─── importación ─────────────────────────────────────────────────────────────
const fresh = () => { clearDomainCache(); return createMemoryDb({ new_business_leads: [], email_suppressions: [] }); };

test('vista previa (dryRun): cuenta lo que entraría y NO escribe nada', async () => {
  const db = fresh();
  const r = await importCsvLeads({ db, ownerId: OWNER, csv: PYTHON_CSV, mapping: FULL, dryRun: true, verifyOptions });
  assert.equal(r.dryRun, true);
  assert.equal(r.totalRows, 4);
  assert.equal(r.invalidCount, 1);
  assert.equal(r.valid, 2);                          // Enzo y El Raspa; Remi descartada; Acme con dominio inexistente
  assert.equal(r.invalidEmailCount, 1);
  assert.deepEqual(r.invalidReasons, { no_mx: 1 });
  assert.equal(r.inserted, 0);
  assert.equal(db.rows('new_business_leads').length, 0);
  assert.equal(r.summary.total, 2);
});

test('importación real: guarda con source csv_import, user_id, token y status new / invalid_email', async () => {
  const db = fresh();
  const r = await importCsvLeads({ db, ownerId: OWNER, csv: PYTHON_CSV, mapping: FULL, verifyOptions });
  assert.equal(r.inserted, 3);
  const rows = db.rows('new_business_leads');
  assert.deepEqual(rows.map(l => [l.external_id, l.status]).sort(), [['3510002', 'invalid_email'], ['3515900', 'new'], ['3518914', 'new']]);
  assert.ok(rows.every(l => l.user_id === OWNER && l.source === CSV_SOURCE && /^[A-Za-z0-9_-]{24}$/.test(l.link_token)));
  assert.equal(new Set(rows.map(l => l.link_token)).size, 3);
});

test('re-importar el mismo archivo no duplica nada; los emails suprimidos no entran', async () => {
  const db = fresh();
  await importCsvLeads({ db, ownerId: OWNER, csv: PYTHON_CSV, mapping: FULL, verifyOptions });
  const again = await importCsvLeads({ db, ownerId: OWNER, csv: PYTHON_CSV, mapping: FULL, verifyOptions });
  assert.equal(again.inserted, 0);
  assert.equal(again.skipped.existing, 3);
  assert.equal(db.rows('new_business_leads').length, 3);

  const db2 = fresh();
  db2.tables.email_suppressions = [{ user_id: OWNER, email: 'mf5210982@gmail.com', reason: 'unsubscribed' }];
  const r = await importCsvLeads({ db: db2, ownerId: OWNER, csv: PYTHON_CSV, mapping: FULL, verifyOptions });
  assert.equal(r.skipped.suppressed, 1);
  assert.ok(!db2.rows('new_business_leads').some(l => l.email === 'mf5210982@gmail.com'));
});

test('un mismo email repetido en el archivo entra una sola vez', async () => {
  const csv = 'empresa,email\nUno LLC,dup@gmail.com\nDos LLC,dup@gmail.com\nTres LLC,otro@gmail.com';
  const db = fresh();
  const r = await importCsvLeads({ db, ownerId: OWNER, csv, mapping: { name: 'empresa', email: 'email' }, verifyOptions });
  assert.equal(r.skipped.batchDuplicate, 1);
  assert.deepEqual(db.rows('new_business_leads').map(l => l.name).sort(), ['Tres LLC', 'Uno LLC']);
});

test('mapeo alternativo: columnas con nombres distintos y separador ";"', async () => {
  const csv = 'Razón;Correo;Población\nPanadería Luna;luna@gmail.com;HARTFORD\n';
  const db = fresh();
  const r = await importCsvLeads({ db, ownerId: OWNER, csv, mapping: { name: 'Razón', email: 'Correo', city: 'Población' }, verifyOptions });
  assert.equal(r.inserted, 1);
  const l = db.rows('new_business_leads')[0];
  assert.deepEqual([l.name, l.email, l.city, l.latino_strong], ['Panadería Luna', 'luna@gmail.com', 'Hartford', true]);   // "panaderia" → nombre en español
});

test('errores del usuario: falta asignar nombre/email, columna inexistente, archivo vacío o enorme', async () => {
  const db = fresh();
  const run = (csv, mapping) => importCsvLeads({ db, ownerId: OWNER, csv, mapping, verifyOptions });
  await assert.rejects(() => run('a,b\n1,2', { name: 'a' }), /Falta asignar una columna a: Email/);
  await assert.rejects(() => run('a,b\n1,2', {}), /Nombre de la empresa, Email/);
  await assert.rejects(() => run('a,b\n1,2', { name: 'a', email: 'zzz' }), /La columna "zzz".*no existe/);
  await assert.rejects(() => run('a,b\n', { name: 'a', email: 'b' }), /no tiene filas/);
  const big = 'a,b\n' + Array.from({ length: 20001 }, (_, i) => `n${i},e${i}@gmail.com`).join('\n');
  await assert.rejects(() => run(big, { name: 'a', email: 'b' }), /máximo por importación/);
  assert.equal(db.rows('new_business_leads').length, 0);
});

test('los errores de fila se devuelven limitados (50) pero contados todos', async () => {
  const csv = 'empresa,email\n' + Array.from({ length: 80 }, (_, i) => `Neg ${i},malo${i}`).join('\n');
  const r = await importCsvLeads({ db: fresh(), ownerId: OWNER, csv, mapping: { name: 'empresa', email: 'email' }, dryRun: true, verifyOptions });
  assert.equal(r.invalidCount, 80);
  assert.equal(r.invalid.length, 50);
  assert.equal(r.valid, 0);
});
