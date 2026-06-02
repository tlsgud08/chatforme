-- 작품 공개 범위 컬럼 추가
alter table public.works add column if not exists visibility text not null default 'public';

-- 기존 is_published 데이터를 visibility 로 마이그레이션
update public.works set visibility = case when is_published then 'public' else 'private' end
  where visibility = 'public';

-- 기존 RLS 정책 교체
drop policy if exists "works_select_published" on public.works;
create policy "works_select_by_visibility" on public.works for select using (
  visibility = 'public'
  or visibility = 'unlisted'
  or auth.uid() = creator_id
);
