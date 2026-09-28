// A lead asking for a call from the page behind the link in the email (routes/leadLink.js): what they type is validated
// here and saved on their lead. The consent to be called is stored with it (exact wording, moment and IP) as proof.
const TABLE = 'new_business_leads';

// What the "when" menu offers. The text itself is what gets saved and shown in the dashboard and in the Telegram alert.
export const PREFERRED_TIMES = ['Lo antes posible', 'Hoy, más tarde', 'Mañana por la mañana', 'Mañana por la tarde'];

export const CONSENT_TEXT = 'Acepto que Eternity Strategy me llame por teléfono al número indicado para enseñarme la web. Puedo pedir que no me contacten más.';

// A lead moves to "requested" from any of these. A lead that already asked only gets its details refreshed.
export const REQUESTABLE = ['new', 'queued', 'emailed', 'engaged', 'replied'];

// US numbers in any format ((860) 555-0100, 860.555.0100, +1 860 555 0100) → "+18605550100".
// Other countries need the "+" and their country code. Anything else → null.
export function normalizePhone(raw) {
  const text = String(raw ?? '').trim();
  const digits = text.replace(/\D/g, '');
  if (text.startsWith('+') && !text.startsWith('+1')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(national) ? `+1${national}` : null;
}

// The form body → { errors, values }. `errors` is empty when it can be saved.
export function parseRequest(body = {}) {
  const errors = {};
  const phone = normalizePhone(body.phone);
  if (!phone) errors.phone = 'Revisa tu teléfono: necesito un número al que pueda llamarte (por ejemplo 860 555 0100).';
  if (body.consent !== 'on') errors.consent = 'Necesito que aceptes que te llame para poder hacerlo.';
  const name = String(body.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    errors,
    values: { phone, name: name || null, preferred_time: PREFERRED_TIMES.includes(body.when) ? body.when : PREFERRED_TIMES[0] },
  };
}

// Saves the request on the lead → 'new' (first request: alert me), 'updated' (they had already asked: details refreshed)
// or 'ignored' (the lead is past that stage or unsubscribed: nothing changes).
export async function saveRequest({ db, ownerId, lead, values, ip, now = new Date() }) {
  const stamp = now.toISOString();
  const contact = { phone: values.phone, contact_name: values.name, preferred_time: values.preferred_time, consent_at: stamp, consent_text: CONSENT_TEXT, consent_ip: ip || null, updated_at: stamp };

  if (REQUESTABLE.includes(lead.status)) {
    // The status filter makes a double submit harmless: only one of the two gets the row back
    const { data, error } = await db.from(TABLE).update({ ...contact, status: 'requested', requested_at: stamp })
      .eq('id', lead.id).eq('user_id', ownerId).in('status', REQUESTABLE).select('id');
    if (error) throw new Error(error.message);
    if (data?.length) return 'new';
  }
  const { data, error } = await db.from(TABLE).update(contact).eq('id', lead.id).eq('user_id', ownerId).eq('status', 'requested').select('id');
  if (error) throw new Error(error.message);
  return data?.length ? 'updated' : 'ignored';
}
