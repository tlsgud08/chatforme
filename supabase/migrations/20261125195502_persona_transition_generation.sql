set local lock_timeout = '3s';
CREATE OR REPLACE FUNCTION public.begin_session_response(target_session uuid, response_id uuid, user_message_id uuid, user_text text, user_command_id uuid, user_command_name text, user_command_prompt text, source_versions jsonb, expected_summary text, expected_summary_turn integer, reroll_message uuid DEFAULT NULL::uuid, requested_turn integer DEFAULT NULL::integer, requested_variant integer DEFAULT 1, expected_context_hash text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
 SET lock_timeout TO '5s'
AS $function$
declare s public.sessions; draft public.messages; source public.messages; added public.messages;
 current_sources jsonb; wanted_sources jsonb; stamp text; expected_turn integer; group_id uuid;
begin
 select * into s from public.sessions where id=target_session and user_id=(select auth.uid()) for update;
 if not found then raise exception 'Session is inaccessible' using errcode='42501'; end if;
 if response_id is null then raise exception 'Missing response ID' using errcode='22023'; end if;
 select * into draft from public.messages where id=response_id and session_id=target_session and role='assistant';
 if found then
  if user_message_id is not null then select * into added from public.messages where id=user_message_id and session_id=target_session and role='user'; end if;
  return jsonb_build_object('draft',to_jsonb(draft),'userMessage',case when added.id is not null then to_jsonb(added) else null end,'replayed',true);
 end if;
 perform public.recover_expired_session_responses(target_session);
 if exists(select 1 from public.messages where session_id=target_session and generation_status='streaming') then
   raise exception 'Another response is generating; refresh' using errcode='PT409'; end if;
 -- Lock the rows old clients can still mutate directly until the claim commits.
 perform 1 from public.messages where session_id=target_session for share;
 if expected_context_hash is not null then
  if expected_context_hash is distinct from public.session_response_context_hash(target_session) then
   raise exception 'Dialogue changed; preserve input and refresh' using errcode='PT409'; end if;
 else
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',content_version,'active',is_active_variant) order by id),'[]'::jsonb)
  into current_sources from public.messages where session_id=target_session;
  select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'version',v.version,'active',v.active) order by v.id),'[]'::jsonb)
  into wanted_sources from jsonb_to_recordset(source_versions) v(id uuid,version integer,active boolean);
  if current_sources is distinct from wanted_sources then raise exception 'Dialogue changed; preserve input and refresh' using errcode='PT409'; end if;
 end if;
 if s.summary is distinct from expected_summary or s.summary_last_turn is distinct from expected_summary_turn then
  raise exception 'Summary changed; preserve input and refresh' using errcode='PT409'; end if;
 if reroll_message is not null then
  select * into source from public.messages where id=reroll_message and session_id=target_session and role='assistant' and is_active_variant;
  if not found then raise exception 'Reroll source changed' using errcode='PT409'; end if;
  group_id:=coalesce(source.reroll_group_id,source.id); expected_turn:=source.turn_index;
  if requested_variant is distinct from (select coalesce(max(reroll_index),0)+1 from public.messages
    where session_id=target_session and role='assistant' and coalesce(reroll_group_id,id)=group_id) then
    raise exception 'Response variant changed' using errcode='PT409'; end if;
 else
  select coalesce(max(turn_index),0)+1 into expected_turn from public.messages where session_id=target_session and not is_hidden and is_active_variant;
  if requested_variant is distinct from 1 then raise exception 'Invalid variant' using errcode='22023'; end if;
 end if;
 if requested_turn is distinct from expected_turn then raise exception 'Turn changed' using errcode='PT409'; end if;
 -- Finalize earlier turns only after all source/turn checks succeeded.
 -- Same-turn rerolls remain comparable; failures and abandoned drafts are
 -- treated identically to completed unselected answers. The active generation
 -- guard above must pass first. The following draft insert shares this transaction.
 if reroll_message is null and s.multichat_room_id is null then
  delete from public.messages
   where session_id=target_session and role='assistant'
     and is_active_variant=false and turn_index<expected_turn;
 end if;
 if reroll_message is null and user_message_id is not null then
  insert into public.messages(id,session_id,role,content,turn_index,command_id,command_name,command_prompt,author_persona_id,author_persona_name)
  values(user_message_id,target_session,'user',coalesce(user_text,''),expected_turn,user_command_id,user_command_name,user_command_prompt,s.persona_id,
    coalesce((select p.name from public.personas p where p.id = s.persona_id and p.user_id = s.user_id), '')) returning * into added;
 end if;
 stamp:=public.session_response_context_hash(target_session);
 insert into public.messages(id,session_id,role,content,turn_index,reroll_group_id,reroll_index,is_active_variant,generation_status,generation_context_hash)
 values(response_id,target_session,'assistant','',expected_turn,group_id,requested_variant,reroll_message is null,'streaming',stamp) returning * into draft;
 return jsonb_build_object('draft',to_jsonb(draft),'userMessage',case when added.id is not null then to_jsonb(added) else null end,'replayed',false);
end $function$;

CREATE OR REPLACE FUNCTION public.session_generation_context(target_session uuid, after_summary integer DEFAULT 0, keyword_turns integer DEFAULT 0, reroll boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
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
    'contextHash',public.session_response_context_hash(target_session),'personaTurn',public.session_persona_turn_context(target_session))
    || case when exists (select 1 from public.session_persona_deaths d where d.session_id=target_session) then
      jsonb_build_object('personaDeaths',public.session_persona_death_context(target_session),'personaArchives',public.session_persona_archive_context(target_session,true)) else '{}'::jsonb end;
end $function$;

notify pgrst, 'reload schema';
