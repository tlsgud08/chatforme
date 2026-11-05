create index if not exists sessions_work_usage_idx on public.sessions(work_id);
create schema if not exists private;
-- Only scalar aggregates for accessible works; never return individual sessions.
create or replace function private.work_catalog_rankings(target_work_ids uuid[])
returns table(work_id uuid,session_count bigint,total_cost_usd numeric)
language sql stable security definer set search_path='' as $$
 with accessible as materialized (
  select w.id from public.works w where (select auth.uid()) is not null
   and w.id=any(target_work_ids) and (w.visibility in ('public','unlisted')
    or w.creator_id=(select auth.uid()) or public.can_edit_work(w.id))
 )
 select w.id,count(s.id),coalesce(sum(s.total_cost),0)::numeric
 from accessible w left join public.sessions s on s.work_id=w.id group by w.id;
$$;
revoke all on function private.work_catalog_rankings(uuid[]) from public,anon;
grant usage on schema private to authenticated;
grant execute on function private.work_catalog_rankings(uuid[]) to authenticated;
create or replace function public.work_catalog_rankings(target_work_ids uuid[])
returns table(work_id uuid,session_count bigint,total_cost_usd numeric)
language sql stable security invoker set search_path='' as $$
 select * from private.work_catalog_rankings(target_work_ids);
$$;
revoke all on function public.work_catalog_rankings(uuid[]) from public,anon;
grant execute on function public.work_catalog_rankings(uuid[]) to authenticated;
notify pgrst,'reload schema';
