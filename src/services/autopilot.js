// On/off switch (and batch size) for the campaign server's unattended cycle: daily ingest from the CT registry + sending
// new leads to Instantly every 3 hours. One row per user; read fresh on every cron tick (see campaign-server.js), so
// toggling from the dashboard takes effect within one cycle — no redeploy.
const TABLE = 'campaign_autopilot';
const DEFAULTS = { enabled: true, pushLimit: 20 };

export async function getAutopilotSettings(db, ownerId) {
  const { data, error } = await db.from(TABLE).select('enabled, push_limit').eq('user_id', ownerId).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { enabled: data.enabled, pushLimit: data.push_limit } : { ...DEFAULTS };
}

// patch: { enabled?, pushLimit? } — only the given fields change; the other keeps its current (or default) value.
// Always writes both columns (never relies on the database's own column default, so behaviour doesn't depend on which
// database is behind `db`), so this is also the source of truth for what the row ends up as — no need to read it back.
export async function setAutopilotSettings(db, ownerId, patch) {
  const current = await getAutopilotSettings(db, ownerId);
  const next = { enabled: patch.enabled ?? current.enabled, pushLimit: patch.pushLimit ?? current.pushLimit };
  const { error } = await db.from(TABLE).upsert(
    { user_id: ownerId, enabled: next.enabled, push_limit: next.pushLimit, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(error.message);
  return next;
}
