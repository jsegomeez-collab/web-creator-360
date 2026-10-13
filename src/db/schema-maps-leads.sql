-- ─── Campaña 2: negocios de Google Maps SIN web (source = 'gmaps') ─────────────
-- Run this in the Supabase SQL editor (after schema-new-business-leads.sql). Safe to run more than once.
-- They live in the same table, funnel, demos and panel as the LLC leads; they go to their own Instantly campaign
-- (INSTANTLY_CAMPAIGN_ID_MAPS) with their own copy.
ALTER TABLE new_business_leads
  ADD COLUMN IF NOT EXISTS state          TEXT,       -- FL | TX | NJ …
  ADD COLUMN IF NOT EXISTS business_phone TEXT,       -- the public phone of the business (not the one a lead types in the form)
  ADD COLUMN IF NOT EXISTS rating         NUMERIC,
  ADD COLUMN IF NOT EXISTS reviews        INT,
  ADD COLUMN IF NOT EXISTS maps_url       TEXT,
  ADD COLUMN IF NOT EXISTS category       TEXT;       -- Google's own category ("Taquería")
