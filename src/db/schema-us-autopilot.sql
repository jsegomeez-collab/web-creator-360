-- ─── Autopilot: interruptor y tope diario de los americanos ───────────────────
-- Run this in the Supabase SQL editor (after schema-new-business-leads.sql). Safe to run more than once.
-- The "americanos" (new Connecticut LLCs with no Latino signal, English campaign) have their own switch in the dashboard
-- (Envío tab → Autopilot). OFF by default: their leads are imported but no demo is made until it is turned on, and then at most
-- us_daily_demos demos are made (and sent) per day.
ALTER TABLE campaign_autopilot
  ADD COLUMN IF NOT EXISTS us_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS us_daily_demos INT     NOT NULL DEFAULT 100;
