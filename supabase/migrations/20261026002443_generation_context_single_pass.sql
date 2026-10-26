-- Keep the exact context shape/hash and RLS. Compute both windows on the
-- same message row; do not rejoin the protected table once per position.
create or replace function public.session_generation_context(target_session uuid,after_summary integer default 0,
  keyword_turns integer default 0,reroll boolean default false) returns jsonb
language plpgsql stable security invoker set search_path=public as $$
declare result jsonb; memory text; cutoff integer;
begin
  select summary,summary_last_turn into memory,cutoff from public.sessions
    where id=target_session and user_id=(select auth.uid());
  if not found then raise exception 'Session is inaccessible' using errcode='42501'; end if;
  with positioned as (
    select m as message,
      count(*) filter(where role='user' and not is_hidden and is_active_variant)
        over(order by turn_index,case when role='user' then 0 else 1 end,created_at,id) as position,
      count(*) filter(where role='user' and not is_hidden and is_active_variant) over() as total_user_turns
    from public.messages m where session_id=target_session
  )
  select jsonb_agg(case when (p.message).is_active_variant and (reroll or (p.message).is_hidden or p.position>cutoff
      or ((p.message).role='user' and p.position>p.total_user_turns-greatest(keyword_turns,1))) then to_jsonb(p.message)
    else jsonb_build_object('id',(p.message).id,'session_id',(p.message).session_id,'role',(p.message).role,'content','',
      'turn_index',(p.message).turn_index,'is_hidden',(p.message).is_hidden,'is_active_variant',(p.message).is_active_variant,
      'reroll_group_id',(p.message).reroll_group_id,'reroll_index',(p.message).reroll_index,'created_at',(p.message).created_at,
      'input_tokens',(p.message).input_tokens,'output_tokens',(p.message).output_tokens,'cost',(p.message).cost,
      'cache_read_tokens',(p.message).cache_read_tokens,'cache_write_tokens',(p.message).cache_write_tokens,
      'is_summarized',(p.message).is_summarized,'generation_status',(p.message).generation_status,
      'command_id',(p.message).command_id,'command_name',(p.message).command_name,'command_prompt',null,
      'content_version',(p.message).content_version,'content_omitted',true) end
    order by (p.message).turn_index,case when (p.message).role='user' then 0 else 1 end,(p.message).created_at,(p.message).id)
  into result from positioned p;
  return jsonb_build_object('messages',coalesce(result,'[]'),'summary',memory,'summaryLastTurn',cutoff,
    'contextHash',public.session_response_context_hash(target_session));
end $$;
revoke all on function public.session_generation_context(uuid,integer,integer,boolean) from public,anon;
grant execute on function public.session_generation_context(uuid,integer,integer,boolean) to authenticated;
notify pgrst, 'reload schema';
