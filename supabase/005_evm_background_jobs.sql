-- Persistent browser-independent EVM public-address audit jobs.
-- Sensitive recovery phrases/private keys are never stored here.

create extension if not exists pgcrypto;

create table if not exists public.evm_background_jobs (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'EVM background audit',
  job_type text not null default 'recovery_audit' check (job_type in ('recovery_audit','address_check')),
  status text not null default 'queued' check (status in ('queued','running','paused','waiting_provider','complete','cancelled','error')),
  stop_after_empty integer check (stop_after_empty is null or stop_after_empty between 1 and 1000),
  items jsonb not null default '[]'::jsonb,
  results jsonb not null default '[]'::jsonb,
  next_offset integer not null default 0 check (next_offset >= 0),
  checked_count integer not null default 0 check (checked_count >= 0),
  matched_count integer not null default 0 check (matched_count >= 0),
  network_error_count integer not null default 0 check (network_error_count >= 0),
  consecutive_empty integer not null default 0 check (consecutive_empty >= 0),
  consecutive_total_failures integer not null default 0 check (consecutive_total_failures >= 0),
  retry_count integer not null default 0 check (retry_count >= 0),
  queue_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  last_heartbeat_at timestamptz
);

create index if not exists evm_background_jobs_status_idx on public.evm_background_jobs (status, updated_at desc);
create index if not exists evm_background_jobs_created_idx on public.evm_background_jobs (created_at desc);

alter table public.evm_background_jobs enable row level security;
revoke all on table public.evm_background_jobs from anon, authenticated;
grant all on table public.evm_background_jobs to service_role;
