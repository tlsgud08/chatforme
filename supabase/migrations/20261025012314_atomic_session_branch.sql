-- Copy an owned history and its settings in one transaction, without sending
-- the whole conversation to the browser and back. A caller-generated ID makes
-- a lost response safely replayable within the same request.
create or replace function public.branch_session_at_message(
  target_session uuid, target_message uuid, branch_id uuid, expected_version integer
) returns uuid language plpgsql security invoker set search_path=public as $$
declare s public.sessions; m public.messages; target public.messages;
  copied public.messages; fork public.sessions; turns integer:=0; assistant_index integer:=0;
  valid_through integer; cache_id uuid;
begin
  if branch_id is null or branch_id=target_session or expected_version is null then
    raise exception 'Invalid branch request' using errcode='22023';
  end if;
  select * into s from public.sessions where id=target_session and user_id=(select auth.uid()) for update;
  if not found then raise exception 'Session is inaccessible' using errcode='42501'; end if;
  if exists(select 1 from public.sessions where id=branch_id and user_id=(select auth.uid())) then return branch_id; end if;
  select * into target from public.messages where session_id=target_session and id=target_message and is_active_variant;
  if not found then raise exception 'Branch source is inaccessible' using errcode='42501'; end if;
  if target.content_version<>expected_version then raise exception 'Branch source changed; refresh' using errcode='40001'; end if;
  -- Existing clients may still write rows directly. Lock the source rows as well
  -- as the session so the copied history cannot change halfway through.
  perform 1 from public.messages where session_id=target_session for share;
  perform 1 from public.summary_versions where session_id=target_session for share;
  perform 1 from public.story_notes where session_id=target_session for share;
  select * into target from public.messages where id=target_message and session_id=target_session and is_active_variant;
  if not found or target.content_version<>expected_version then raise exception 'Branch source changed; refresh' using errcode='40001'; end if;
  fork:=jsonb_populate_record(null::public.sessions,to_jsonb(s)||jsonb_build_object(
    'id',branch_id,'title',s.title||' (분기)','created_at',now(),'updated_at',now(),'is_archived',false,
    'summary','','summary_last_turn',0,'total_input_tokens',0,'total_output_tokens',0,'total_cost',0,
    'prompt_cache_message_id',null));
  insert into public.sessions select (fork).*;
  for m in select * from public.messages where session_id=target_session and is_active_variant
    order by turn_index,case when role='user' then 0 else 1 end,created_at,id
  loop
    if m.generation_status='streaming' then raise exception 'Response is still generating' using errcode='40001'; end if;
    if m.role='user' and not m.is_hidden then turns:=turns+1; assistant_index:=0; end if;
    if m.role='assistant' then assistant_index:=assistant_index+1; end if;
    copied:=jsonb_populate_record(null::public.messages,to_jsonb(m)||jsonb_build_object(
      'id',gen_random_uuid(),'session_id',branch_id,'turn_index',turns,'reroll_group_id',null,
      'reroll_index',case when m.role='assistant' then assistant_index else 1 end,
      'is_summarized',false,'legacy_turn_conflict',false,'usage_accounted',true,'content_version',0));
    insert into public.messages select (copied).*;
    if m.id=s.prompt_cache_message_id then cache_id:=copied.id; end if;
    exit when m.id=target_message;
  end loop;
  -- A branch ending on a user message does not contain that turn's answer.
  valid_through:=case when target.role='assistant' and not target.is_hidden then turns else greatest(0,turns-1) end;
  insert into public.summary_versions(session_id,content,summarized_through_turn,is_active,input_tokens,output_tokens,cost,created_at)
    select branch_id,content,summarized_through_turn,true,input_tokens,output_tokens,cost,created_at
    from public.summary_versions where session_id=target_session and is_active and summarized_through_turn<=valid_through;
  insert into public.story_notes(session_id,content,created_at,updated_at)
    select branch_id,content,created_at,updated_at from public.story_notes where session_id=target_session;
  update public.sessions set
    summary=coalesce((select string_agg(content,E'\n\n--- Additional Summary Note ---\n\n' order by created_at,id)
      from public.summary_versions where session_id=branch_id and is_active),''),
    summary_last_turn=coalesce((select max(summarized_through_turn) from public.summary_versions where session_id=branch_id and is_active),0),
    total_input_tokens=coalesce((select sum(input_tokens) from public.messages where session_id=branch_id),0)
      +coalesce((select sum(input_tokens) from public.summary_versions where session_id=branch_id),0),
    total_output_tokens=coalesce((select sum(output_tokens) from public.messages where session_id=branch_id),0)
      +coalesce((select sum(output_tokens) from public.summary_versions where session_id=branch_id),0),
    total_cost=coalesce((select sum(cost) from public.messages where session_id=branch_id),0)
      +coalesce((select sum(cost) from public.summary_versions where session_id=branch_id),0),
    prompt_cache_message_id=cache_id where id=branch_id;
  update public.messages set is_summarized=true where session_id=branch_id and not is_hidden
    and turn_index<=(select summary_last_turn from public.sessions where id=branch_id);
  return branch_id;
end $$;
revoke all on function public.branch_session_at_message(uuid,uuid,uuid,integer) from public,anon;
grant execute on function public.branch_session_at_message(uuid,uuid,uuid,integer) to authenticated;
notify pgrst, 'reload schema';
