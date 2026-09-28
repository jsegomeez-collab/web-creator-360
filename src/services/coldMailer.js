// Cold-email sending over SMTP with several mailboxes (Google Workspace on secondary domains). Resend is NOT used for
// this flow: it stays for transactional email only.
//
// COLD_MAILBOXES (JSON array in .env, one line):
//   [{"id":"jose1","host":"smtp.gmail.com","port":465,"user":"jose@dominio1.com","pass":"app-password",
//     "from":"Jose <jose@dominio1.com>","dailyLimit":30}, {...}]
import { randomBytes } from 'crypto';
import nodemailer from 'nodemailer';
import { isDryRun, dryRunLog } from '../lib/dryRun.js';

export const DEFAULT_DAILY_LIMIT = 30;
// Message-IDs generated in dry-run start with this: a real cycle recognises and resets leads "emailed" by a dry-run
export const DRY_RUN_ID_PREFIX = '<dry-run-';

// ─── Mailboxes ───────────────────────────────────────────────────────────────

// Parses COLD_MAILBOXES. Returns [] when it isn't set. Never puts a password in an error message.
export function loadMailboxes(env = process.env) {
  const raw = String(env.COLD_MAILBOXES || '').trim();
  if (!raw) return [];

  let list;
  try { list = JSON.parse(raw); } catch (err) { throw new Error(`COLD_MAILBOXES no es un JSON válido (${err.message})`); }
  if (!Array.isArray(list) || !list.length) throw new Error('COLD_MAILBOXES debe ser una lista con al menos un buzón');

  const defaultLimit = Number(env.COLD_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT;
  const seen = new Set();
  return list.map((m, i) => {
    const where = `COLD_MAILBOXES[${i}]${m?.id ? ` (${m.id})` : ''}`;
    if (!m || typeof m !== 'object') throw new Error(`${where}: debe ser un objeto`);
    if (!/^[a-z0-9_-]{1,40}$/i.test(m.id || '')) throw new Error(`${where}: "id" obligatorio (letras, números, - o _)`);
    if (seen.has(m.id)) throw new Error(`${where}: id repetido`);
    seen.add(m.id);
    for (const key of ['host', 'user', 'pass', 'from']) if (!String(m[key] || '').trim()) throw new Error(`${where}: falta "${key}"`);
    const port = Number(m.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${where}: "port" no válido`);
    if (!/[^\s<]+@[^\s>]+/.test(m.from)) throw new Error(`${where}: "from" debe contener un email`);
    const dailyLimit = m.dailyLimit === undefined ? defaultLimit : Number(m.dailyLimit);
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1) throw new Error(`${where}: "dailyLimit" debe ser un entero ≥ 1`);
    return { id: m.id, host: m.host.trim(), port, secure: m.secure ?? port === 465, user: m.user.trim(), pass: m.pass, from: m.from.trim(), dailyLimit };
  });
}

// Mailboxes for a cycle. In dry-run with none configured, one virtual mailbox lets the whole cycle run.
export function mailboxesForCycle(env = process.env, { dryRun = isDryRun() } = {}) {
  const configured = loadMailboxes(env);
  if (configured.length || !dryRun) return configured;
  return [{ id: 'dry-run', host: 'dry-run.local', port: 465, secure: true, user: 'dry-run', pass: '', from: 'Dry Run <dry-run@example.com>', dailyLimit: Number(env.COLD_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT }];
}

// Safe to log (no credentials)
export const describeMailbox = (m) => ({ id: m.id, from: m.from, dailyLimit: m.dailyLimit });

// ─── Errors ──────────────────────────────────────────────────────────────────

const RECIPIENT_PROBLEM = /5\.1\.\d+|5\.5\.0|user unknown|unknown user|no such (user|recipient|mailbox)|does not exist|invalid (recipient|address|mailbox)|recipient (address )?rejected|unknown recipient|address rejected|mailbox (unavailable|not found)|account (has been )?(disabled|closed|suspended)/i;
const SENDER_PROBLEM = /5\.7\.\d+|spam|blocked|blacklist|denied|policy|authenticat|relay|reputation/i;
const NETWORK_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'ECONNREFUSED', 'EDNS', 'ENOTFOUND']);

// 'bounce'    the RECIPIENT address is bad (permanent) → the lead goes to "bounced" and its email to suppressions
// 'mailbox'   OUR side is the problem (login, blocked/spam-flagged sender, policy, unknown permanent error) → the lead is NOT
//             burned; that mailbox is skipped for the rest of the cycle
// 'transient' temporary (4xx, network) → retry on a later cycle
export function classifySmtpError(err) {
  const code = Number(err?.responseCode);
  const text = `${err?.response || ''} ${err?.message || ''}`;
  if (err?.code === 'EAUTH') return 'mailbox';
  if (NETWORK_CODES.has(err?.code)) return 'transient';
  if (code >= 400 && code < 500) return 'transient';
  if (code >= 500) {
    if (SENDER_PROBLEM.test(text) && !RECIPIENT_PROBLEM.test(text)) return 'mailbox';
    if (err.rejected?.length || RECIPIENT_PROBLEM.test(text)) return 'bounce';
    return 'mailbox';
  }
  return 'transient';
}

// ─── Mailer ──────────────────────────────────────────────────────────────────

// message: { to, subject, text, html, headers?, inReplyTo?, references? }  →  { messageId, dryRun }
// Errors are rethrown with `err.kind` = 'bounce' | 'mailbox' | 'transient'.
export function createMailer({ transportFactory = nodemailer.createTransport, dryRun = isDryRun() } = {}) {
  const transports = new Map();
  const transportFor = (mb) => {
    if (!transports.has(mb.id)) {
      transports.set(mb.id, transportFactory({
        host: mb.host, port: mb.port, secure: mb.secure, auth: { user: mb.user, pass: mb.pass },
        connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 45_000,
      }));
    }
    return transports.get(mb.id);
  };

  return {
    async send(mb, message) {
      if (dryRun) {
        const messageId = `${DRY_RUN_ID_PREFIX}${randomBytes(6).toString('hex')}@dry-run.local>`;
        dryRunLog('email', { mailbox: mb.id, to: message.to, subject: message.subject, inReplyTo: message.inReplyTo ?? null, text: message.text });
        return { messageId, dryRun: true };
      }
      try {
        const info = await transportFor(mb).sendMail({
          from: mb.from, replyTo: mb.from,
          to: message.to, subject: message.subject, text: message.text, html: message.html,
          headers: message.headers, inReplyTo: message.inReplyTo, references: message.references,
        });
        return { messageId: info.messageId, dryRun: false };
      } catch (err) {
        err.kind = classifySmtpError(err);
        throw err;
      }
    },
    close() {
      for (const t of transports.values()) t.close?.();
      transports.clear();
    },
  };
}

// ─── Pauses between sends ────────────────────────────────────────────────────

// [minMs, maxMs] from COLD_PAUSE_MIN_SEC / COLD_PAUSE_MAX_SEC (default 45–150 s)
export function pauseRangeMs(env = process.env) {
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const min = num(env.COLD_PAUSE_MIN_SEC, 45);
  const max = num(env.COLD_PAUSE_MAX_SEC, 150);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) throw new Error('COLD_PAUSE_MIN_SEC y COLD_PAUSE_MAX_SEC no son válidos (mín ≤ máx, en segundos)');
  return [min * 1000, max * 1000];
}

export const randomBetween = (min, max, rand = Math.random) => Math.floor(min + rand() * (max - min + 1));
