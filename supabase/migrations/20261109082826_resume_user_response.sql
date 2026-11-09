-- Reply to an unanswered visible user turn without inserting/counting another
-- user message. Ordinary sends/rerolls and every existing aggregate stay intact.
create or replace function public.resume_session_response(
  target_session uuid, response_id uuid, source_user uuid, source_versions jsonb,
  expected_summary text, expected_summary_turn integer, requested_turn integer,
  expected_context_hash text default null
) returns jsonb language plpgsql security invoker
set search_path=public set lock_timeout='5s' as $$
declare s public.sessions; draft public.messages; source public.messages;
  latest_id uuid; current_sources jsonb; wanted_sources jsonb; stamp text;
begin
  select * into s from public.sessions where id=target_session and user_id=(select auth.uid()) for update;
  if not found or s.multichat_room_id is not null then raise exception 'Session is inaccessible' using errcode='42501'; end if;
  if response_id is null then raise exception 'Missing response ID' using errcode='22023'; end if;
  select * into source from public.messages where id=source_user and session_id=target_session
    and role='user' and not is_hidden and is_active_variant;
  if not found then raise exception 'User turn changed; refresh' using errcode='PT409'; end if;
  select * into draft from public.messages where id=response_id and session_id=target_session and role='assistant';
  if found then
    if draft.turn_index is distinct from source.turn_index then raise exception 'Response turn changed' using errcode='PT409'; end if;
    return jsonb_build_object('draft',to_jsonb(draft),'userMessage',null,'replayed',true);
  end if;
  perform public.recover_expired_session_responses(target_session);
  if exists(select 1 from public.messages where session_id=target_session and generation_status='streaming') then
    raise exception 'Another response is generating; refresh' using errcode='PT409'; end if;
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
  select id into latest_id from public.messages where session_id=target_session and not is_hidden and is_active_variant
    order by turn_index desc,case when role='user' then 0 else 1 end desc,created_at desc,id desc limit 1;
  if latest_id is distinct from source_user or requested_turn is distinct from source.turn_index then
    raise exception 'User turn changed; refresh' using errcode='PT409'; end if;
  stamp:=public.session_response_context_hash(target_session);
  insert into public.messages(id,session_id,role,content,turn_index,reroll_index,is_active_variant,generation_status,generation_context_hash)
    values(response_id,target_session,'assistant','',source.turn_index,
      (select coalesce(max(reroll_index),0)+1 from public.messages where session_id=target_session and role='assistant' and turn_index=source.turn_index),
      true,'streaming',stamp) returning * into draft;
  return jsonb_build_object('draft',to_jsonb(draft),'userMessage',null,'replayed',false);
end $$;
revoke all on function public.resume_session_response(uuid,uuid,uuid,jsonb,text,integer,integer,text) from public,anon;
grant execute on function public.resume_session_response(uuid,uuid,uuid,jsonb,text,integer,integer,text) to authenticated;
notify pgrst,'reload schema';
