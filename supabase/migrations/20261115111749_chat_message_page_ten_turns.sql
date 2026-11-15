-- Keep the existing paging behavior; increase only the five-turn batch to ten.
create or replace function public.session_message_page(target_session uuid,before_turn integer default null)
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare cutoff integer; more boolean; result jsonb;
begin
  if not exists(select 1 from public.sessions where id=target_session and user_id=(select auth.uid())) then
    raise exception 'Session is inaccessible' using errcode='42501'; end if;
  select count(*)>10 into more from (select 1 from public.messages where session_id=target_session and role='user'
    and not is_hidden and is_active_variant and (before_turn is null or turn_index<before_turn)
    order by turn_index desc,created_at desc,id desc limit 11) q;
  if more then
    select min(turn_index) into cutoff from (select turn_index from public.messages where session_id=target_session and role='user'
      and not is_hidden and is_active_variant and (before_turn is null or turn_index<before_turn)
      order by turn_index desc,created_at desc,id desc limit 10) q;
  end if;
  select jsonb_agg(to_jsonb(m) order by turn_index,case when role='user' then 0 else 1 end,created_at,id)
  into result from public.messages m where session_id=target_session
    and (cutoff is null or turn_index>=cutoff) and (before_turn is null or turn_index<before_turn);
  return jsonb_build_object('messages',coalesce(result,'[]'),'hasOlder',more,'oldestTurn',cutoff,
    'totalUserTurns',(select count(*) from public.messages where session_id=target_session and role='user' and not is_hidden and is_active_variant));
end $$;
