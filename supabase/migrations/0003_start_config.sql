-- 시작 설정 테이블
create table if not exists public.start_configs (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.works(id) on delete cascade,
  name text not null default '',
  initial_message text not null default '',
  initial_context text not null default '',
  keep_turns int not null default 3,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.start_configs enable row level security;

create policy "start_configs_select" on public.start_configs for select using (
  exists (
    select 1 from public.works w where w.id = work_id
    and (w.visibility in ('public', 'unlisted') or w.creator_id = auth.uid())
  )
);

create policy "start_configs_write" on public.start_configs for all using (
  exists (select 1 from public.works w where w.id = work_id and w.creator_id = auth.uid())
);

-- sessions 에 start_config_id 추가
alter table public.sessions add column if not exists start_config_id uuid references public.start_configs(id);

-- messages 에 is_hidden 추가
alter table public.messages add column if not exists is_hidden boolean not null default false;
