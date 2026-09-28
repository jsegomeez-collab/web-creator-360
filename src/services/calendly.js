// Calendly (your booking page). Opening the link in the email is not booking a call: a lead counts as "booked" only when
// Calendly has an active event for them. Calendly's free plan has no webhooks, but its API is open to every plan, so we ask
// it every few minutes (or from the dashboard) which calls were booked recently.
//   GET /users/me                          → our own user
//   GET /scheduled_events?user=…           → recent and upcoming calls
//   GET /scheduled_events/:uuid/invitees   → who booked, with the utm_content of the link they came from
// The link in each email carries the lead's token as utm_content (see routes/calendarLink.js), so the booking finds its
// lead even if they book with another email address; the invitee's email is the fallback.
import { requestJson } from '../lib/http.js';
import { chunks, LINK_TOKEN_RE } from './newLeads.js';

export const API = 'https://api.calendly.com';
const TABLE = 'new_business_leads';
const LOOKBACK_DAYS = 3;                       // calls that started up to 3 days ago are still looked at (server down, weekend…)
const PAGE_SIZE = 100;
const MAX_PAGES = 2;
const PHONE_QUESTION = /tel[eé]fono|phone|m[oó]vil|celular/i;

// A lead moves to "booked" from any of these; a lead already booked only has its call time refreshed (rescheduled call)
export const BOOKABLE = ['new', 'queued', 'emailed', 'engaged', 'replied'];

export function loadCalendlyConfig(env = process.env) {
  const token = String(env.CALENDLY_API_TOKEN || '').trim();
  if (!token) throw new Error('Falta CALENDLY_API_TOKEN en tu .env (Calendly → Integraciones → API y webhooks → Personal access token)');
  return { token };
}

export function isCalendlyConfigured(env = process.env) {
  try { loadCalendlyConfig(env); return true; } catch { return false; }
}

const get = (config, url, { fetchImpl, sleep } = {}) => requestJson({
  service: 'Calendly', url, headers: { Authorization: `Bearer ${config.token}` }, fetchImpl, sleep, hint401: '(¿CALENDLY_API_TOKEN correcto?)',
});

// The phone the lead typed in the booking form (SMS reminders field, or a question that asks for it)
export function phoneOf(invitee) {
  const answer = (invitee.questions_and_answers || []).find(q => PHONE_QUESTION.test(q.question || '') && String(q.answer || '').trim());
  return String(invitee.text_reminder_number || answer?.answer || '').trim() || null;
}

async function listRecentEvents(config, since, opts) {
  const me = await get(config, `${API}/users/me`, opts);
  const events = [];
  let url = `${API}/scheduled_events?${new URLSearchParams({ user: me.resource.uri, min_start_time: since.toISOString(), status: 'active', sort: 'start_time:asc', count: String(PAGE_SIZE) })}`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const r = await get(config, url, opts);
    events.push(...(r.collection || []));
    url = r.pagination?.next_page || null;
  }
  return events;
}

async function listBookings(config, events, opts) {
  const bookings = [];
  for (const event of events) {
    const r = await get(config, `${event.uri}/invitees?${new URLSearchParams({ status: 'active', count: String(PAGE_SIZE) })}`, opts);
    for (const inv of r.collection || []) {
      bookings.push({
        eventUri: event.uri,
        startTime: event.start_time,
        bookedAt: inv.created_at || event.created_at || null,
        email: String(inv.email || '').trim().toLowerCase(),
        name: inv.name || null,
        phone: phoneOf(inv),
        token: inv.tracking?.utm_content || null,
      });
    }
  }
  return bookings;
}

async function findLeads(db, ownerId, bookings) {
  const tokens = [...new Set(bookings.map(b => b.token).filter(t => LINK_TOKEN_RE.test(t || '')))];
  const emails = [...new Set(bookings.map(b => b.email).filter(Boolean))];
  const byToken = new Map(), byEmail = new Map();
  for (const [column, values, into] of [['link_token', tokens, byToken], ['email', emails, byEmail]]) {
    for (const part of chunks(values)) {
      const { data, error } = await db.from(TABLE).select('*').eq('user_id', ownerId).in(column, part);
      if (error) throw new Error(`buscar leads: ${error.message}`);
      for (const lead of data || []) into.set(lead[column], lead);
    }
  }
  return { byToken, byEmail };
}

// One booking per lead: the soonest call that hasn't happened yet, otherwise the latest one that has
function pickBooking(list, now) {
  const upcoming = list.filter(b => Date.parse(b.startTime) >= now.getTime()).sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  return upcoming[0] ?? [...list].sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))[0];
}

const validIso = (v, fallback) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fallback);

// Looks at Calendly and updates the leads that booked a call. Returns { events, bookings, booked, rescheduled, unmatched }.
//   onBooked(lead, booking)  called once for each lead that just became "booked" (a failure there never breaks the sync)
export async function syncBookings({ db, ownerId, config, fetchImpl, sleep, now = new Date(), onBooked = null }) {
  const opts = { fetchImpl, sleep };
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
  const events = await listRecentEvents(config, since, opts);
  const bookings = await listBookings(config, events, opts);
  const { byToken, byEmail } = await findLeads(db, ownerId, bookings);

  const perLead = new Map();
  let unmatched = 0;
  for (const b of bookings) {
    const lead = byToken.get(b.token) ?? byEmail.get(b.email);
    if (!lead) { unmatched++; continue; }
    perLead.set(lead.id, { lead, list: [...(perLead.get(lead.id)?.list ?? []), b] });
  }

  const stamp = now.toISOString();
  const booked = [];
  let rescheduled = 0;
  for (const { lead, list } of perLead.values()) {
    const booking = pickBooking(list, now);
    const callAt = validIso(booking.startTime, null);

    if (BOOKABLE.includes(lead.status)) {
      // The status filter makes a second sync running at the same time a no-op: only one of them gets the row back
      const { data, error } = await db.from(TABLE).update({ status: 'booked', booked_at: validIso(booking.bookedAt, stamp), call_at: callAt, updated_at: stamp })
        .eq('id', lead.id).in('status', BOOKABLE).select('id');
      if (error) throw new Error(`guardar reserva: ${error.message}`);
      if (data?.length) booked.push({ lead, booking });
    } else if (lead.status === 'booked' && callAt && Date.parse(lead.call_at || '') !== Date.parse(callAt)) {
      const { error } = await db.from(TABLE).update({ call_at: callAt, updated_at: stamp }).eq('id', lead.id).eq('status', 'booked');
      if (error) throw new Error(`guardar reserva: ${error.message}`);
      rescheduled++;
    }
  }

  for (const { lead, booking } of booked) {
    if (!onBooked) break;
    try { await onBooked({ ...lead, status: 'booked' }, booking); } catch (err) { console.error('[calendly] onBooked failed:', err.message); }
  }
  return { events: events.length, bookings: bookings.length, booked: booked.length, rescheduled, unmatched };
}
