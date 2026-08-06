-- BTC Discovery Lab hybrid cache
-- Run this once in the Supabase SQL editor for the project used by Vercel.

create table if not exists public.btc_candidate_cache (
  search_key text primary key,
  filters jsonb not null,
  candidates jsonb not null default '[]'::jsonb,
  candidate_count integer not null default 0 check (candidate_count >= 0),
  total_bytes_processed bigint not null default 0 check (total_bytes_processed >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists btc_candidate_cache_expires_at_idx
  on public.btc_candidate_cache (expires_at);

create table if not exists public.btc_address_cache (
  address text primary key,
  first_seen timestamptz,
  last_activity timestamptz,
  balance_sats numeric(30, 0) not null default 0 check (balance_sats >= 0),
  tx_count bigint not null default 0 check (tx_count >= 0),
  checked_at timestamptz not null default now(),
  source text not null default 'esplora'
);

create index if not exists btc_address_cache_checked_at_idx
  on public.btc_address_cache (checked_at);

alter table public.btc_candidate_cache enable row level security;
alter table public.btc_address_cache enable row level security;

-- No anon/authenticated policies are created. The Vercel server function must use
-- SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS. Never expose that key in browser code.

revoke all on table public.btc_candidate_cache from anon, authenticated;
revoke all on table public.btc_address_cache from anon, authenticated;

grant all on table public.btc_candidate_cache to service_role;
grant all on table public.btc_address_cache to service_role;
