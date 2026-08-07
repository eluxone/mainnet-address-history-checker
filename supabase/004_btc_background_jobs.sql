-- Feature 13: persistent browser-independent BTC background scanning jobs

create extension if not exists pgcrypto;

create table if not exists public.btc_background_jobs (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Background BTC scan',
  filters jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','running','paused','waiting_provider','complete','target_reached','cancelled','error')),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  next_offset integer not null default 0 check (next_offset >= 0),
  checked_count integer not null default 0 check (checked_count >= 0),
  matched_count integer not null default 0 check (matched_count >= 0),
  results jsonb not null default '[]'::jsonb,
  bigquery_bytes numeric(30,0) not null default 0 check (bigquery_bytes >= 0),
  address_cache_hits bigint not null default 0 check (address_cache_hits >= 0),
  provider_errors integer not null default 0 check (provider_errors >= 0),
  retry_count integer not null default 0 check (retry_count >= 0),
  queue_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  last_heartbeat_at timestamptz
);

create index if not exists btc_background_jobs_status_idx on public.btc_background_jobs (status, updated_at desc);
create index if not exists btc_background_jobs_created_idx on public.btc_background_jobs (created_at desc);

alter table public.btc_background_jobs enable row level security;
revoke all on table public.btc_background_jobs from anon, authenticated;
grant all on table public.btc_background_jobs to service_role;
