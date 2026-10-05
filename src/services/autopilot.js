// On/off switch (and batch size) for the campaign server's unattended cycle: daily ingest from the CT registry + sending
// new leads to Instantly every 3 hours. One row per user; read fresh on every cron tick (see campaign-server.js), so
// toggling from the dashboard takes effect within one cycle — no redeploy.
//   demoAll: "all" mode — make the demo site of EVERY pending lead and send EVERY lead that is ready, instead of a
//            small batch (3 sites per cycle, up to pushLimit sent per send). Only matters with LEAD_DEMOS=true.
const TABLE = 'campaign_autopilot';
const DEFAULTS = { enabled: true, pushLimit: 20, demoAll: false };
// The most one send can carry in "all" mode (Instantly itself paces the actual sending with the campaign's daily limit)
export const ALL_MODE_SEND_LIMIT = 1000;

// Before the demo_all column exists (schema-new-business-leads.sql not re-run) everything works as before, with it off
const missingColumn = (err) => /column|schema cache/i.test(String(err?.message || err));

export async function getAutopilotSettings(db, ownerId) {
  let { data, error } = await db.from(TABLE).select('enabled, push_limit, demo_all').eq('user_id', ownerId).maybeSingle();
  if (error && missingColumn(error)) ({ data, error } = await db.from(TABLE).select('enabled, push_limit').eq('user_id', ownerId).maybeSingle());
  if (error) throw new Error(error.message);
  return data ? { enabled: data.enabled, pushLimit: data.push_limit, demoAll: data.demo_all === true } : { ...DEFAULTS };
}

// patch: { enabled?, pushLimit?, demoAll? } — only the given fields change; the others keep their current (or default) value.
// Always writes every column (never relies on the database's own column default, so behaviour doesn't depend on which
// database is behind `db`), so this is also the source of truth for what the row ends up as — no need to read it back.
export async function setAutopilotSettings(db, ownerId, patch) {
  const current = await getAutopilotSettings(db, ownerId);
  const next = {
    enabled: patch.enabled ?? current.enabled,
    pushLimit: patch.pushLimit ?? current.pushLimit,
    demoAll: patch.demoAll ?? current.demoAll,
  };
  const row = { user_id: ownerId, enabled: next.enabled, push_limit: next.pushLimit, updated_at: new Date().toISOString() };
  let { error } = await db.from(TABLE).upsert({ ...row, demo_all: next.demoAll }, { onConflict: 'user_id' });
  if (error && missingColumn(error)) {
    if (patch.demoAll !== undefined) throw new Error('Falta la columna demo_all: ejecuta de nuevo src/db/schema-new-business-leads.sql en Supabase');
    ({ error } = await db.from(TABLE).upsert(row, { onConflict: 'user_id' }));
  }
  if (error) throw new Error(error.message);
  return next;
}
