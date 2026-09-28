// Envío SMTP en frío: configuración de buzones, clasificación de errores, hilos y modo dry-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadMailboxes, mailboxesForCycle, describeMailbox, classifySmtpError, createMailer, pauseRangeMs, randomBetween, DRY_RUN_ID_PREFIX,
} from '../src/services/coldMailer.js';
import { loadCampaignConfig, formUrl, unsubscribeUrl } from '../src/services/campaignConfig.js';

const box = (o = {}) => ({ id: 'jose1', host: 'smtp.gmail.com', port: 465, user: 'jose@dominio1.com', pass: 'app-pass-secreto', from: 'Jose <jose@dominio1.com>', ...o });
const env = (list, extra = {}) => ({ COLD_MAILBOXES: JSON.stringify(list), ...extra });

// ─── loadMailboxes ───────────────────────────────────────────────────────────
test('sin COLD_MAILBOXES → lista vacía', () => {
  assert.deepEqual(loadMailboxes({}), []);
  assert.deepEqual(loadMailboxes({ COLD_MAILBOXES: '   ' }), []);
});

test('buzón válido: normaliza (secure por puerto 465, límite diario por defecto 30)', () => {
  const [m] = loadMailboxes(env([box()]));
  assert.deepEqual(m, { id: 'jose1', host: 'smtp.gmail.com', port: 465, secure: true, user: 'jose@dominio1.com', pass: 'app-pass-secreto', from: 'Jose <jose@dominio1.com>', dailyLimit: 30 });
  assert.equal(loadMailboxes(env([box({ port: 587 })]))[0].secure, false);
  assert.equal(loadMailboxes(env([box({ port: 587, secure: true })]))[0].secure, true);
});

test('límite diario: el del buzón manda; si no, COLD_DAILY_LIMIT; si no, 30', () => {
  assert.equal(loadMailboxes(env([box({ dailyLimit: 10 })]))[0].dailyLimit, 10);
  assert.equal(loadMailboxes(env([box()], { COLD_DAILY_LIMIT: '12' }))[0].dailyLimit, 12);
  assert.equal(loadMailboxes(env([box()]))[0].dailyLimit, 30);
});

test('varios buzones', () => {
  const list = loadMailboxes(env([box({ id: 'a' }), box({ id: 'b', user: 'x@d2.com', from: 'Jose <x@d2.com>' })]));
  assert.deepEqual(list.map(m => m.id), ['a', 'b']);
});

test('errores de configuración claros y SIN filtrar la contraseña', () => {
  const bad = (list, re) => assert.throws(() => loadMailboxes(env(list)), (e) => re.test(e.message) && !e.message.includes('app-pass-secreto'));
  assert.throws(() => loadMailboxes({ COLD_MAILBOXES: '{no es json' }), /no es un JSON válido/);
  bad({}, /al menos un buzón/);
  bad([], /al menos un buzón/);
  bad([box({ id: '' })], /"id" obligatorio/);
  bad([box({ id: 'con espacios' })], /"id" obligatorio/);
  bad([box({ id: 'a' }), box({ id: 'a' })], /id repetido/);
  bad([box({ host: '' })], /falta "host"/);
  bad([box({ pass: '' })], /falta "pass"/);
  bad([box({ user: undefined })], /falta "user"/);
  bad([box({ from: undefined })], /falta "from"/);
  bad([box({ from: 'Jose sin email' })], /"from" debe contener un email/);
  bad([box({ port: 'abc' })], /"port" no válido/);
  bad([box({ port: 99999 })], /"port" no válido/);
  bad([box({ dailyLimit: 0 })], /"dailyLimit"/);
  bad([box({ dailyLimit: 2.5 })], /"dailyLimit"/);
  bad(['texto'], /debe ser un objeto/);
});

test('mailboxesForCycle: en dry-run sin buzones hay uno virtual; en real, ninguno', () => {
  const [v] = mailboxesForCycle({}, { dryRun: true });
  assert.equal(v.id, 'dry-run');
  assert.equal(v.dailyLimit, 30);
  assert.deepEqual(mailboxesForCycle({}, { dryRun: false }), []);
  assert.equal(mailboxesForCycle(env([box()]), { dryRun: true })[0].id, 'jose1');      // con buzones reales se usan (sin enviar)
});

test('describeMailbox no incluye credenciales', () => {
  const d = describeMailbox(loadMailboxes(env([box()]))[0]);
  assert.deepEqual(Object.keys(d).sort(), ['dailyLimit', 'from', 'id']);
});

// ─── classifySmtpError ───────────────────────────────────────────────────────
const smtp = (o) => Object.assign(new Error(o.message || 'smtp error'), o);

test('rebote de DESTINATARIO (buzón inexistente) → "bounce"', () => {
  assert.equal(classifySmtpError(smtp({ responseCode: 550, response: '550-5.1.1 The email account that you tried to reach does not exist' })), 'bounce');
  assert.equal(classifySmtpError(smtp({ responseCode: 550, response: '550 User unknown' })), 'bounce');
  assert.equal(classifySmtpError(smtp({ responseCode: 553, response: '553 5.1.3 The recipient address is not a valid RFC-5321 address' })), 'bounce');
  assert.equal(classifySmtpError(smtp({ code: 'EENVELOPE', responseCode: 550, response: '550 Requested action not taken', rejected: ['x@y.com'] })), 'bounce');
  assert.equal(classifySmtpError(smtp({ responseCode: 550, response: '550 5.7.1 Recipient address rejected: User unknown in virtual mailbox table' })), 'bounce');
});

test('problema NUESTRO (login, remitente bloqueado, spam, política) → "mailbox": nunca quema un lead', () => {
  assert.equal(classifySmtpError(smtp({ code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Username and Password not accepted' })), 'mailbox');
  assert.equal(classifySmtpError(smtp({ responseCode: 550, response: '550 5.7.1 Message rejected as spam by our filters' })), 'mailbox');
  assert.equal(classifySmtpError(smtp({ responseCode: 554, response: '554 5.7.1 Service unavailable; Client host blocked using Spamhaus' })), 'mailbox');
  assert.equal(classifySmtpError(smtp({ responseCode: 550, response: '550 5.7.26 Unauthenticated sender: SPF/DKIM policy' })), 'mailbox');
  assert.equal(classifySmtpError(smtp({ responseCode: 554, response: '554 Transaction failed' })), 'mailbox');     // permanente desconocido: por seguridad no descarta el lead
  assert.equal(classifySmtpError(smtp({ responseCode: 550, response: '550 5.4.5 Daily sending quota exceeded' })), 'mailbox');
});

test('errores temporales → "transient"', () => {
  for (const e of [smtp({ responseCode: 421, response: '421 4.7.0 Try again later' }), smtp({ responseCode: 450 }), smtp({ code: 'ETIMEDOUT' }),
    smtp({ code: 'ECONNECTION' }), smtp({ code: 'ECONNRESET' }), smtp({ code: 'ESOCKET' }), smtp({ message: 'algo raro sin código' })]) {
    assert.equal(classifySmtpError(e), 'transient');
  }
});

// ─── createMailer (transporte falso) ─────────────────────────────────────────
function fakeTransport(behaviour = () => ({ messageId: '<abc@dominio1.com>' })) {
  const created = [], sent = [];
  const transportFactory = (opts) => {
    created.push(opts);
    return { sendMail: async (m) => { sent.push(m); return behaviour(m); }, close() { this.closed = true; } };
  };
  return { transportFactory, created, sent };
}

test('envío real: usa el buzón, manda cabeceras de baja e hilo, y devuelve el Message-ID', async () => {
  const t = fakeTransport();
  const mailer = createMailer({ transportFactory: t.transportFactory, dryRun: false });
  const [mb] = loadMailboxes(env([box()]));
  const res = await mailer.send(mb, {
    to: 'dueno@gmail.com', subject: 'Re: Hola', text: 'texto', html: '<p>html</p>',
    headers: { 'List-Unsubscribe': '<https://x/u/1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    inReplyTo: '<first@dominio1.com>', references: '<first@dominio1.com>',
  });
  assert.deepEqual(res, { messageId: '<abc@dominio1.com>', dryRun: false });
  assert.deepEqual(t.created[0].auth, { user: 'jose@dominio1.com', pass: 'app-pass-secreto' });
  assert.equal(t.created[0].host, 'smtp.gmail.com');
  assert.equal(t.created[0].secure, true);
  assert.ok(t.created[0].connectionTimeout > 0 && t.created[0].socketTimeout > 0, 'con tiempos límite');
  const m = t.sent[0];
  assert.deepEqual([m.from, m.replyTo, m.to, m.subject], ['Jose <jose@dominio1.com>', 'Jose <jose@dominio1.com>', 'dueno@gmail.com', 'Re: Hola']);
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(m.inReplyTo, '<first@dominio1.com>');
  assert.equal(m.references, '<first@dominio1.com>');
});

test('un transporte por buzón, reutilizado entre envíos; close() los cierra', async () => {
  const t = fakeTransport();
  const mailer = createMailer({ transportFactory: t.transportFactory, dryRun: false });
  const [a, b] = loadMailboxes(env([box({ id: 'a' }), box({ id: 'b' })]));
  await mailer.send(a, { to: 'x@y.com', subject: 's', text: 't' });
  await mailer.send(a, { to: 'x@y.com', subject: 's', text: 't' });
  await mailer.send(b, { to: 'x@y.com', subject: 's', text: 't' });
  assert.equal(t.created.length, 2);
  mailer.close();
  await mailer.send(a, { to: 'x@y.com', subject: 's', text: 't' });
  assert.equal(t.created.length, 3);                       // tras close se vuelve a crear
});

test('los errores SMTP salen con "kind" (bounce / mailbox / transient)', async () => {
  const [mb] = loadMailboxes(env([box()]));
  for (const [err, kind] of [
    [smtp({ responseCode: 550, response: '550 5.1.1 user unknown' }), 'bounce'],
    [smtp({ code: 'EAUTH', responseCode: 535 }), 'mailbox'],
    [smtp({ code: 'ETIMEDOUT' }), 'transient'],
  ]) {
    const t = fakeTransport(() => { throw err; });
    const mailer = createMailer({ transportFactory: t.transportFactory, dryRun: false });
    await assert.rejects(() => mailer.send(mb, { to: 'x@y.com', subject: 's', text: 't' }), (e) => e.kind === kind);
  }
});

test('dry-run: no crea transporte ni envía; devuelve un Message-ID reconocible y lo escribe en el log', async () => {
  const t = fakeTransport();
  const mailer = createMailer({ transportFactory: t.transportFactory, dryRun: true });
  const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  let res;
  try { res = await mailer.send({ id: 'dry-run' }, { to: 'dueno@gmail.com', subject: 'Asunto X', text: 'cuerpo' }); } finally { console.log = orig; }
  assert.equal(t.created.length, 0);
  assert.equal(res.dryRun, true);
  assert.ok(res.messageId.startsWith(DRY_RUN_ID_PREFIX) && res.messageId.endsWith('@dry-run.local>'));
  assert.ok(lines[0].startsWith('[dry-run] email {') && lines[0].includes('"to":"dueno@gmail.com"') && lines[0].includes('"subject":"Asunto X"'));
});

// ─── Pausas ──────────────────────────────────────────────────────────────────
test('pauseRangeMs: por defecto 45–150 s; configurable; valida', () => {
  assert.deepEqual(pauseRangeMs({}), [45_000, 150_000]);
  assert.deepEqual(pauseRangeMs({ COLD_PAUSE_MIN_SEC: '10', COLD_PAUSE_MAX_SEC: '20' }), [10_000, 20_000]);
  assert.deepEqual(pauseRangeMs({ COLD_PAUSE_MIN_SEC: '0', COLD_PAUSE_MAX_SEC: '0' }), [0, 0]);
  assert.throws(() => pauseRangeMs({ COLD_PAUSE_MIN_SEC: '100', COLD_PAUSE_MAX_SEC: '50' }), /no son válidos/);
  assert.throws(() => pauseRangeMs({ COLD_PAUSE_MIN_SEC: 'abc' }), /no son válidos/);
});

test('randomBetween: incluye ambos extremos', () => {
  assert.equal(randomBetween(45_000, 150_000, () => 0), 45_000);
  assert.equal(randomBetween(45_000, 150_000, () => 0.999999999), 150_000);
  const v = randomBetween(45_000, 150_000);
  assert.ok(v >= 45_000 && v <= 150_000);
});

// ─── campaignConfig ──────────────────────────────────────────────────────────
const goodEnv = { BASE_URL: 'https://app.example.com/', COMPANY_NAME: 'Eternity Strategy', COMPANY_ADDRESS: '1 Main St, Hartford, CT', OUTREACH_SENDER_NAME: 'Jose' };

test('config real completa: URL sin barra final, enlaces de formulario y baja', () => {
  const c = loadCampaignConfig(goodEnv, { dryRun: false });
  assert.equal(c.baseUrl, 'https://app.example.com');
  assert.equal(formUrl(c, 'TOK'), 'https://app.example.com/f/TOK');
  assert.equal(unsubscribeUrl(c, 'TOK'), 'https://app.example.com/u/TOK');
  assert.equal(c.senderName, 'Jose');
});

test('config real: se niega a enviar sin empresa, dirección postal o URL pública https', () => {
  assert.throws(() => loadCampaignConfig({ ...goodEnv, COMPANY_NAME: '' }, { dryRun: false }), /COMPANY_NAME/);
  assert.throws(() => loadCampaignConfig({ ...goodEnv, COMPANY_ADDRESS: '  ' }, { dryRun: false }), /COMPANY_ADDRESS/);
  for (const url of ['', 'http://localhost:3001', 'https://localhost', 'http://127.0.0.1:3001', 'http://app.example.com', 'https://0.0.0.0']) {
    assert.throws(() => loadCampaignConfig({ ...goodEnv, BASE_URL: url }, { dryRun: false }), /BASE_URL/, url);
  }
});

test('config en dry-run: usa marcadores y lista lo que faltaría', () => {
  const c = loadCampaignConfig({ BASE_URL: 'http://localhost:3001' }, { dryRun: true });
  assert.equal(c.baseUrl, 'http://localhost:3001');
  assert.equal(c.companyName, '[COMPANY_NAME]');
  assert.equal(c.warnings.length, 3);
  assert.equal(c.senderName, 'Jose');
});
