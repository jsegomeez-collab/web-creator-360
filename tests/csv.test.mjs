// Lector de CSV: separadores, comillas, saltos de línea, BOM y cabeceras repetidas o vacías.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, detectDelimiter } from '../src/lib/csv.js';

test('coma, comillas, comillas escapadas, saltos de línea dentro de un campo, BOM y CRLF', () => {
  const { headers, rows, delimiter } = parseCsv('\uFEFFa,b,c\r\n1,"x, y",3\r\n"q ""z""","línea1\nlínea2",\r\n');
  assert.equal(delimiter, ',');
  assert.deepEqual(headers, ['a', 'b', 'c']);
  assert.deepEqual(rows, [{ a: '1', b: 'x, y', c: '3' }, { a: 'q "z"', b: 'línea1\nlínea2', c: '' }]);
});

test('detecta punto y coma (Excel en español) y tabuladores', () => {
  assert.equal(detectDelimiter('empresa;email;ciudad\nA;a@b.com;X'), ';');
  assert.equal(detectDelimiter('empresa\temail\tciudad\nA\ta@b.com\tX'), '\t');
  assert.equal(detectDelimiter('empresa,email\nA,a@b.com'), ',');
  assert.equal(detectDelimiter('sin separadores'), ',');
  assert.equal(detectDelimiter('"a;b",c;d\n1,2'), ',');            // el ; dentro de comillas no cuenta
  const { rows } = parseCsv('empresa;email\nAcme;a@b.com\n');
  assert.deepEqual(rows, [{ empresa: 'Acme', email: 'a@b.com' }]);
});

test('ignora líneas vacías y recorta espacios; sin salto final también funciona', () => {
  const { rows } = parseCsv('a,b\n\n  1 , 2 \n\n3,4');
  assert.deepEqual(rows, [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
});

test('cabeceras vacías o repetidas siguen siendo direccionables', () => {
  const { headers, rows } = parseCsv('email,,email,nombre\na@b.com,x,c@d.com,Ana');
  assert.deepEqual(headers, ['email', 'columna_2', 'email_2', 'nombre']);
  assert.deepEqual(rows[0], { email: 'a@b.com', columna_2: 'x', email_2: 'c@d.com', nombre: 'Ana' });
});

test('filas más cortas rellenan con vacío; vacío o solo cabecera no rompe', () => {
  assert.deepEqual(parseCsv('a,b,c\n1').rows, [{ a: '1', b: '', c: '' }]);
  assert.deepEqual(parseCsv(''), { headers: [], rows: [], delimiter: ',' });
  assert.deepEqual(parseCsv('   \n\n').headers, []);
  const only = parseCsv('a,b\n');
  assert.deepEqual([only.headers, only.rows], [['a', 'b'], []]);
  assert.deepEqual(parseCsv(null).headers, []);
});
