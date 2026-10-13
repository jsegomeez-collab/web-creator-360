-- ─── Seguimiento (follow-up) de los leads que abrieron la web ──────────────────
-- Run this in the Supabase SQL editor (after schema-new-business-leads.sql). Safe to run more than once.
-- When a lead opens its demo website ("engaged") and has not replied, it is moved to a separate Instantly campaign that sends
-- one email a day for 7 days (INSTANTLY_CAMPAIGN_ID_FOLLOWUP). `followup_at` is when it was moved: empty = not moved yet.
ALTER TABLE new_business_leads
  ADD COLUMN IF NOT EXISTS followup_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_nbl_followup ON new_business_leads (user_id, status, followup_at);
