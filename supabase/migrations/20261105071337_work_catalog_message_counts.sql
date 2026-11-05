-- Ranking counts only: room count and visible active user turns, no cost scan.
create or replace function private.work_catalog_counts(target_work_ids uuid[])
returns table(work_id uuid,session_count bigint,message_count bigint)
language sql stable security definer set search_path='' as $$
 with accessible as materialized (
  select w.id from public.works w where (select auth.uid()) is not null
   and w.id=any(target_work_ids) and (w.visibility in ('public','unlisted')
    or w.creator_id=(select auth.uid()) or public.can_edit_work(w.id))
 )
 select w.id,count(s.id),coalesce(sum((select count(*) from public.messages m
   where m.session_id=s.id and m.role='user' and not m.is_hidden and m.is_active_variant)),0)::bigint
 from accessible w left join public.sessions s on s.work_id=w.id group by w.id;
$$;
revoke all on function private.work_catalog_counts(uuid[]) from public,anon;
grant execute on function private.work_catalog_counts(uuid[]) to authenticated;
create or replace function public.work_catalog_counts(target_work_ids uuid[])
returns table(work_id uuid,session_count bigint,message_count bigint)
language sql stable security invoker set search_path='' as $$
 select * from private.work_catalog_counts(target_work_ids);
$$;
revoke all on function public.work_catalog_counts(uuid[]) from public,anon;
grant execute on function public.work_catalog_counts(uuid[]) to authenticated;
notify pgrst,'reload schema';
