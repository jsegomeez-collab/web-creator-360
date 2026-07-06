-- Run this in your Supabase SQL editor to initialize all tables

CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id TEXT UNIQUE,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  website TEXT,
  category TEXT,
  rating FLOAT,
  status TEXT DEFAULT 'prospected',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_web_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE UNIQUE,
  description TEXT,
  services JSONB DEFAULT '[]',
  social_networks JSONB DEFAULT '[]',
  hours TEXT,
  language TEXT DEFAULT 'es',
  email TEXT,
  value_proposition TEXT,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS generated_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  slug TEXT UNIQUE NOT NULL,
  html_content TEXT NOT NULL,
  preview_url TEXT,
  status TEXT DEFAULT 'preview',
  stripe_price_id TEXT,
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '15 days',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outreach_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id),
  site_id UUID REFERENCES generated_sites(id),
  channel TEXT DEFAULT 'email',
  contact TEXT,
  follow_up_number INT DEFAULT 0,
  next_follow_up_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id),
  site_id UUID REFERENCES generated_sites(id),
  stripe_session_id TEXT UNIQUE,
  amount INT,
  currency TEXT DEFAULT 'eur',
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
