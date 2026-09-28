-- ─── New-business leads (captación de LLCs nuevas) ───────────────────────────
-- Run this in the Supabase SQL editor (after schema.sql and schema-saas.sql). Safe to run more than once, and it also
-- upgrades the table created by the first version of this file. Only touches the tables/columns of this feature.

-- 1. Leads: one row per company found in a public registry or imported from a CSV.
--    `source` + `external_id` make it generic (source = 'ct_registry' for Connecticut, 'csv_import' for CSV files).
CREATE TABLE IF NOT EXISTS new_business_leads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source            TEXT NOT NULL DEFAULT 'ct_registry',
  external_id       TEXT NOT NULL,                 -- Connecticut "accountnumber", or an id from the CSV
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
  latino_strong     BOOLEAN NOT NULL DEFAULT FALSE, -- Spanish words in the BUSINESS NAME (adds the "comunidad latina" phrase to the email)
  minority_owned    BOOLEAN NOT NULL DEFAULT FALSE,

  -- Funnel: new → queued (sent to Instantly) → emailed → engaged (opened the calendar link) → booked (booked a call in Calendly)
  --         → called → won | lost
  -- Exits:  replied | unsubscribed | bounced | invalid_email | rejected (Instantly didn't accept it)
  status            TEXT NOT NULL DEFAULT 'new',
  instantly_lead_id TEXT,
  pushed_at         TIMESTAMPTZ,
  emailed_at        TIMESTAMPTZ,
  engaged_at        TIMESTAMPTZ,
  replied_at        TIMESTAMPTZ,
  booked_at         TIMESTAMPTZ,                   -- when they booked the call
  call_at           TIMESTAMPTZ,                   -- when the call is (start time in Calendly)

  -- Unguessable token of the lead's own link in the email (/c/:token → tracked redirect to your calendar)
  link_token        TEXT NOT NULL UNIQUE,

  -- Filled when the demo is generated (after the lead opens the link)
  business_id       UUID REFERENCES businesses(id) ON DELETE SET NULL,
  site_id           UUID REFERENCES generated_sites(id) ON DELETE SET NULL,

  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, source, external_id)
);

-- Upgrade from the first version (own SMTP sender + phone form): Instantly now handles mailboxes, schedule and
-- follow-ups, and there is no form. Nothing of value is lost: those columns were never filled.
ALTER TABLE new_business_leads
  DROP COLUMN IF EXISTS sequence_step,   DROP COLUMN IF EXISTS next_send_at,     DROP COLUMN IF EXISTS last_sent_at,
  DROP COLUMN IF EXISTS mailbox,         DROP COLUMN IF EXISTS first_message_id, DROP COLUMN IF EXISTS first_subject,
  DROP COLUMN IF EXISTS contact_name,    DROP COLUMN IF EXISTS phone,            DROP COLUMN IF EXISTS preferred_time,
  DROP COLUMN IF EXISTS consent_at,      DROP COLUMN IF EXISTS consent_text,     DROP COLUMN IF EXISTS consent_ip;
ALTER TABLE new_business_leads
  ADD COLUMN IF NOT EXISTS instantly_lead_id TEXT,
  ADD COLUMN IF NOT EXISTS pushed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS emailed_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS engaged_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replied_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS booked_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS call_at           TIMESTAMPTZ;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'new_business_leads' AND column_name = 'form_token') THEN
    ALTER TABLE new_business_leads RENAME COLUMN form_token TO link_token;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_nbl_queue;
CREATE INDEX IF NOT EXISTS idx_nbl_push       ON new_business_leads (user_id, status, registered_at DESC);
CREATE INDEX IF NOT EXISTS idx_nbl_email      ON new_business_leads (user_id, email);
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

-- 5. Personal data (emails): block the public (anon) API key entirely.
--    The server uses the service key, which bypasses RLS.
ALTER TABLE new_business_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_ingest_runs   ENABLE ROW LEVEL SECURITY;
