-- 작품 플레이 로그 (랭킹 집계용). RLS select는 전체 공개(집계 목적), insert는 누구나(비회원 포함)
create table if not exists public.work_plays (
  id         uuid primary key default gen_random_uuid(),
  work_id    uuid not null references public.works(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.work_plays enable row level security;

create policy "plays_select" on public.work_plays for select using (true);
create policy "plays_insert" on public.work_plays for insert with check (true);

create index if not exists work_plays_work_created_idx
  on public.work_plays (work_id, created_at desc);
