-- Versioned, user-configurable roleplay summary memory.
alter table public.profiles add column if not exists summary_prompt text;

alter table public.sessions
  add column if not exists auto_summary_enabled boolean not null default true,
  add column if not exists summary_interval int not null default 30 check (summary_interval between 5 and 200),
  add column if not exists summary_last_turn int not null default 0;

create table if not exists public.summary_versions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  content text not null,
  summarized_through_turn int not null,
  is_active boolean not null default true,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists summary_versions_session_idx
  on public.summary_versions(session_id, created_at desc);
create unique index if not exists summary_versions_one_active_idx
  on public.summary_versions(session_id) where is_active;

alter table public.summary_versions enable row level security;
create policy "summary_versions_select" on public.summary_versions for select using (
  exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())
);
create policy "summary_versions_insert" on public.summary_versions for insert with check (
  exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())
);
create policy "summary_versions_update" on public.summary_versions for update using (
  exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())
);
create policy "summary_versions_delete" on public.summary_versions for delete using (
  exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())
);
