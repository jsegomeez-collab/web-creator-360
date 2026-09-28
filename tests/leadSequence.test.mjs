// Motor de la secuencia: horarios, límites por buzón, reparto en el día, hilos, rebotes, fallos y simulaciones de semanas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from './helpers/memoryDb.mjs';
import { runSendCycle, computeNextSendAt, cyclesLeft, resetDryRunLeads } from '../src/services/leadSequence.js';
import { SEQUENCE_LENGTH } from '../src/prompts/newBusinessEmails.js';
import { DRY_RUN_ID_PREFIX } from '../src/services/coldMailer.js';

const OWNER = 'owner-1';
const T = 'new_business_leads';
const at = (iso) => new Date(iso);
const MON_9 = at('2026-09-28T13:00:00Z');      // lunes 09:00 en Connecticut (EDT)
const MON_10 = at('2026-09-28T14:00:00Z');
const THU_9 = at('2026-10-01T13:00:00Z');
const plusMin = (d, m) => new Date(d.getTime() + m * 60_000);

const config = { baseUrl: 'https://app.example.com', companyName: 'Eternity Strategy', companyAddress: '1 Main St, Hartford, CT', senderName: 'Jose' };
const mb = (id, dailyLimit = 30) => ({ id, host: 'h', port: 465, secure: true, user: 'u', pass: 'p', from: `Jose <${id}@d.com>`, dailyLimit });

const mkLead = (i, over = {}) => ({
  id: `L${i}`, user_id: OWNER, source: 'ct_registry', external_id: `E${i}`, name: `Negocio ${i} LLC`, email: `l${i}@gmail.com`,
  city: 'Hartford', zip: '06103', address: '', registered_at: `2026-09-${String(25 - i).padStart(2, '0')}`,   // L1 = el más reciente
  sector: 'limpieza', priority: 'A', latino_signal: true, latino_strong: false,
  status: 'new', sequence_step: 0, next_send_at: null, last_sent_at: null, mailbox: null, first_message_id: null, first_subject: null,
  form_token: `TOKEN${String(i).padStart(19, '0')}`, ...over,
});
const dbWith = (leads, extra = {}) => createMemoryDb({ [T]: leads, email_suppressions: [], ...extra });
const lead = (db, id) => db.rows(T).find(l => l.id === id);

// Mailer falso: registra lo enviado; `failFor(message, mailbox)` devuelve un error (con kind) o null
function makeMailer({ failFor = () => null } = {}) {
  const sent = []; let seq = 0;
  return {
    sent,
    async send(mailbox, message) {
      const f = failFor(message, mailbox);
      if (f) throw Object.assign(new Error(f.message || 'fallo simulado'), { kind: f.kind, responseCode: f.responseCode });
      sent.push({ mailbox: mailbox.id, ...message });
      return { messageId: `<m${++seq}@test>`, dryRun: false };
    },
    close() {},
  };
}
const run = (db, mailer, over = {}) => runSendCycle({
  db, ownerId: OWNER, mailboxes: [mb('a')], mailer, config, now: MON_9, dryRun: false, pause: async () => {}, log: () => {}, ...over,
});
const nyDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);

// ─── tiempo ──────────────────────────────────────────────────────────────────
test('computeNextSendAt: separación por día de la secuencia, a las 9:00 de Connecticut, sin fines de semana', () => {
  const iso = (d, step) => computeNextSendAt(at(d), step)?.toISOString() ?? null;
  assert.equal(iso('2026-09-28T14:00:00Z', 1), '2026-10-01T13:00:00.000Z');   // lun + 3 = jue
  assert.equal(iso('2026-10-01T14:00:00Z', 2), '2026-10-05T13:00:00.000Z');   // jue + 4 = lun
  assert.equal(iso('2026-10-05T14:00:00Z', 3), '2026-10-12T13:00:00.000Z');   // lun + 5 = sáb → lunes
  assert.equal(iso('2026-10-12T14:00:00Z', 4), '2026-10-19T13:00:00.000Z');   // lun + 6 = dom → lunes
  assert.equal(iso('2026-10-19T14:00:00Z', 5), '2026-10-26T13:00:00.000Z');   // lun + 7
  assert.equal(iso('2026-10-26T14:00:00Z', 6), null);                          // fin de la secuencia
  assert.equal(iso('2026-10-30T14:00:00Z', 1), '2026-11-02T14:00:00.000Z');   // cruza el cambio de hora: 9:00 EST = 14:00Z
});

test('cyclesLeft: ciclos que quedan hoy (incluido este)', () => {
  assert.equal(cyclesLeft(at('2026-09-28T13:00:00Z')), 16);   // 9:00
  assert.equal(cyclesLeft(at('2026-09-28T16:00:00Z')), 10);   // 12:00
  assert.equal(cyclesLeft(at('2026-09-28T20:30:00Z')), 1);    // 16:30
  assert.equal(cyclesLeft(at('2026-09-28T20:45:00Z')), 1);    // 16:45
});

// ─── guardas ─────────────────────────────────────────────────────────────────
test('fuera de horario (noche, fin de semana, antes de las 9): no hace nada', async () => {
  for (const when of ['2026-09-28T12:59:00Z', '2026-09-28T21:00:00Z', '2026-10-03T15:00:00Z', '2026-10-04T15:00:00Z']) {
    const db = dbWith([mkLead(1)]); const mailer = makeMailer();
    const r = await run(db, mailer, { now: at(when) });
    assert.equal(r.skipped, 'outside_window', when);
    assert.equal(mailer.sent.length, 0);
    assert.equal(lead(db, 'L1').status, 'new');
  }
});

test('sin buzones configurados: no hace nada', async () => {
  const db = dbWith([mkLead(1)]); const mailer = makeMailer();
  assert.equal((await run(db, mailer, { mailboxes: [] })).skipped, 'no_mailboxes');
  assert.equal(mailer.sent.length, 0);
});

// ─── email 0 ─────────────────────────────────────────────────────────────────
test('primer email: los más recientes primero, cuota de 2 a las 9:00 (30/día ÷ 16 ciclos), y estado guardado', async () => {
  const db = dbWith([5, 3, 1, 4, 2].map(i => mkLead(i)));
  const mailer = makeMailer();
  const r = await run(db, mailer);
  assert.equal(r.sent, 2);
  assert.deepEqual(mailer.sent.map(m => m.to), ['l1@gmail.com', 'l2@gmail.com']);
  const m = mailer.sent[0];
  assert.equal(m.subject, 'Enhorabuena por Negocio 1 LLC 🎉');
  assert.ok(m.text.includes('https://app.example.com/f/TOKEN0000000000000000001'));
  assert.ok(m.text.includes('https://app.example.com/u/TOKEN0000000000000000001'));
  assert.equal(m.headers['List-Unsubscribe'], '<https://app.example.com/u/TOKEN0000000000000000001>');
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal('inReplyTo' in m, false);

  const l1 = lead(db, 'L1');
  assert.deepEqual([l1.status, l1.sequence_step, l1.mailbox, l1.first_message_id, l1.first_subject, l1.last_sent_at],
    ['emailed', 1, 'a', '<m1@test>', 'Enhorabuena por Negocio 1 LLC 🎉', MON_9.toISOString()]);
  assert.equal(l1.next_send_at, '2026-10-01T13:00:00.000Z');
  assert.equal(lead(db, 'L3').status, 'new');                       // los demás esperan
  assert.deepEqual(r.mailboxes.a, { dailyLimit: 30, sentBefore: 0, quota: 2, sent: 2, stopped: false });
});

test('reparte los envíos durante el día: nunca pasa del límite diario del buzón', async () => {
  const db = dbWith(Array.from({ length: 20 }, (_, i) => mkLead(i + 1)));
  const mailer = makeMailer();
  const perCycle = [];
  for (let c = 0; c < 16; c++) {                                     // 9:00, 9:30 … 16:30
    const r = await run(db, mailer, { now: plusMin(MON_9, c * 30), mailboxes: [mb('a', 4)] });
    perCycle.push(r.sent);
  }
  assert.equal(mailer.sent.length, 4);                              // límite del buzón = 4
  assert.ok(Math.max(...perCycle) <= 1, `un ciclo mandó ${Math.max(...perCycle)}`);
  assert.equal(new Set(mailer.sent.map(m => m.to)).size, 4);
});

test('si un ciclo se pierde, el siguiente recupera capacidad; a las 16:30 se usa todo lo que quede', async () => {
  const db = dbWith(Array.from({ length: 40 }, (_, i) => mkLead(i + 1)));
  const mailer = makeMailer();
  const r = await run(db, mailer, { now: at('2026-09-28T20:30:00Z') });   // 16:30: solo queda este ciclo
  assert.equal(r.sent, 30);
});

test('varios buzones: reparto equilibrado, cada uno con su límite, y cada lead usa un único buzón', async () => {
  const db = dbWith(Array.from({ length: 10 }, (_, i) => mkLead(i + 1)));
  const mailer = makeMailer();
  for (let c = 0; c < 16; c++) await run(db, mailer, { now: plusMin(MON_9, c * 30), mailboxes: [mb('a', 3), mb('b', 3)] });
  const byBox = mailer.sent.reduce((a, m) => (a[m.mailbox] = (a[m.mailbox] || 0) + 1, a), {});
  assert.deepEqual(byBox, { a: 3, b: 3 });
  const first = await run(dbWith([mkLead(1), mkLead(2)]), makeMailer(), { mailboxes: [mb('a', 30), mb('b', 30)] });
  assert.equal(first.mailboxes.a.sent, 1);                           // en el primer ciclo, uno para cada buzón
  assert.equal(first.mailboxes.b.sent, 1);
});

test('lo enviado hoy por el buzón cuenta contra su límite diario', async () => {
  const today = MON_9.toISOString();
  const db = dbWith([mkLead(1, { status: 'emailed', sequence_step: 1, mailbox: 'a', last_sent_at: today, next_send_at: '2026-10-01T13:00:00.000Z' }),
    mkLead(2, { status: 'emailed', sequence_step: 1, mailbox: 'a', last_sent_at: today, next_send_at: '2026-10-01T13:00:00.000Z' }),
    mkLead(3), mkLead(4)]);
  const mailer = makeMailer();
  const r = await run(db, mailer, { mailboxes: [mb('a', 2)] });
  assert.equal(r.sent, 0);
  assert.equal(r.mailboxes.a.quota, 0);
  assert.equal(lead(db, 'L3').status, 'new');
  // al día siguiente la capacidad vuelve
  const next = await run(db, mailer, { mailboxes: [mb('a', 2)], now: at('2026-09-29T13:00:00Z') });
  assert.ok(next.sent >= 1);
});

// ─── seguimientos ────────────────────────────────────────────────────────────
test('seguimiento del día 3: mismo buzón, "Re:" en el mismo hilo (In-Reply-To y References), y programa el siguiente', async () => {
  const db = dbWith([mkLead(1)]);
  const mailer = makeMailer();
  await run(db, mailer, { mailboxes: [mb('a'), mb('b')] });
  const box = lead(db, 'L1').mailbox;
  await run(db, mailer, { now: THU_9, mailboxes: [mb('a'), mb('b')] });
  assert.equal(mailer.sent.length, 2);
  const f = mailer.sent[1];
  assert.equal(f.mailbox, box);
  assert.equal(f.subject, 'Re: Enhorabuena por Negocio 1 LLC 🎉');
  assert.equal(f.inReplyTo, '<m1@test>');
  assert.equal(f.references, '<m1@test>');
  assert.ok(f.text.includes('¿Pudiste ver mi mensaje?'));
  const l = lead(db, 'L1');
  assert.deepEqual([l.status, l.sequence_step, l.next_send_at], ['emailed', 2, '2026-10-05T13:00:00.000Z']);
  assert.equal(l.first_message_id, '<m1@test>');                     // el del primer email no cambia
});

test('prioridad: los seguimientos vencidos pasan antes que los leads nuevos', async () => {
  const db = dbWith([mkLead(1, { status: 'emailed', sequence_step: 1, mailbox: 'a', first_message_id: '<x@t>', first_subject: 'S', last_sent_at: '2026-09-28T14:00:00.000Z', next_send_at: THU_9.toISOString() }), mkLead(2), mkLead(3)]);
  const mailer = makeMailer();
  const r = await run(db, mailer, { now: THU_9, mailboxes: [mb('a', 16)] });    // 16/16 ciclos = cuota 1
  assert.equal(r.sent, 1);
  assert.equal(mailer.sent[0].to, 'l1@gmail.com');
  assert.equal(lead(db, 'L2').status, 'new');
});

test('seguimiento sin first_message_id guardado: sale igualmente (con "Re:") sin cabeceras de hilo', async () => {
  const db = dbWith([mkLead(1, { status: 'emailed', sequence_step: 1, mailbox: 'a', first_subject: 'Hola', last_sent_at: '2026-09-28T14:00:00.000Z', next_send_at: THU_9.toISOString() })]);
  const mailer = makeMailer();
  await run(db, mailer, { now: THU_9 });
  assert.equal(mailer.sent[0].subject, 'Re: Hola');
  assert.equal('inReplyTo' in mailer.sent[0], false);
});

test('último email de la secuencia: pasa a sequence_finished y no se programa más', async () => {
  const db = dbWith([mkLead(1, { status: 'emailed', sequence_step: 5, mailbox: 'a', first_message_id: '<x@t>', first_subject: 'S', last_sent_at: '2026-10-19T14:00:00.000Z', next_send_at: '2026-10-26T13:00:00.000Z' })]);
  const mailer = makeMailer();
  await run(db, mailer, { now: at('2026-10-26T13:00:00Z') });
  assert.ok(mailer.sent[0].text.includes('Este es mi último mensaje'));
  const l = lead(db, 'L1');
  assert.deepEqual([l.status, l.sequence_step, l.next_send_at], ['sequence_finished', SEQUENCE_LENGTH, null]);
  const again = await run(db, mailer, { now: at('2026-10-27T13:00:00Z') });
  assert.equal(again.sent, 0);
});

test('un lead al que ya se escribió hoy no recibe otro email el mismo día', async () => {
  const db = dbWith([mkLead(1, { status: 'emailed', sequence_step: 1, mailbox: 'a', first_message_id: '<x@t>', first_subject: 'S', last_sent_at: '2026-10-01T12:00:00.000Z', next_send_at: '2026-10-01T12:30:00.000Z' })]);
  const mailer = makeMailer();
  await run(db, mailer, { now: THU_9 });
  assert.equal(mailer.sent.length, 0);
});

test('leads en estados finales o de conversión NUNCA reciben emails, aunque tengan fecha vencida', async () => {
  const statuses = ['form_submitted', 'called', 'won', 'lost', 'unsubscribed', 'bounced', 'invalid_email', 'replied', 'sequence_finished'];
  const db = dbWith(statuses.map((s, i) => mkLead(i + 1, { status: s, sequence_step: 2, mailbox: 'a', first_message_id: '<x@t>', first_subject: 'S', next_send_at: '2026-09-01T13:00:00.000Z' })));
  const mailer = makeMailer();
  await run(db, mailer);
  assert.equal(mailer.sent.length, 0);
});

// ─── simulaciones largas ─────────────────────────────────────────────────────
test('SIMULACIÓN: un lead recorre los 6 emails los días 0, 3, 7, 12, 18 y 25 (ajustados a días laborables)', async () => {
  const db = dbWith([mkLead(1)]);
  const mailer = makeMailer();
  const when = [];
  for (let t = MON_9; t < at('2026-11-02T04:00:00Z'); t = plusMin(t, 30)) {
    const before = mailer.sent.length;
    await run(db, mailer, { now: t, mailboxes: [mb('a', 30)] });
    if (mailer.sent.length > before) when.push(t.toISOString());
  }
  assert.deepEqual(when, [
    '2026-09-28T13:00:00.000Z',   // día 0  · lunes
    '2026-10-01T13:00:00.000Z',   // día 3  · jueves
    '2026-10-05T13:00:00.000Z',   // día 7  · lunes
    '2026-10-12T13:00:00.000Z',   // día 12 · sábado → lunes
    '2026-10-19T13:00:00.000Z',   // día 18 · domingo → lunes
    '2026-10-26T13:00:00.000Z',   // día 25 · lunes
  ]);
  assert.equal(mailer.sent.length, SEQUENCE_LENGTH);
  assert.ok(mailer.sent.every(m => m.mailbox === 'a'));
  assert.equal(mailer.sent[0].subject, 'Enhorabuena por Negocio 1 LLC 🎉');
  assert.ok(mailer.sent.slice(1).every(m => m.subject === 'Re: Enhorabuena por Negocio 1 LLC 🎉' && m.inReplyTo === '<m1@test>'));
  const l = lead(db, 'L1');
  assert.deepEqual([l.status, l.sequence_step, l.next_send_at], ['sequence_finished', 6, null]);
});

test('SIMULACIÓN: 12 leads, 2 buzones de 5/día durante 40 días — límites, un buzón por lead, sin fines de semana ni duplicados el mismo día', async () => {
  const db = dbWith(Array.from({ length: 12 }, (_, i) => mkLead(i + 1)));
  const mailer = makeMailer();
  const perDayPerBox = new Map(); const perLeadDay = new Set(); const dupes = [];
  for (let t = MON_9; t < at('2026-11-06T04:00:00Z'); t = plusMin(t, 30)) {
    const before = mailer.sent.length;
    await run(db, mailer, { now: t, mailboxes: [mb('a', 5), mb('b', 5)] });
    for (const m of mailer.sent.slice(before)) {
      const key = `${nyDay(t)}|${m.mailbox}`;
      perDayPerBox.set(key, (perDayPerBox.get(key) || 0) + 1);
      const ld = `${nyDay(t)}|${m.to}`;
      if (perLeadDay.has(ld)) dupes.push(ld);
      perLeadDay.add(ld);
      const dow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(t);
      assert.ok(!['Sat', 'Sun'].includes(dow), `envío en fin de semana: ${t.toISOString()}`);
    }
  }
  assert.ok([...perDayPerBox.values()].every(n => n <= 5), 'algún buzón superó su límite diario');
  assert.deepEqual(dupes, []);
  // Cada lead usó siempre el mismo buzón y todos completaron los 6 emails
  for (const l of db.rows(T)) {
    const boxes = new Set(mailer.sent.filter(m => m.to === l.email).map(m => m.mailbox));
    assert.equal(boxes.size, 1, `${l.id} usó ${[...boxes]}`);
    assert.equal(l.status, 'sequence_finished', `${l.id}: ${l.status} (paso ${l.sequence_step})`);
  }
  assert.equal(mailer.sent.length, 12 * SEQUENCE_LENGTH);
});

// ─── supresiones ─────────────────────────────────────────────────────────────
test('email en supresiones: no se envía y el lead pasa a unsubscribed / bounced según el motivo', async () => {
  const db = dbWith([mkLead(1), mkLead(2), mkLead(3)], { email_suppressions: [
    { user_id: OWNER, email: 'l1@gmail.com', reason: 'unsubscribed' }, { user_id: OWNER, email: 'l2@gmail.com', reason: 'bounced' },
    { user_id: 'otro-usuario', email: 'l3@gmail.com', reason: 'unsubscribed' },   // de otro usuario: no cuenta
  ] });
  const mailer = makeMailer();
  const r = await run(db, mailer, { mailboxes: [mb('a', 48)] });
  assert.equal(r.suppressed, 2);
  assert.deepEqual(mailer.sent.map(m => m.to), ['l3@gmail.com']);
  assert.equal(lead(db, 'L1').status, 'unsubscribed');
  assert.equal(lead(db, 'L2').status, 'bounced');
  assert.equal(lead(db, 'L1').next_send_at, null);
});

test('se da de baja mientras está en cola o esperando un seguimiento: no se le escribe', async () => {
  const db = dbWith([
    mkLead(1, { status: 'queued', mailbox: 'a', next_send_at: MON_9.toISOString() }),
    mkLead(2, { status: 'emailed', sequence_step: 1, mailbox: 'a', first_message_id: '<x@t>', first_subject: 'S', last_sent_at: '2026-09-24T14:00:00.000Z', next_send_at: MON_9.toISOString() }),
  ], { email_suppressions: [{ user_id: OWNER, email: 'l1@gmail.com', reason: 'unsubscribed' }, { user_id: OWNER, email: 'l2@gmail.com', reason: 'unsubscribed' }] });
  const mailer = makeMailer();
  await run(db, mailer, { mailboxes: [mb('a', 48)] });
  assert.equal(mailer.sent.length, 0);
  assert.deepEqual([lead(db, 'L1').status, lead(db, 'L2').status], ['unsubscribed', 'unsubscribed']);
});

test('si no se puede consultar la lista de supresiones NO se envía (falla cerrado)', async () => {
  const db = dbWith([mkLead(1)]);
  db.failNext('email_suppressions', 'select', 'caída de la base de datos');
  const mailer = makeMailer();
  const r = await run(db, mailer);
  assert.equal(mailer.sent.length, 0);
  assert.equal(r.errors, 1);
});

// ─── rebotes y fallos ────────────────────────────────────────────────────────
test('rebote permanente del destinatario: bounced + supresión, y el resto de leads sigue', async () => {
  const db = dbWith([mkLead(1), mkLead(2)]);
  const mailer = makeMailer({ failFor: (m) => (m.to === 'l1@gmail.com' ? { kind: 'bounce', responseCode: 550 } : null) });
  const r = await run(db, mailer, { mailboxes: [mb('a', 48)] });
  assert.equal(r.bounced, 1);
  assert.equal(r.sent, 1);
  assert.deepEqual([lead(db, 'L1').status, lead(db, 'L1').next_send_at], ['bounced', null]);
  assert.deepEqual(db.rows('email_suppressions').map(s => [s.user_id, s.email, s.reason]), [[OWNER, 'l1@gmail.com', 'bounced']]);
  assert.equal(lead(db, 'L2').status, 'emailed');
});

test('problema del buzón (login, spam): NO quema los leads, se pausa el buzón tras 2 fallos y los leads vuelven a la cola', async () => {
  const db = dbWith([mkLead(1), mkLead(2), mkLead(3)]);
  const bad = makeMailer({ failFor: () => ({ kind: 'mailbox', responseCode: 535 }) });
  const r = await run(db, bad, { mailboxes: [mb('a', 48)] });          // 48/16 = cuota 3
  assert.equal(r.sent, 0);
  assert.equal(r.mailboxes.a.stopped, true);
  assert.deepEqual([lead(db, 'L1').status, lead(db, 'L1').mailbox], ['new', null]);   // devuelto al pool
  assert.deepEqual([lead(db, 'L2').status, lead(db, 'L2').mailbox], ['new', null]);
  assert.equal(lead(db, 'L3').status, 'queued');                                       // no llegó a intentarse
  assert.equal(db.rows('email_suppressions').length, 0);
  assert.ok(db.rows(T).every(l => l.status !== 'bounced'));

  // Con el buzón arreglado, en el siguiente ciclo salen todos
  const good = makeMailer();
  await run(db, good, { mailboxes: [mb('a', 48)], now: plusMin(MON_9, 30) });
  assert.ok(good.sent.length >= 3);
});

test('un buzón caído no impide que otro envíe', async () => {
  const db = dbWith(Array.from({ length: 6 }, (_, i) => mkLead(i + 1)));
  const mailer = makeMailer({ failFor: (m, box) => (box.id === 'a' ? { kind: 'mailbox', responseCode: 535 } : null) });
  const r = await run(db, mailer, { mailboxes: [mb('a', 48), mb('b', 48)] });
  assert.ok(mailer.sent.length >= 2 && mailer.sent.every(m => m.mailbox === 'b'));
  assert.equal(r.mailboxes.a.sent, 0);
});

test('fallo temporal: el lead sigue en cola, se reintenta en el ciclo siguiente (30 min) y sale', async () => {
  const db = dbWith([mkLead(1)]);
  let fail = true;
  const mailer = makeMailer({ failFor: () => (fail ? { kind: 'transient', responseCode: 421 } : null) });
  const r = await run(db, mailer);
  assert.equal(r.errors, 1);
  assert.equal(lead(db, 'L1').status, 'queued');
  assert.equal(lead(db, 'L1').next_send_at, plusMin(MON_9, 30).toISOString());
  fail = false;
  await run(db, mailer, { now: plusMin(MON_9, 15) });                   // aún no toca
  assert.equal(mailer.sent.length, 0);
  await run(db, mailer, { now: plusMin(MON_9, 30) });
  assert.equal(mailer.sent.length, 1);
  assert.equal(lead(db, 'L1').status, 'emailed');
});

test('fallo de buzón en un seguimiento: sigue en "emailed" con su buzón, se reintenta en 30 min', async () => {
  const db = dbWith([mkLead(1, { status: 'emailed', sequence_step: 1, mailbox: 'a', first_message_id: '<x@t>', first_subject: 'S', last_sent_at: '2026-09-28T14:00:00.000Z', next_send_at: THU_9.toISOString() })]);
  const mailer = makeMailer({ failFor: () => ({ kind: 'mailbox', responseCode: 535 }) });
  await run(db, mailer, { now: THU_9 });
  const l = lead(db, 'L1');
  assert.deepEqual([l.status, l.mailbox, l.sequence_step, l.next_send_at], ['emailed', 'a', 1, plusMin(THU_9, 30).toISOString()]);
});

test('si falla la redacción del email de un lead, se aplaza y los demás salen', async () => {
  const db = dbWith([mkLead(1), mkLead(2)]);
  const mailer = makeMailer();
  const render = (l, step, ctx) => { if (l.id === 'L1') throw new Error('plantilla rota'); return { subject: 's', text: 't', html: 'h' }; };
  const r = await run(db, mailer, { mailboxes: [mb('a', 48)], render });
  assert.equal(r.sent, 1);
  assert.equal(r.errors, 1);
  assert.equal(lead(db, 'L1').next_send_at, plusMin(MON_9, 30).toISOString());
});

// ─── buzones que ya no existen ───────────────────────────────────────────────
test('un lead en cola con un buzón que ya no existe vuelve al pool y lo coge otro buzón', async () => {
  const db = dbWith([mkLead(1, { status: 'queued', mailbox: 'borrado', next_send_at: MON_9.toISOString() })]);
  const mailer = makeMailer();
  const r = await run(db, mailer);
  assert.equal(r.released, 1);
  assert.deepEqual(mailer.sent.map(m => m.mailbox), ['a']);
});

test('un seguimiento cuyo buzón ya no está configurado NO se reasigna (rompería el hilo)', async () => {
  const db = dbWith([mkLead(1, { status: 'emailed', sequence_step: 1, mailbox: 'borrado', first_message_id: '<x@t>', first_subject: 'S', last_sent_at: '2026-09-28T14:00:00.000Z', next_send_at: THU_9.toISOString() })]);
  const mailer = makeMailer();
  const logs = [];
  const r = await run(db, mailer, { now: THU_9, log: (m) => logs.push(m) });
  assert.equal(r.orphaned, 1);
  assert.equal(mailer.sent.length, 0);
  assert.ok(logs.some(l => l.includes('"borrado"') && l.includes('ya no está')));
});

// ─── concurrencia, límites, persistencia ─────────────────────────────────────
test('si otro proceso reserva el lead antes, este no lo envía (compare-and-set)', async () => {
  const due = (i) => mkLead(i, { status: 'emailed', sequence_step: 1, mailbox: 'a', first_message_id: '<x@t>', first_subject: 'S', last_sent_at: '2026-09-28T14:00:00.000Z', next_send_at: THU_9.toISOString() });
  const db = dbWith([due(1), due(2)]);
  const mailer = makeMailer();
  // Mientras se prepara el email del lead 1, "otro proceso" reserva el lead 2
  const render = (l, step, ctx) => { if (l.id === 'L1') lead(db, 'L2').next_send_at = '2099-01-01T00:00:00.000Z'; return { subject: 's', text: 't', html: 'h' }; };
  const r = await run(db, mailer, { now: THU_9, mailboxes: [mb('a', 48)], render });
  assert.deepEqual(mailer.sent.map(m => m.to), ['l1@gmail.com']);
  assert.equal(r.results.find(x => x.lead_id === 'L2').outcome, 'contended');
});

test('--limit: como máximo N emails en el ciclo', async () => {
  const db = dbWith(Array.from({ length: 10 }, (_, i) => mkLead(i + 1)));
  const mailer = makeMailer();
  const r = await run(db, mailer, { mailboxes: [mb('a', 160)], limit: 3 });     // cuota 10, pero límite 3
  assert.equal(r.sent, 3);
  assert.equal(mailer.sent.length, 3);
});

test('tras enviar, si falla el guardado se reintenta (3 veces); si no hay manera, avisa con un error visible', async () => {
  const afterSend = (p) => p.sequence_step > 0;                                // el guardado posterior al envío (la limpieza de dry-run pone 0)
  const db = dbWith([mkLead(1)]);
  db.failNext(T, 'update', 'timeout', afterSend);                              // 1 fallo → el reintento funciona
  let r = await run(db, makeMailer());
  assert.equal(r.sent, 1);
  assert.equal(lead(db, 'L1').status, 'emailed');

  const db2 = dbWith([mkLead(1)]);
  for (let i = 0; i < 3; i++) db2.failNext(T, 'update', 'timeout', afterSend);  // 3 fallos seguidos
  const logs = [];
  r = await run(db2, makeMailer(), { log: (m) => logs.push(m) });
  assert.equal(r.sent, 1);                                                      // el email ya salió
  assert.ok(logs.some(m => m.includes('Revísalo a mano')));
});

// ─── dry-run ─────────────────────────────────────────────────────────────────
test('los leads "enviados" por un dry-run vuelven a "new" cuando llega un ciclo real (no salen seguimientos de un email inexistente)', async () => {
  const db = dbWith([mkLead(1), mkLead(2)]);
  const dryMailer = { sent: [], async send(mailbox, message) { this.sent.push(message); return { messageId: `${DRY_RUN_ID_PREFIX}abc123@dry-run.local>`, dryRun: true }; }, close() {} };
  await run(db, dryMailer, { dryRun: true, mailboxes: [mb('a', 48)] });
  assert.equal(dryMailer.sent.length, 2);                                      // cuota 3, pero solo hay 2 leads
  assert.equal(lead(db, 'L1').status, 'emailed');
  assert.ok(lead(db, 'L1').first_message_id.startsWith(DRY_RUN_ID_PREFIX));

  const real = makeMailer();
  const logs = [];
  await run(db, real, { now: THU_9, mailboxes: [mb('a', 48)], log: (m) => logs.push(m) });   // jueves: sería el seguimiento del día 3
  assert.ok(logs.some(m => m.includes('vuelven a "new"')));
  assert.ok(real.sent.length >= 1);
  assert.ok(real.sent.every(m => !m.subject.startsWith('Re:') && !('inReplyTo' in m)), 'no debe salir un seguimiento de un email que nunca se envió');
  assert.equal(real.sent[0].subject, 'Enhorabuena por Negocio 1 LLC 🎉');
});

test('resetDryRunLeads solo toca leads de dry-run, no los enviados de verdad', async () => {
  const db = dbWith([
    mkLead(1, { status: 'emailed', sequence_step: 1, mailbox: 'a', first_message_id: `${DRY_RUN_ID_PREFIX}zzz@dry-run.local>`, next_send_at: THU_9.toISOString() }),
    mkLead(2, { status: 'emailed', sequence_step: 1, mailbox: 'a', first_message_id: '<real@dominio.com>', next_send_at: THU_9.toISOString() }),
    mkLead(3, { status: 'form_submitted', first_message_id: `${DRY_RUN_ID_PREFIX}yyy@dry-run.local>` }),
  ]);
  assert.equal(await resetDryRunLeads(db, OWNER), 1);
  assert.equal(lead(db, 'L1').status, 'new');
  assert.equal(lead(db, 'L1').first_message_id, null);
  assert.equal(lead(db, 'L2').status, 'emailed');
  assert.equal(lead(db, 'L3').status, 'form_submitted');
});

test('en dry-run NO se limpian los leads de otras pruebas (solo en ciclos reales)', async () => {
  const db = dbWith([mkLead(1, { status: 'emailed', sequence_step: 1, mailbox: 'a', first_message_id: `${DRY_RUN_ID_PREFIX}zzz@dry-run.local>`, first_subject: 'S', last_sent_at: '2026-09-28T14:00:00.000Z', next_send_at: THU_9.toISOString() })]);
  const dryMailer = { sent: [], async send(mb2, m) { this.sent.push(m); return { messageId: `${DRY_RUN_ID_PREFIX}n@dry-run.local>`, dryRun: true }; }, close() {} };
  await run(db, dryMailer, { dryRun: true, now: THU_9 });
  assert.equal(dryMailer.sent[0].subject, 'Re: S');                             // continúa la simulación en su hilo
});
