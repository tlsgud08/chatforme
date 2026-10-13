-- 개인 프로필에 귀속되는 플러그인. 공개된 같은 행을 허브에서도 보여 주므로
-- 작성자가 수정하면 내 플러그인과 허브 양쪽에 즉시 반영된다.
create table if not exists public.plugins (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 20),
  description text not null default '' check (char_length(description) <= 100),
  prompt text not null check (char_length(prompt) between 1 and 4000),
  is_published boolean not null default false,
  copied_from_id uuid references public.plugins(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);

alter table public.plugins enable row level security;

create policy "plugins_select_own_or_published" on public.plugins
  for select using (owner_id = auth.uid() or is_published);
create policy "plugins_insert_own" on public.plugins
  for insert with check (owner_id = auth.uid() and is_published = false);
create policy "plugins_update_own" on public.plugins
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "plugins_delete_own" on public.plugins
  for delete using (owner_id = auth.uid());

create index if not exists plugins_hub_updated_idx
  on public.plugins (updated_at desc) where is_published;
create index if not exists plugins_owner_updated_idx
  on public.plugins (owner_id, updated_at desc);

create or replace function public.set_plugin_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists plugins_set_updated_at on public.plugins;
create trigger plugins_set_updated_at before update on public.plugins
for each row execute function public.set_plugin_updated_at();

-- 내 플러그인과 허브 플러그인을 한 목록에서 관리하는 사용자별 즐겨찾기.
create table if not exists public.plugin_favorites (
  user_id uuid not null references public.profiles(id) on delete cascade,
  plugin_id uuid not null references public.plugins(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, plugin_id)
);

alter table public.plugin_favorites enable row level security;

create policy "plugin_favorites_select_own" on public.plugin_favorites
  for select using (auth.uid() = user_id);
create policy "plugin_favorites_insert_own" on public.plugin_favorites
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.plugins
      where plugins.id = plugin_id
        and (plugins.owner_id = auth.uid() or plugins.is_published)
    )
  );
create policy "plugin_favorites_delete_own" on public.plugin_favorites
  for delete using (auth.uid() = user_id);

create index if not exists plugin_favorites_user_created_idx
  on public.plugin_favorites (user_id, created_at desc);

-- Snapshot activated plugins so hub edits/deletions cannot silently change a session.
alter table public.sessions
  add column if not exists active_plugins jsonb not null default '[]'::jsonb
  check (jsonb_typeof(active_plugins) = 'array');
comment on column public.sessions.active_plugins is
  'Ordered activation snapshots: id, name, description, prompt. Included until deactivated.';
