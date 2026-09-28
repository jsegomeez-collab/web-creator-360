// Port del script de Python: cada regla del filtro, la paginación de la API y los reintentos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRegistrations, senalesLatinas, codigoNaics, sectorDe, titleCase, limpiar, fetchRegistrations,
  DOMINIOS_GESTORIA, RE_ESPANOL, RE_NO_OPERATIVA, API_URL,
} from '../src/services/ctRegistry.js';

// Fila mínima de la API con valores razonables; cada test cambia solo lo que prueba
const row = (o = {}) => ({
  name: 'Limpieza Rivera LLC', accountnumber: '1001', status: 'Active', date_registration: '2026-09-14T00:00:00.000',
  business_email_address: 'contacto@limpiezarivera.com', category_survey_email_address: '',
  naics_code: 'Janitorial Services (561720)', minority_owned_organization: false,
  billingstreet: '100 Silver Street', billingcity: 'NEW BRITAIN', billingpostalcode: '06053-1234', ...o,
});
const classify = (rows, opts) => classifyRegistrations(rows, opts);

// ─── helpers ─────────────────────────────────────────────────────────────────
test('limpiar / codigoNaics / sectorDe / titleCase', () => {
  assert.equal(limpiar('  Panadería ÑOÑO '), 'panaderia nono');
  assert.equal(codigoNaics('Janitorial Services (561720)'), '561720');
  assert.equal(codigoNaics(''), '');
  assert.equal(codigoNaics('sin código'), '');
  assert.equal(sectorDe('561720'), 'limpieza');
  assert.equal(sectorDe('238220'), 'construccion');          // prefijo 238
  assert.equal(sectorDe('722511'), 'comida');
  assert.equal(sectorDe('561730'), 'jardineria');
  assert.equal(sectorDe('999999'), '');
  assert.equal(sectorDe(''), '');
  assert.equal(titleCase('NEW BRITAIN'), 'New Britain');
  assert.equal(titleCase("o'fallon"), "O'Fallon");
});

// ─── señal latina ────────────────────────────────────────────────────────────
test('señal latina por nombre: palabras en español con límites de palabra ("Remi" no es "mi")', () => {
  assert.ok(senalesLatinas('El Raspa Electromecanica LLC', 'x@y.com').nameMatch);
  assert.ok(senalesLatinas('Servicios Del Valle LLC', 'x@y.com').nameMatch);
  assert.ok(senalesLatinas('Mi Casa Cleaning', 'x@y.com').nameMatch);
  assert.ok(senalesLatinas('Taqueria Doña Lupe', 'x@y.com').nameMatch);
  assert.equal(senalesLatinas('Remi Richards Builds LLC', 'x@y.com').nameMatch, false);
  assert.equal(senalesLatinas('Lumi Links LLC', 'x@y.com').nameMatch, false);
  assert.equal(senalesLatinas('Elmwood Painting LLC', 'x@y.com').nameMatch, false);   // "el" dentro de una palabra
  assert.deepEqual(senalesLatinas('El Raspa LLC', 'x@y.com').reasons, ["nombre: 'El'".toLowerCase()]);
});

test('señal latina por apellido en el email: palabra exacta, inicio/final (5+ letras), medio (7+)', () => {
  assert.ok(senalesLatinas('Acme LLC', 'jose.garcia@gmail.com').emailMatch);       // token exacto
  assert.ok(senalesLatinas('Acme LLC', 'cruz@gmail.com').emailMatch);              // 4 letras pero token exacto
  assert.ok(senalesLatinas('Acme LLC', 'enzoramos122320@gmail.com').emailMatch);   // final, 5 letras
  assert.ok(senalesLatinas('Acme LLC', 'ramosenzo@gmail.com').emailMatch);         // inicio, 5 letras
  assert.ok(senalesLatinas('Acme LLC', 'xxvillanuevaxx@gmail.com').emailMatch);    // medio, 10 letras
  assert.equal(senalesLatinas('Acme LLC', 'xxcruzxx@gmail.com').emailMatch, false); // "cruz" (4) en medio: no
  assert.equal(senalesLatinas('Acme LLC', 'xxramosxx@gmail.com').emailMatch, false);// "ramos" (5) en medio: no (solo 7+)
  assert.equal(senalesLatinas('Acme LLC', 'carangelo@gmail.com').emailMatch, false);// "rangel" dentro de "carangelo": no
  assert.equal(senalesLatinas('Acme LLC', 'info@acme.com').emailMatch, false);
  assert.deepEqual(senalesLatinas('Acme LLC', 'ramosenzo@gmail.com').reasons, ['email: ramos']);
});

test('señal latina: combina motivos de nombre y email', () => {
  const s = senalesLatinas('Los Ramos Auto', 'enzo.ramos@gmail.com');
  assert.equal(s.reasons.length, 2);
  assert.ok(s.nameMatch && s.emailMatch);
});

// ─── regex de gestorías, no operativas ───────────────────────────────────────
test('regex: dominios de gestoría y nombres no operativos', () => {
  for (const e of ['x@incfile.com', 'a@zenbusiness.com', 'y@northwestregisteredagent.com', 'me@compliance-corp.com', 'q@bizee.com']) assert.ok(DOMINIOS_GESTORIA.test(e), e);
  assert.equal(DOMINIOS_GESTORIA.test('juan@gmail.com'), false);
  for (const n of ['Smith Holdings LLC', 'Ortiz Rentals LLC', 'ABC Capital Group', 'Ysabella Global Holdings', 'The Trust LLC', '46 Newberry Road Limited Liability Partnership', 'SANTI Enterprise Management LLC', 'X Properties LLC', 'Y Realty LLC']) assert.ok(RE_NO_OPERATIVA.test(n), n);
  assert.equal(RE_NO_OPERATIVA.test('Trustworthy Cleaning LLC'), false);   // "trust\b": no dentro de otra palabra
  assert.ok(RE_ESPANOL.test('panaderia'));
});

// ─── classifyRegistrations: el filtro completo ───────────────────────────────
test('lead válido: mapeo de campos, prioridad A, email en minúsculas, ciudad en título, zip de 5', () => {
  const { leads, stats } = classify([row({ business_email_address: '  Contacto@LimpiezaRivera.COM ' })]);
  assert.equal(leads.length, 1);
  assert.deepEqual(leads[0], {
    external_id: '1001', name: 'Limpieza Rivera LLC', email: 'contacto@limpiezarivera.com',
    city: 'New Britain', zip: '06053', address: '100 Silver Street', registered_at: '2026-09-14',
    naics_code: 'Janitorial Services (561720)', sector: 'limpieza', priority: 'A',
    latino_signal: true, latino_strong: true, minority_owned: false,
    notes: "señal latina: nombre: 'limpieza'",     // el apellido "rivera" está en el dominio, no en la parte local del email: no cuenta
  });
  assert.equal(stats.kept, 1);
});

test('prioridad B cuando el sector es "otro"; minoría declarada; latino_strong solo por el nombre', () => {
  const { leads } = classify([row({ name: 'Acme Trading LLC', naics_code: 'Tire Dealers (441340)', business_email_address: 'jose.garcia@gmail.com', minority_owned_organization: true })]);
  assert.equal(leads[0].sector, 'otro');
  assert.equal(leads[0].priority, 'B');
  assert.equal(leads[0].latino_signal, true);
  assert.equal(leads[0].latino_strong, false);      // la señal viene del email, no del nombre
  assert.equal(leads[0].minority_owned, true);
});

test('sin email o email sin @ → descartado', () => {
  const { leads, stats } = classify([row({ business_email_address: '' }), row({ accountnumber: '2', business_email_address: 'sin-arroba' }), row({ accountnumber: '3', business_email_address: undefined })]);
  assert.equal(leads.length, 0);
  assert.equal(stats.noEmail, 3);
});

test('email de gestoría: se usa category_survey_email_address si es válido; si no, se descarta', () => {
  const ok = classify([row({ business_email_address: 'x@incfile.com', category_survey_email_address: 'dueno.ramos@gmail.com' })]);
  assert.equal(ok.leads.length, 1);
  assert.equal(ok.leads[0].email, 'dueno.ramos@gmail.com');
  const altAlsoAgency = classify([row({ business_email_address: 'x@incfile.com', category_survey_email_address: 'y@zenbusiness.com' })]);
  assert.equal(altAlsoAgency.leads.length, 0);
  const noAlt = classify([row({ business_email_address: 'x@incfile.com', category_survey_email_address: '' })]);
  assert.equal(noAlt.leads.length, 0);
  assert.equal(noAlt.stats.gestoriaDomain, 1);
  const altNoAt = classify([row({ business_email_address: 'x@incfile.com', category_survey_email_address: 'sin-arroba' })]);
  assert.equal(altNoAt.leads.length, 0);
});

test('email compartido por 4+ empresas del lote → gestoría; con 3 todavía pasa; lista fija de gestores', () => {
  const same = (n) => Array.from({ length: n }, (_, i) => row({ accountnumber: String(i), name: `Servicios ${i} LLC`, business_email_address: 'Shared@Gmail.com' }));
  const four = classify(same(4));
  assert.equal(four.leads.length, 0);
  assert.equal(four.stats.sharedEmail, 4);
  assert.equal(classify(same(3)).leads.length, 3);
  const fixed = classify([row({ business_email_address: 'taxcenterct@gmail.com', name: 'Servicios Latinos LLC' })]);
  assert.equal(fixed.leads.length, 0);
});

test('NAICS de sociedades patrimoniales/financieras y nombres no operativos → descartados', () => {
  for (const naics of ['Lessors of Residential Buildings (531110)', 'Other Financial Vehicles (525990)', 'Offices of Other Holding Companies (551112)', 'Open-End Investment Funds (525910)', 'Trusts, Estates, and Agency Accounts (523991)']) {
    assert.equal(classify([row({ naics_code: naics })]).leads.length, 0, naics);
  }
  assert.equal(classify([row({ name: 'Rivera Holdings LLC' })]).leads.length, 0);
  assert.equal(classify([row({ name: 'Servicios Rivera Rentals LLC' })]).leads.length, 0);
  assert.equal(classify([row({})]).stats.nonOperating, 0);
});

test('sin señal latina se descarta (por defecto) y con latinOnly:false se conserva', () => {
  const r = row({ name: 'Acme Plumbing LLC', business_email_address: 'info@acmeplumbing.com', naics_code: 'Plumbing (238220)' });
  const strict = classify([r]);
  assert.equal(strict.leads.length, 0);
  assert.equal(strict.stats.notLatino, 1);
  const all = classify([r], { latinOnly: false });
  assert.equal(all.leads.length, 1);
  assert.equal(all.leads[0].latino_signal, false);
  assert.equal(all.leads[0].notes, null);
  assert.equal(all.leads[0].sector, 'construccion');
});

test('naics_code vacío o sin código → sector "otro"', () => {
  assert.equal(classify([row({ naics_code: '' })]).leads[0].sector, 'otro');
  assert.equal(classify([row({ naics_code: undefined })]).leads[0].sector, 'otro');
});

test('orden: registros más recientes primero', () => {
  const { leads } = classify([
    row({ accountnumber: '1', name: 'Servicios Uno', date_registration: '2026-09-01T00:00:00.000', business_email_address: 'a1@gmail.com' }),
    row({ accountnumber: '2', name: 'Servicios Dos', date_registration: '2026-09-20T00:00:00.000', business_email_address: 'a2@gmail.com' }),
    row({ accountnumber: '3', name: 'Servicios Tres', date_registration: '2026-09-10T00:00:00.000', business_email_address: 'a3@gmail.com' }),
  ]);
  assert.deepEqual(leads.map(l => l.external_id), ['2', '3', '1']);
});

test('el recuento de emails repetidos cuenta TODAS las filas del lote, aunque luego se descarten por otro motivo', () => {
  // 4 filas con el mismo email: 3 no operativas + 1 buena. El python cuenta las 4 → la buena se descarta como gestoría.
  const rows = [
    row({ accountnumber: '1', name: 'Servicios A Holdings', business_email_address: 'x@gmail.com' }),
    row({ accountnumber: '2', name: 'Servicios B Holdings', business_email_address: 'x@gmail.com' }),
    row({ accountnumber: '3', name: 'Servicios C Holdings', business_email_address: 'x@gmail.com' }),
    row({ accountnumber: '4', name: 'Servicios D LLC', business_email_address: 'x@gmail.com' }),
  ];
  assert.equal(classify(rows).leads.length, 0);
});

test('stats cuadran: raw = suma de descartes + kept', () => {
  const rows = [
    row({ accountnumber: '1' }),
    row({ accountnumber: '2', business_email_address: '' }),
    row({ accountnumber: '3', business_email_address: 'x@incfile.com' }),
    row({ accountnumber: '4', name: 'Rivera Holdings', business_email_address: 'r4@gmail.com' }),
    row({ accountnumber: '5', name: 'Acme', business_email_address: 'info@acme.com', naics_code: 'Foo (999999)' }),
  ];
  const { stats } = classify(rows);
  assert.equal(stats.raw, 5);
  assert.equal(stats.noEmail + stats.gestoriaDomain + stats.sharedEmail + stats.nonOperating + stats.notLatino + stats.kept, 5);
  assert.equal(stats.kept, 1);
});

// ─── fetchRegistrations ──────────────────────────────────────────────────────
function fakeApi(pages, { failFirst = 0, status = 500 } = {}) {
  const requests = [];
  let failures = failFirst;
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    requests.push({ url: u, headers: opts.headers });
    if (failures-- > 0) return { ok: false, status, json: async () => [] };
    const offset = Number(u.searchParams.get('$offset'));
    const limit = Number(u.searchParams.get('$limit'));
    return { ok: true, status: 200, json: async () => pages.slice(offset, offset + limit) };
  };
  return { fetchImpl, requests };
}
const rowsN = (n) => Array.from({ length: n }, (_, i) => ({ accountnumber: String(i) }));
const noSleep = async () => {};

test('fetchRegistrations: pagina con $limit/$offset hasta que una página viene incompleta', async () => {
  const { fetchImpl, requests } = fakeApi(rowsN(5));
  const rows = await fetchRegistrations({ since: '2026-07-01', pageSize: 2, fetchImpl, sleep: noSleep });
  assert.equal(rows.length, 5);
  assert.deepEqual(requests.map(r => r.url.searchParams.get('$offset')), ['0', '2', '4']);
});

test('fetchRegistrations: si el total es múltiplo del tamaño de página hace una petición extra vacía', async () => {
  const { fetchImpl, requests } = fakeApi(rowsN(4));
  const rows = await fetchRegistrations({ since: '2026-07-01', pageSize: 2, fetchImpl, sleep: noSleep });
  assert.equal(rows.length, 4);
  assert.equal(requests.length, 3);
});

test('fetchRegistrations: consulta correcta (activas, con email, desde la fecha, orden estable)', async () => {
  const { fetchImpl, requests } = fakeApi([]);
  await fetchRegistrations({ since: '2026-07-01', fetchImpl, sleep: noSleep, appToken: 'tok123' });
  const p = requests[0].url.searchParams;
  assert.equal(requests[0].url.origin + requests[0].url.pathname, API_URL);
  assert.equal(p.get('$where'), "status = 'Active' AND business_email_address IS NOT NULL AND date_registration >= '2026-07-01T00:00:00'");
  assert.equal(p.get('$order'), 'date_registration DESC, accountnumber');
  assert.equal(requests[0].headers['X-App-Token'], 'tok123');
});

test('fetchRegistrations: sin token no envía la cabecera', async () => {
  const { fetchImpl, requests } = fakeApi([]);
  await fetchRegistrations({ since: '2026-07-01', fetchImpl, sleep: noSleep, appToken: '' });
  assert.equal('X-App-Token' in requests[0].headers, false);
});

test('fetchRegistrations: reintenta ante 5xx y funciona; si sigue fallando lanza error claro', async () => {
  const ok = fakeApi(rowsN(1), { failFirst: 2, status: 503 });
  assert.equal((await fetchRegistrations({ since: '2026-07-01', fetchImpl: ok.fetchImpl, sleep: noSleep })).length, 1);
  assert.equal(ok.requests.length, 3);
  const bad = fakeApi(rowsN(1), { failFirst: 5, status: 503 });
  await assert.rejects(() => fetchRegistrations({ since: '2026-07-01', fetchImpl: bad.fetchImpl, sleep: noSleep }), /respondió 503/);
});

test('fetchRegistrations: 429 sugiere SOCRATA_APP_TOKEN; 4xx que no es 429 no se reintenta', async () => {
  const limited = fakeApi([], { failFirst: 9, status: 429 });
  await assert.rejects(() => fetchRegistrations({ since: '2026-07-01', fetchImpl: limited.fetchImpl, sleep: noSleep }), /SOCRATA_APP_TOKEN/);
  const notFound = fakeApi([], { failFirst: 9, status: 404 });
  await assert.rejects(() => fetchRegistrations({ since: '2026-07-01', fetchImpl: notFound.fetchImpl, sleep: noSleep }), /respondió 404/);
  assert.equal(notFound.requests.length, 1);
});

test('fetchRegistrations: error de red se reintenta y luego se explica', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; throw new Error('ECONNRESET'); };
  await assert.rejects(() => fetchRegistrations({ since: '2026-07-01', fetchImpl, sleep: noSleep }), /No se pudo consultar data\.ct\.gov: ECONNRESET/);
  assert.equal(n, 3);
});

test('fetchRegistrations: valida "since" (evita meter texto raro en el $where)', async () => {
  const { fetchImpl } = fakeApi([]);
  for (const bad of [undefined, '', '2026/07/01', "2026-07-01' OR 1=1 --", 'ayer']) {
    await assert.rejects(() => fetchRegistrations({ since: bad, fetchImpl, sleep: noSleep }), /since/);
  }
});

test('fetchRegistrations: corta si nunca termina (máximo de páginas)', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => rowsN(2) });
  await assert.rejects(() => fetchRegistrations({ since: '2026-07-01', pageSize: 2, maxPages: 3, fetchImpl, sleep: noSleep }), /máximo de 3 páginas/);
});
