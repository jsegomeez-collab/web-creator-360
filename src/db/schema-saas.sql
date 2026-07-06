-- ─── SaaS Schema ─────────────────────────────────────────────────────────────
-- Run this in your Supabase SQL editor to add multi-tenancy support

-- 1. User settings: stores per-user API keys and subscription info
CREATE TABLE IF NOT EXISTS user_settings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  -- API Keys (user brings their own)
  anthropic_api_key        TEXT,
  resend_api_key           TEXT,
  resend_from_email        TEXT,
  google_places_api_key    TEXT,
  vercel_token             TEXT,
  vercel_scope             TEXT,
  -- Stripe billing
  stripe_customer_id       TEXT,
  stripe_subscription_id   TEXT,
  plan                     TEXT DEFAULT 'free',        -- free | starter | pro | agency
  plan_status              TEXT DEFAULT 'inactive',    -- active | trialing | past_due | canceled
  plan_expires_at          TIMESTAMPTZ,
  -- Monthly usage counters (reset each billing cycle)
  prospects_this_month     INT DEFAULT 0,
  sites_generated_month    INT DEFAULT 0,
  emails_sent_month        INT DEFAULT 0,
  usage_reset_at           TIMESTAMPTZ DEFAULT (date_trunc('month', NOW()) + INTERVAL '1 month'),
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Add user_id to existing tables (multi-tenancy)
ALTER TABLE businesses        ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE generated_sites   ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE outreach_log      ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE business_web_data ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
ALTER TABLE payments          ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);

-- 3. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_businesses_user_id        ON businesses(user_id);
CREATE INDEX IF NOT EXISTS idx_generated_sites_user_id   ON generated_sites(user_id);
CREATE INDEX IF NOT EXISTS idx_outreach_log_user_id      ON outreach_log(user_id);
CREATE INDEX IF NOT EXISTS idx_user_settings_user_id     ON user_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_user_settings_stripe      ON user_settings(stripe_customer_id);

-- 4. Row Level Security (optional but recommended for extra safety)
-- ALTER TABLE businesses        ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE generated_sites   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE user_settings     ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "user_own_data" ON businesses        USING (user_id = auth.uid());
-- CREATE POLICY "user_own_data" ON generated_sites   USING (user_id = auth.uid());
-- CREATE POLICY "user_own_settings" ON user_settings USING (user_id = auth.uid());

-- 5. Helper function to auto-create user_settings on new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_settings (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop and recreate trigger
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
