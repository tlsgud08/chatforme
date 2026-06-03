-- profiles 에 아바타·소개 추가
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists bio      text check (char_length(bio) <= 500);

-- 팔로우 테이블
create table if not exists public.user_follows (
  follower_id  uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

alter table public.user_follows enable row level security;

-- 팔로워/팔로잉 수 표시를 위해 모든 사용자 조회 허용
create policy "follows_select" on public.user_follows for select using (true);
create policy "follows_insert" on public.user_follows for insert with check (auth.uid() = follower_id);
create policy "follows_delete" on public.user_follows for delete using (auth.uid() = follower_id);

-- avatars 스토리지 버킷 (public) 및 RLS
-- ※ Supabase 대시보드 Storage 탭에서 'avatars' 퍼블릭 버킷을 먼저 생성하세요.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatar_public_read" on storage.objects for select
  using (bucket_id = 'avatars');

create policy "avatar_owner_insert" on storage.objects for insert
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "avatar_owner_update" on storage.objects for update
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "avatar_owner_delete" on storage.objects for delete
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
