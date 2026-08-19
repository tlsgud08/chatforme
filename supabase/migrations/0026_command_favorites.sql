-- 내 명령어와 허브 명령어를 한 목록에서 관리하는 사용자별 즐겨찾기.
create table if not exists public.command_favorites (
  user_id uuid not null references public.profiles(id) on delete cascade,
  command_id uuid not null references public.commands(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, command_id)
);

alter table public.command_favorites enable row level security;

create policy "command_favorites_select_own" on public.command_favorites
  for select using (auth.uid() = user_id);
create policy "command_favorites_insert_own" on public.command_favorites
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.commands
      where commands.id = command_id
        and (commands.owner_id = auth.uid() or commands.is_published)
    )
  );
create policy "command_favorites_delete_own" on public.command_favorites
  for delete using (auth.uid() = user_id);

create index if not exists command_favorites_user_created_idx
  on public.command_favorites (user_id, created_at desc);
