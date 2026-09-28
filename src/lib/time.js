// Time helpers for the new-business campaign. Everything is computed with Intl in an explicit IANA time zone,
// never with the server's local time (on Render the server runs in UTC).

export const SEND_TZ = 'America/New_York';   // when leads receive emails (Connecticut)
export const OPS_TZ = 'Europe/Madrid';       // where you are: Telegram alerts and the daily summary

// Preferred call slots from the form, as [startHour, endHour) in SEND_TZ
export const CALL_SLOTS = {
  manana: [9, 12],
  tarde: [12, 17],
  noche: [17, 20],
};

// Wall-clock parts of an instant in a time zone. weekday: 0 = Sunday … 6 = Saturday
export function zonedParts(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map(p => [p.type, p.value]),
  );
  return {
    year: +parts.year, month: +parts.month, day: +parts.day,
    hour: +parts.hour, minute: +parts.minute, second: +parts.second,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
  };
}

// Offset of `tz` from UTC at that instant, in minutes (New York in summer = -240)
function offsetMinutes(date, tz) {
  const p = zonedParts(date, tz);
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}

// The instant at which the wall clock in `tz` reads y-m-d h:mi (handles DST changes)
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMinutes(new Date(guess), tz) * 60000;
  return new Date(guess - offsetMinutes(new Date(first), tz) * 60000);
}

// Mon–Fri, [startHour, endHour) in SEND_TZ. Used to gate every cold email.
export function isSendWindow(date = new Date(), { tz = SEND_TZ, startHour = 9, endHour = 17 } = {}) {
  const { weekday, hour } = zonedParts(date, tz);
  return weekday >= 1 && weekday <= 5 && hour >= startHour && hour < endHour;
}

// Now if we are inside the send window, otherwise the next moment it opens (09:00 on the next weekday).
export function nextSendWindowStart(date = new Date(), { tz = SEND_TZ, startHour = 9, endHour = 17 } = {}) {
  if (isSendWindow(date, { tz, startHour, endHour })) return date;
  let cursor = date;
  for (let i = 0; i < 8; i++) {
    const p = zonedParts(cursor, tz);
    const opensToday = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: startHour }, tz);
    const isWeekday = p.weekday >= 1 && p.weekday <= 5;
    if (isWeekday && opensToday.getTime() > date.getTime()) return opensToday;
    cursor = new Date(cursor.getTime() + 86_400_000);   // try the next calendar day
  }
  throw new Error('nextSendWindowStart: no window found in the next 8 days');
}

// "15:00" in a time zone
export function formatClock(date, tz) {
  return new Intl.DateTimeFormat('es-ES', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

// Form slot ("manana" | "tarde" | "noche") → "15:00–18:00" in Madrid time, for the given day (DST-aware).
// `onDate` is the day the lead filled the form, read in Connecticut time.
export function slotInMadrid(slot, onDate = new Date()) {
  const range = CALL_SLOTS[slot];
  if (!range) return null;
  const { year, month, day } = zonedParts(onDate, SEND_TZ);
  const start = zonedTimeToUtc({ year, month, day, hour: range[0] }, SEND_TZ);
  const end = zonedTimeToUtc({ year, month, day, hour: range[1] }, SEND_TZ);
  return `${formatClock(start, OPS_TZ)}–${formatClock(end, OPS_TZ)}`;
}
