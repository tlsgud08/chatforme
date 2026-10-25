-- Additive: old clients keep working. New clients mutate a message and its
-- derived memory in one owned-session transaction, with guarded replay.
create or replace function public.mutate_session_message(
  target_session uuid, target_message uuid, operation text, expected_version integer,
  expected_command_id uuid default null, expected_command_name text default null,
  message_text text default null, command_uuid uuid default null, command_label text default null, message_group uuid default null
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare s public.sessions; m public.messages; replacement public.messages;
  affected_turn integer; fallback_id uuid; changed integer;
begin
  if operation not in ('edit','delete') or operation is null or expected_version is null then
    raise exception 'Invalid message operation' using errcode='22023';
  end if;
  select * into s from public.sessions where id=target_session and user_id=(select auth.uid()) for update;
  if not found then raise exception 'Session is inaccessible' using errcode='42501'; end if;
  select * into m from public.messages where id=target_message and session_id=target_session for update;
  if not found then
    if operation='delete' then
      select * into replacement from public.messages where session_id=target_session and role='assistant'
        and coalesce(reroll_group_id,id)=message_group and is_active_variant order by reroll_index desc,created_at desc,id desc limit 1;
      return jsonb_build_object('deleted',true,'message',null,'replacement',case when replacement.id is not null then to_jsonb(replacement) else null end,'session',to_jsonb(s));
    end if;
    raise exception 'Message is inaccessible' using errcode='42501';
  end if;
  if m.generation_status='streaming' then raise exception 'Message is still generating' using errcode='40001'; end if;
  if operation='edit' then
    if nullif(trim(message_text),'') is null then raise exception 'Message cannot be empty' using errcode='22023'; end if;
    -- A lost successful response may be replayed without invalidating memory twice.
    if m.content=message_text and m.command_id is not distinct from command_uuid
      and m.command_name is not distinct from command_label
      and (command_uuid is not null or command_label is not null or m.command_prompt is null) then
      return jsonb_build_object('deleted',false,'message',to_jsonb(m),'replacement',null,'session',to_jsonb(s));
    end if;
  end if;
  if m.content_version<>expected_version or m.command_id is distinct from expected_command_id
    or m.command_name is distinct from expected_command_name then
    raise exception 'Message changed; preserve your draft and refresh' using errcode='40001';
  end if;
  if m.is_active_variant then
    if m.is_hidden then affected_turn:=0;
    else
      select count(*) into affected_turn from public.messages u where u.session_id=target_session
        and u.role='user' and not u.is_hidden and u.is_active_variant
        and (u.turn_index<m.turn_index or (u.turn_index=m.turn_index and
          (m.role<>'user' or (u.created_at,u.id)<=(m.created_at,m.id))));
    end if;
  end if;
  if operation='edit' then
    update public.messages set content=message_text,command_id=command_uuid,command_name=command_label,
      command_prompt=case when command_uuid is null and command_label is null then null else command_prompt end,
      is_summarized=false where id=target_message returning * into m;
  else
    delete from public.messages where id=target_message;
    if m.role='assistant' and m.is_active_variant then
      select * into replacement from public.messages where session_id=target_session and role='assistant'
        and coalesce(reroll_group_id,id)=coalesce(m.reroll_group_id,m.id)
        order by reroll_index desc,created_at desc,id desc limit 1 for update;
      if found then
        update public.messages set is_active_variant=true where id=replacement.id returning * into replacement;
      end if;
    end if;
  end if;
  -- A changed active assistant can invalidate memory just as a changed user can.
  -- Do not discard checkpoints that precede the changed logical exchange.
  if affected_turn is not null then
    delete from public.summary_versions where session_id=target_session and summarized_through_turn>=affected_turn;
    get diagnostics changed = row_count;
    if s.summary_last_turn>=affected_turn or changed>0 then
      if not exists(select 1 from public.summary_versions where session_id=target_session and is_active) then
        select id into fallback_id from public.summary_versions where session_id=target_session
          order by summarized_through_turn desc,created_at desc,id desc limit 1;
        if fallback_id is not null then update public.summary_versions set is_active=true where id=fallback_id; end if;
      end if;
      update public.sessions set summary=coalesce((select string_agg(content,E'\n\n--- Additional Summary Note ---\n\n' order by created_at,id)
          from public.summary_versions where session_id=target_session and is_active),''),
        summary_last_turn=coalesce((select max(summarized_through_turn) from public.summary_versions where session_id=target_session and is_active),0)
        where id=target_session;
      update public.messages set is_summarized=false where session_id=target_session and turn_index>=m.turn_index;
      if operation='edit' then select * into m from public.messages where id=target_message; end if;
    end if;
  end if;
  select * into s from public.sessions where id=target_session;
  return jsonb_build_object('deleted',operation='delete','message',case when operation='edit' then to_jsonb(m) else null end,
    'replacement',case when replacement.id is not null then to_jsonb(replacement) else null end,'session',to_jsonb(s));
end $$;
revoke all on function public.mutate_session_message(uuid,uuid,text,integer,uuid,text,text,uuid,text,uuid) from public,anon;
grant execute on function public.mutate_session_message(uuid,uuid,text,integer,uuid,text,text,uuid,text,uuid) to authenticated;
-- An acknowledged or lost selection of the already-active response is a no-op,
-- even when the caller still holds the previously active response ID.
create or replace function public.select_session_variant(target_session uuid,target_group uuid,
  target_message uuid,expected_active uuid default null) returns void
language plpgsql security invoker set search_path=public as $$
declare s public.sessions; m public.messages; selected_turn integer;
begin
  select * into s from public.sessions where id=target_session and user_id=(select auth.uid()) for update;
  if not found then raise exception 'Session is inaccessible' using errcode='42501'; end if;
  select * into m from public.messages where session_id=target_session and id=target_message
    and role='assistant' and coalesce(reroll_group_id,id)=target_group;
  if not found then raise exception 'Response is inaccessible' using errcode='42501'; end if;
  if m.is_active_variant and not exists(select 1 from public.messages where session_id=target_session
    and role='assistant' and id<>target_message and is_active_variant and coalesce(reroll_group_id,id)=target_group) then
    return;
  end if;
  if expected_active is not null and not exists(select 1 from public.messages where
    session_id=target_session and id=expected_active and is_active_variant
    and coalesce(reroll_group_id,id)=target_group) then
    raise exception 'Response selection changed; refresh and retry' using errcode='40001';
  end if;
  update public.messages set is_active_variant=(id=target_message),reroll_group_id=target_group
  where session_id=target_session and role='assistant' and coalesce(reroll_group_id,id)=target_group;
  select count(*) into selected_turn from public.messages where session_id=target_session
    and role='user' and not is_hidden and is_active_variant and turn_index<=m.turn_index;
  if s.summary_last_turn>=selected_turn then
    update public.summary_versions set is_active=false where session_id=target_session
      and summarized_through_turn>=selected_turn;
    if not exists(select 1 from public.summary_versions where session_id=target_session and is_active) then
      update public.summary_versions set is_active=true where id=(select id from public.summary_versions
        where session_id=target_session and summarized_through_turn<selected_turn
        order by summarized_through_turn desc,created_at desc,id desc limit 1);
    end if;
    update public.sessions set
      summary=coalesce((select string_agg(content,E'\n\n--- 추가 요약 노트 ---\n\n' order by created_at,id)
        from public.summary_versions where session_id=target_session and is_active),''),
      summary_last_turn=coalesce((select max(summarized_through_turn) from public.summary_versions
        where session_id=target_session and is_active),0)
    where id=target_session;
  end if;
end $$;

notify pgrst, 'reload schema';
