-- ─── New-business leads (captación de LLCs nuevas) ───────────────────────────
-- Run this in the Supabase SQL editor (after schema.sql and schema-saas.sql). Safe to run more than once.
-- Only adds new tables and one nullable column; nothing existing is modified or dropped.

-- 1. Leads: one row per company found in a public registry (source = 'ct_registry' for Connecticut).
--    `source` + `external_id` make it generic so other states can be added later.
CREATE TABLE IF NOT EXISTS new_business_leads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source            TEXT NOT NULL DEFAULT 'ct_registry',
  external_id       TEXT NOT NULL,                 -- Connecticut "accountnumber"
  name              TEXT NOT NULL,
  email             TEXT NOT NULL,                 -- always lowercase
  city              TEXT,
  zip               TEXT,
  address           TEXT,
  registered_at     DATE,
  naics_code        TEXT,                          -- e.g. "Janitorial Services (561720)"
  sector            TEXT,                          -- construccion | limpieza | jardineria | belleza | comida | transporte | taxes | auto | seguros | salud | eventos | otro
  priority          TEXT,                          -- A = known sector, B = "otro"
  latino_signal     BOOLEAN NOT NULL DEFAULT FALSE,
  latino_strong     BOOLEAN NOT NULL DEFAULT FALSE, -- Spanish words in the BUSINESS NAME (decides the email wording)
  minority_owned    BOOLEAN NOT NULL DEFAULT FALSE,

  -- Funnel: new → queued → emailed → form_submitted → called → won | lost
  -- Exits:  unsubscribed | bounced | invalid_email | sequence_finished
  status            TEXT NOT NULL DEFAULT 'new',
  sequence_step     INT  NOT NULL DEFAULT 0,       -- 0 = nothing sent yet; N = number of emails sent
  next_send_at      TIMESTAMPTZ,
  last_sent_at      TIMESTAMPTZ,

  -- Same mailbox and thread for the whole sequence (follow-ups are replies to the first email)
  mailbox           TEXT,
  first_message_id  TEXT,
  first_subject     TEXT,

  -- Form (/f/:token) — token also identifies the lead in the unsubscribe link (/u/:token)
  form_token        TEXT NOT NULL UNIQUE,
  contact_name      TEXT,
  phone             TEXT,
  preferred_time    TEXT,                          -- manana | tarde | noche
  consent_at        TIMESTAMPTZ,
  consent_text      TEXT,                          -- exact wording accepted
  consent_ip        TEXT,

  -- Filled when the demo is generated (after the form)
  business_id       UUID REFERENCES businesses(id) ON DELETE SET NULL,
  site_id           UUID REFERENCES generated_sites(id) ON DELETE SET NULL,

  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_nbl_queue    ON new_business_leads (user_id, status, next_send_at);
CREATE INDEX IF NOT EXISTS idx_nbl_email    ON new_business_leads (user_id, email);
CREATE INDEX IF NOT EXISTS idx_nbl_registered ON new_business_leads (user_id, registered_at DESC);

-- 2. Emails we must never write to again, whatever the source (unsubscribes, bounces, shared/agency addresses...)
CREATE TABLE IF NOT EXISTS email_suppressions (
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,                       -- always lowercase
  reason      TEXT NOT NULL,                       -- unsubscribed | bounced | complaint | manual | ...
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, email)
);

-- 3. One row per ingest run: lets the daily job resume from the last date it read (minus a 2-day margin)
CREATE TABLE IF NOT EXISTS lead_ingest_runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source               TEXT NOT NULL DEFAULT 'ct_registry',
  ran_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  from_date            DATE,
  newest_registration  DATE,                       -- newest date_registration seen in the fetched rows
  fetched              INT NOT NULL DEFAULT 0,
  inserted             INT NOT NULL DEFAULT 0,
  ok                   BOOLEAN NOT NULL DEFAULT TRUE,
  stats                JSONB,
  error                TEXT
);
CREATE INDEX IF NOT EXISTS idx_lead_ingest_runs ON lead_ingest_runs (user_id, source, ran_at DESC);

-- 4. Marks businesses created for these leads so the current Google Places pipeline never touches them
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS source TEXT;

-- 5. Personal data (emails, phones): block the public (anon) API key entirely.
--    The server uses the service key, which bypasses RLS.
ALTER TABLE new_business_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_ingest_runs   ENABLE ROW LEVEL SECURITY;
