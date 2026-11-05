-- Only visible active user messages contribute a turn; legacy turn zero counts.
create index if not exists messages_visible_user_count_idx
 on public.messages(session_id) include(id)
 where role='user' and not is_hidden and is_active_variant;
create index if not exists sessions_work_usage_idx on public.sessions(work_id);

create or replace function public.session_conversation_counts(target_session_ids uuid[])
returns table(session_id uuid,conversation_count bigint)
language sql stable security invoker set search_path='' as $$
 select s.id,(select count(*) from public.messages m where m.session_id=s.id
   and m.role='user' and not m.is_hidden and m.is_active_variant)
 from public.sessions s where s.id=any(target_session_ids) and s.user_id=(select auth.uid());
$$;
revoke all on function public.session_conversation_counts(uuid[]) from public,anon;
grant execute on function public.session_conversation_counts(uuid[]) to authenticated;

-- The privileged helper exposes aggregate numbers only, never private transcripts.
create schema if not exists private;
create or replace function private.work_usage_totals(target_work uuid)
returns table(turn_count bigint,total_cost_usd numeric)
language plpgsql stable security definer set search_path='' as $$
begin
 if (select auth.uid()) is null or not exists(select 1 from public.works w
  where w.id=target_work and (w.visibility in ('public','unlisted')
   or w.creator_id=(select auth.uid()) or public.can_edit_work(w.id))) then
  raise exception 'Work is inaccessible' using errcode='42501';
 end if;
 return query
 select coalesce(sum((select count(*) from public.messages m where m.session_id=s.id
    and m.role='user' and not m.is_hidden and m.is_active_variant)),0)::bigint,
   coalesce(sum(s.total_cost),0)::numeric
 from public.sessions s where s.work_id=target_work;
end $$;
revoke all on function private.work_usage_totals(uuid) from public,anon;
grant usage on schema private to authenticated;
grant execute on function private.work_usage_totals(uuid) to authenticated;
create or replace function public.work_usage_totals(target_work uuid)
returns table(turn_count bigint,total_cost_usd numeric)
language sql stable security invoker set search_path='' as $$
 select * from private.work_usage_totals(target_work);
$$;
revoke all on function public.work_usage_totals(uuid) from public,anon;
grant execute on function public.work_usage_totals(uuid) to authenticated;
notify pgrst,'reload schema';
