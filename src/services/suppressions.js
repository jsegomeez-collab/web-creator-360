// email_suppressions: addresses we must never write to again (unsubscribes, bounces, …), whatever the source of the lead.
// Per user (multi-tenant). Emails are always compared in lowercase.

export const normEmail = (email) => String(email ?? '').trim().toLowerCase();

// Map(email → reason) for the given emails.
// Cold email path: fails CLOSED (throws) — if we can't tell, we don't send. The legacy flow passes failOpen.
export async function getSuppressed(db, ownerId, emails, { failOpen = false } = {}) {
  const list = [...new Set(emails.map(normEmail).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < list.length; i += 150) {
    const { data, error } = await db.from('email_suppressions').select('email, reason').eq('user_id', ownerId).in('email', list.slice(i, i + 150));
    if (error) {
      if (failOpen) { console.warn(`[suppressions] no se pudo consultar (${error.message}); se continúa sin filtrar`); return out; }
      throw new Error(`consultar supresiones: ${error.message}`);
    }
    (data || []).forEach(r => out.set(r.email, r.reason));
  }
  return out;
}

// → reason string if suppressed, otherwise null
export async function suppressionReason(db, ownerId, email, opts) {
  const map = await getSuppressed(db, ownerId, [email], opts);
  return map.get(normEmail(email)) ?? null;
}

export async function suppress(db, ownerId, email, reason) {
  const { error } = await db.from('email_suppressions').upsert({ user_id: ownerId, email: normEmail(email), reason }, { onConflict: 'user_id,email' });
  if (error) throw new Error(`guardar supresión: ${error.message}`);
}

// Which lead status a suppression reason maps to
export const statusForReason = (reason) => (reason === 'bounced' ? 'bounced' : reason === 'invalid_email' ? 'invalid_email' : 'unsubscribed');
