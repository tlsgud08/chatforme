-- 개인 프로필에 귀속되는 명령어. 공개된 같은 행을 허브에서도 보여 주므로
-- 작성자가 수정하면 내 명령어와 허브 양쪽에 즉시 반영된다.
create table if not exists public.commands (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 20),
  description text not null default '' check (char_length(description) <= 100),
  prompt text not null check (char_length(prompt) between 1 and 4000),
  is_published boolean not null default false,
  copied_from_id uuid references public.commands(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);

alter table public.commands enable row level security;

create policy "commands_select_own_or_published" on public.commands
  for select using (owner_id = auth.uid() or is_published);
create policy "commands_insert_own" on public.commands
  for insert with check (owner_id = auth.uid() and is_published = false);
create policy "commands_update_own" on public.commands
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "commands_delete_own" on public.commands
  for delete using (owner_id = auth.uid());

create index if not exists commands_hub_updated_idx
  on public.commands (updated_at desc) where is_published;
create index if not exists commands_owner_updated_idx
  on public.commands (owner_id, updated_at desc);

create or replace function public.set_command_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists commands_set_updated_at on public.commands;
create trigger commands_set_updated_at before update on public.commands
for each row execute function public.set_command_updated_at();
