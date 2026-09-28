// The cold-email engine: one call to runSendCycle() (every 30 min) sends what is due, within limits.
//
//  • Only Mon–Fri 9:00–17:00 Connecticut time (src/lib/time.js).
//  • Each mailbox sends at most `dailyLimit` emails per Connecticut day, spread over the day (a per-cycle quota), with
//    random pauses between sends.
//  • A lead keeps the same mailbox for its whole sequence; follow-ups are replies in the same thread.
//  • Priority: due follow-ups → email 0 already assigned → new leads (most recently registered first).
//  • Never writes to suppressed emails (checked right before every send). A recipient bounce ends the lead; our own
//    sender problems (login, blocked/spam-flagged mailbox) never burn a lead.
//  • Every send first "claims" the lead (compare-and-set on next_send_at) so two processes can't send it twice.
//
// Lead states used here: new → queued → emailed → sequence_finished | bounced | unsubscribed
// (form_submitted and the rest are set by the form flow; a lead in any of them is never emailed again).
import { SEQUENCE_DAYS, SEQUENCE_LENGTH, renderEmail } from '../prompts/newBusinessEmails.js';
import { isSendWindow, nextSendWindowStart, zonedParts, zonedTimeToUtc, SEND_TZ } from '../lib/time.js';
import { isDryRun } from '../lib/dryRun.js';
import { getSuppressed, suppress, statusForReason } from './suppressions.js';
import { DRY_RUN_ID_PREFIX, pauseRangeMs, randomBetween } from './coldMailer.js';
import { formUrl, unsubscribeUrl } from './campaignConfig.js';

const TABLE = 'new_business_leads';
export const CYCLE_MINUTES = 30;
const LEASE_MS = 60 * 60_000;            // a claimed lead is not retried for an hour (covers a slow cycle)
const RETRY_MS = 30 * 60_000;            // temporary failure → try again on the next cycle
const MAX_FAILURES = 2;                  // consecutive failures before a mailbox is skipped for the rest of the cycle

const iso = (d) => new Date(d).toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Time ────────────────────────────────────────────────────────────────────

const localDay = (now) => zonedParts(now, SEND_TZ);
export function dayStart(now) {
  const p = localDay(now);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 0 }, SEND_TZ);
}
export function windowEnd(now, endHour = 17) {
  const p = localDay(now);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: endHour }, SEND_TZ);
}
// Cycles still to run today, counting this one (≥ 1). Daily capacity is divided by this so sends spread over the day.
export const cyclesLeft = (now) => Math.max(1, Math.ceil((windowEnd(now).getTime() - now.getTime()) / 60_000 / CYCLE_MINUTES));

// When the email number `stepAfter` is due: the gap in days from the previous one, at 9:00 Connecticut time (moved to the
// next weekday if it lands on a weekend). null when the sequence is over.
export function computeNextSendAt(sentAt, stepAfter) {
  if (stepAfter >= SEQUENCE_LENGTH) return null;
  const gap = SEQUENCE_DAYS[stepAfter] - SEQUENCE_DAYS[stepAfter - 1];
  const p = localDay(sentAt);
  const target = new Date(Date.UTC(p.year, p.month - 1, p.day + gap));
  const opens = zonedTimeToUtc({ year: target.getUTCFullYear(), month: target.getUTCMonth() + 1, day: target.getUTCDate(), hour: 9 }, SEND_TZ);
  return nextSendWindowStart(opens);
}

// ─── Database helpers ────────────────────────────────────────────────────────

const leadsOf = (db, ownerId) => db.from(TABLE).select('*').eq('user_id', ownerId);

async function query(builder, what) {
  const { data, error } = await builder;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data ?? [];
}

// Compare-and-set: only one caller wins. Returns true when THIS call changed the row.
async function claim(db, lead, patch) {
  let q = db.from(TABLE).update({ ...patch, updated_at: iso(new Date()) }).eq('id', lead.id).eq('status', lead.status);
  // PostgREST: "= null" never matches NULL, it needs IS NULL (new leads have no next_send_at yet)
  q = lead.next_send_at == null ? q.is('next_send_at', null) : q.eq('next_send_at', lead.next_send_at);
  const { data, error } = await q.select('id');
  if (error) throw new Error(`reservar lead: ${error.message}`);
  return (data?.length ?? 0) === 1;
}

// The email is already out: if the bookkeeping fails, retry a few times and shout (a missing update = a duplicate later)
async function updateLead(db, id, patch, log, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const { error } = await db.from(TABLE).update({ ...patch, updated_at: iso(new Date()) }).eq('id', id);
    if (!error) return true;
    if (attempt === tries) log(`[campaign] ✗ ERROR guardando el lead ${id} tras enviar: ${error.message}. Revísalo a mano para que no se duplique el envío.`);
  }
  return false;
}

// Leads that a DRY-RUN cycle marked as "emailed" were never really emailed: put them back so real follow-ups
// can't go out as replies to an email that doesn't exist. Recognised by the dry-run Message-ID.
export async function resetDryRunLeads(db, ownerId) {
  const { data, error } = await db.from(TABLE).update({
    status: 'new', sequence_step: 0, next_send_at: null, last_sent_at: null, mailbox: null, first_message_id: null, first_subject: null,
    updated_at: iso(new Date()),
  }).eq('user_id', ownerId).like('first_message_id', `${DRY_RUN_ID_PREFIX}%`).in('status', ['queued', 'emailed', 'sequence_finished']).select('id');
  if (error) throw new Error(`limpiar leads de dry-run: ${error.message}`);
  return data?.length ?? 0;
}

// ─── The cycle ───────────────────────────────────────────────────────────────

// Options:
//   db, ownerId, mailboxes (see coldMailer.loadMailboxes), mailer ({ send(mailbox, message) }), config (campaignConfig)
//   now       the moment to run as (default: now) — lets you simulate any day/hour
//   dryRun    default OUTREACH_DRY_RUN; only affects pauses and the cleanup of dry-run leftovers (the mailer decides not to send)
//   limit     send at most N emails in this cycle
//   render, pause, log   injectable for tests
export async function runSendCycle({
  db, ownerId, mailboxes, mailer, config, now = new Date(), dryRun = isDryRun(), limit = null,
  render = renderEmail, log = console.log,
  pause = async () => { if (!dryRun) { const [min, max] = pauseRangeMs(); await sleep(randomBetween(min, max)); } },
}) {
  const nowIso = iso(now);
  const summary = { skipped: null, dryRun, now: nowIso, sent: 0, bounced: 0, suppressed: 0, errors: 0, deferred: 0, released: 0, orphaned: 0, mailboxes: {}, results: [] };

  if (!mailboxes?.length) return { ...summary, skipped: 'no_mailboxes' };
  if (!dryRun) {
    const reset = await resetDryRunLeads(db, ownerId);
    if (reset) log(`[campaign] ${reset} lead(s) marcados por una prueba (dry-run) vuelven a "new": nunca se les envió nada real`);
  }
  if (!isSendWindow(now)) return { ...summary, skipped: 'outside_window' };

  // 1. Capacity: each mailbox's remaining daily allowance, and how much of it this cycle may use
  const left = cyclesLeft(now);
  const startIso = iso(dayStart(now));
  const state = new Map();
  for (const mb of mailboxes) {
    const sentToday = (await query(db.from(TABLE).select('id').eq('user_id', ownerId).eq('mailbox', mb.id).gte('last_sent_at', startIso), 'contar envíos de hoy')).length;
    const remaining = Math.max(0, mb.dailyLimit - sentToday);
    state.set(mb.id, { mb, sentToday, remaining, quota: Math.min(remaining, Math.ceil(remaining / left)), jobs: [], sent: 0, failures: 0, stopped: false });
  }

  // 2. Work, in priority order. Leads already emailed today wait for tomorrow.
  const notToday = (l) => !(l.last_sent_at && Date.parse(l.last_sent_at) >= Date.parse(startIso));
  const due = (await query(leadsOf(db, ownerId).eq('status', 'emailed').lte('next_send_at', nowIso).order('next_send_at', { ascending: true }).limit(1000), 'cargar seguimientos')).filter(notToday);
  const queued = (await query(leadsOf(db, ownerId).eq('status', 'queued').lte('next_send_at', nowIso).order('next_send_at', { ascending: true }).limit(1000), 'cargar cola')).filter(notToday);

  const enqueue = async (lead, kind) => {
    const s = state.get(lead.mailbox);
    if (!s) {                                            // its mailbox is no longer configured
      if (kind === 'first') {                            // never emailed yet → any mailbox can take it
        await updateLead(db, lead.id, { status: 'new', mailbox: null, next_send_at: null }, log);
        summary.released++;
      } else {                                           // a follow-up must stay in its thread/mailbox
        log(`[campaign] ⚠ el lead ${lead.id} sigue su secuencia en el buzón "${lead.mailbox}", que ya no está en COLD_MAILBOXES: no se puede continuar`);
        summary.orphaned++;
      }
      return;
    }
    if (s.jobs.length < s.quota) s.jobs.push({ lead, kind }); else summary.deferred++;
  };
  for (const lead of due) await enqueue(lead, 'followup');
  for (const lead of queued) await enqueue(lead, 'first');

  // 3. New leads (newest registration first) go to the mailbox with the most room left
  const room = () => [...state.values()].reduce((n, s) => n + (s.quota - s.jobs.length), 0);
  if (room() > 0) {
    const fresh = await query(leadsOf(db, ownerId).eq('status', 'new').order('registered_at', { ascending: false }).limit(room()), 'cargar leads nuevos');
    for (const lead of fresh) {
      const s = [...state.values()].filter(x => x.quota - x.jobs.length > 0).sort((a, b) => (b.quota - b.jobs.length) - (a.quota - a.jobs.length))[0];
      if (!s) break;
      const queuedLead = { ...lead, status: 'queued', mailbox: s.mb.id, next_send_at: nowIso };
      if (await claim(db, lead, { status: 'queued', mailbox: s.mb.id, next_send_at: nowIso })) s.jobs.push({ lead: queuedLead, kind: 'first' });
    }
  }

  // 4. Send. Mailboxes work in parallel; inside a mailbox, one at a time with random pauses.
  let budget = limit ?? Infinity;
  await Promise.all([...state.values()].map(async (s) => {
    for (let i = 0; i < s.jobs.length && !s.stopped && budget > 0; i++) {
      const outcome = await processJob(s.jobs[i], s);
      summary.results.push({ lead_id: s.jobs[i].lead.id, name: s.jobs[i].lead.name, step: s.jobs[i].lead.sequence_step, mailbox: s.mb.id, outcome });
      if (outcome === 'sent') { s.sent++; summary.sent++; budget--; if (i < s.jobs.length - 1 && budget > 0 && !s.stopped) await pause(); }
      else if (outcome === 'bounced') summary.bounced++;
      else if (outcome === 'suppressed') summary.suppressed++;
      else if (outcome !== 'contended') summary.errors++;
    }
  }));

  for (const s of state.values()) {
    summary.mailboxes[s.mb.id] = { dailyLimit: s.mb.dailyLimit, sentBefore: s.sentToday, quota: s.quota, sent: s.sent, stopped: s.stopped };
  }
  return summary;

  // ── one lead, one email ──
  async function processJob({ lead, kind }, s) {
    const step = lead.sequence_step;
    const label = `"${lead.name}" (${lead.id})`;
    try {
      if (step >= SEQUENCE_LENGTH) {                     // safety: nothing left to send
        await updateLead(db, lead.id, { status: 'sequence_finished', next_send_at: null }, log);
        return 'contended';
      }

      // Suppressed since it was queued (unsubscribe / bounce while waiting)?
      const suppressed = await getSuppressed(db, ownerId, [lead.email]);
      if (suppressed.has(lead.email)) {
        await updateLead(db, lead.id, { status: statusForReason(suppressed.get(lead.email)), next_send_at: null }, log);
        log(`[campaign] – ${label}: email suprimido (${suppressed.get(lead.email)}), no se envía`);
        return 'suppressed';
      }

      // Reserve it (lease) so nobody else sends it meanwhile
      if (!(await claim(db, lead, { next_send_at: iso(now.getTime() + LEASE_MS) }))) return 'contended';
      const failed = (patch) => updateLead(db, lead.id, patch, log);   // release helper

      let rendered;
      const fUrl = formUrl(config, lead.form_token);
      const uUrl = unsubscribeUrl(config, lead.form_token);
      try {
        rendered = render(lead, step, { formUrl: fUrl, unsubUrl: uUrl, senderName: config.senderName, companyName: config.companyName, companyAddress: config.companyAddress, now });
      } catch (err) {
        await failed({ next_send_at: iso(now.getTime() + RETRY_MS) });
        log(`[campaign] ✗ ${label}: no se pudo generar el email: ${err.message}`);
        return 'error';
      }

      const message = {
        to: lead.email, subject: rendered.subject, text: rendered.text, html: rendered.html,
        headers: { 'List-Unsubscribe': `<${uUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        ...(step > 0 && lead.first_message_id ? { inReplyTo: lead.first_message_id, references: lead.first_message_id } : {}),
      };

      try {
        const res = await mailer.send(s.mb, message);
        s.failures = 0;
        const nextDue = computeNextSendAt(now, step + 1);
        await updateLead(db, lead.id, {
          sequence_step: step + 1,
          last_sent_at: nowIso,
          mailbox: s.mb.id,
          status: nextDue ? 'emailed' : 'sequence_finished',
          next_send_at: nextDue ? iso(nextDue) : null,
          ...(step === 0 ? { first_message_id: res.messageId, first_subject: rendered.subject } : {}),
        }, log);
        log(`[campaign] ✓ email ${step + 1}/${SEQUENCE_LENGTH} → ${label} · buzón ${s.mb.id}${res.dryRun ? ' · DRY-RUN' : ''}`);
        return 'sent';
      } catch (err) {
        const kindOfError = err.kind || 'transient';
        if (kindOfError === 'bounce') {
          await failed({ status: 'bounced', next_send_at: null });
          await suppress(db, ownerId, lead.email, 'bounced').catch(e => log(`[campaign] ✗ no se pudo guardar la supresión de ${lead.email}: ${e.message}`));
          log(`[campaign] ✗ ${label}: rebote permanente (${err.responseCode ?? err.code ?? 'SMTP'}) → bounced + supresión`);
          return 'bounced';
        }
        s.failures++;
        if (s.failures >= MAX_FAILURES) { s.stopped = true; log(`[campaign] ⚠ buzón ${s.mb.id} pausado en este ciclo tras ${s.failures} fallos seguidos`); }
        if (kindOfError === 'mailbox') {
          // Our problem, not the lead's: an unsent first email goes back to the pool for another mailbox
          await failed(kind === 'first' ? { status: 'new', mailbox: null, next_send_at: null } : { next_send_at: iso(now.getTime() + RETRY_MS) });
          log(`[campaign] ✗ ${label}: problema del buzón ${s.mb.id} (${err.responseCode ?? err.code ?? ''} ${String(err.message).slice(0, 120)}): el lead NO se descarta`);
          return 'mailbox_error';
        }
        await failed({ next_send_at: iso(now.getTime() + RETRY_MS) });
        log(`[campaign] ✗ ${label}: fallo temporal, se reintenta más tarde (${err.code ?? err.responseCode ?? ''} ${String(err.message).slice(0, 120)})`);
        return 'transient';
      }
    } catch (err) {
      log(`[campaign] ✗ ${label}: ${err.message}`);
      return 'error';
    }
  }
}
