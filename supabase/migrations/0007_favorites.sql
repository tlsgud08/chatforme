-- 작품 즐겨찾기
create table if not exists public.work_favorites (
  user_id uuid not null references public.profiles(id) on delete cascade,
  work_id uuid not null references public.works(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, work_id)
);

alter table public.work_favorites enable row level security;

create policy "fav_select" on public.work_favorites
  for select using (auth.uid() = user_id);

create policy "fav_insert" on public.work_favorites
  for insert with check (auth.uid() = user_id);

create policy "fav_delete" on public.work_favorites
  for delete using (auth.uid() = user_id);
