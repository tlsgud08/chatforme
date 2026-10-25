-- Additive APIs; existing clients and data remain compatible.
create or replace function public.work_editor_snapshot(target_work uuid) returns jsonb
language sql stable security invoker set search_path=public as $$
select jsonb_build_object('work',jsonb_build_object('title',w.title,'description',w.description,'main_prompt',w.main_prompt,'multichat_prompt',w.multichat_prompt,'thumbnail_url',w.thumbnail_url,'default_theme_id',w.default_theme_id,'default_theme_variant',w.default_theme_variant,'visibility',w.visibility),
 'starts',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'initial_message',c.initial_message,'initial_context',c.initial_context,'keep_turns',c.keep_turns,'is_default',c.is_default) order by c.id) from public.start_configs c where c.work_id=w.id),'[]'::jsonb),
 'keywords',coalesce((select jsonb_agg(jsonb_build_object('id',k.id,'name',k.name,'keywords',k.keywords,'content',k.content,'activation_turns',k.activation_turns) order by k.id) from public.keyword_books k where k.work_id=w.id),'[]'::jsonb))
from public.works w where w.id=target_work;
$$;

create or replace function public.save_work_editor(target_work uuid,previous jsonb,desired jsonb)
returns boolean language plpgsql security invoker set search_path=public as $$
declare w public.works; row public.start_configs; book public.keyword_books; item jsonb; current_value jsonb; changed integer;
begin
 if (select auth.uid()) is null or not public.can_edit_work(target_work) then raise exception 'Work is inaccessible' using errcode='42501'; end if;
 select * into w from public.works where id=target_work for update;
 if not found then raise exception 'Work is inaccessible' using errcode='42501'; end if;
 perform 1 from public.start_configs where work_id=target_work for update;
 perform 1 from public.keyword_books where work_id=target_work for update;
 current_value:=public.work_editor_snapshot(target_work);
 if current_value=desired then return true; end if;
 if current_value is distinct from previous then raise exception 'Work changed; preserve edits' using errcode='40001'; end if;
 if jsonb_typeof(desired->'work') is distinct from 'object' or jsonb_typeof(desired->'starts') is distinct from 'array'
   or jsonb_typeof(desired->'keywords') is distinct from 'array' then raise exception 'Invalid work snapshot' using errcode='22023'; end if;
 if (select jsonb_agg(v->'id' order by v->>'id') from jsonb_array_elements(previous->'starts') v)
    is distinct from (select jsonb_agg(v->'id' order by v->>'id') from jsonb_array_elements(desired->'starts') v)
 or (select jsonb_agg(v->'id' order by v->>'id') from jsonb_array_elements(previous->'keywords') v)
    is distinct from (select jsonb_agg(v->'id' order by v->>'id') from jsonb_array_elements(desired->'keywords') v)
 then raise exception 'Related rows changed' using errcode='40001'; end if;
 w:=jsonb_populate_record(w,desired->'work');
 if length(w.title)>30 or length(w.description)>1000 then raise exception 'Invalid work text' using errcode='22023'; end if;
 update public.works set title=w.title,description=w.description,main_prompt=w.main_prompt,multichat_prompt=w.multichat_prompt,
 thumbnail_url=w.thumbnail_url,default_theme_id=w.default_theme_id,default_theme_variant=w.default_theme_variant,
 visibility=w.visibility,is_published=(w.visibility='public'),updated_at=clock_timestamp() where id=target_work;
 get diagnostics changed=row_count;
 if changed<>1 then raise exception 'Work write denied' using errcode='42501'; end if;
 for item in select value from jsonb_array_elements(desired->'starts') loop
  select * into row from public.start_configs where id=(item->>'id')::uuid and work_id=target_work;
  if not found then raise exception 'Start setting changed' using errcode='40001'; end if;
  row:=jsonb_populate_record(row,item);
  if nullif(trim(row.name),'') is null or nullif(trim(row.initial_message),'') is null then raise exception 'Invalid start setting' using errcode='22023'; end if;
  update public.start_configs set name=row.name,initial_message=row.initial_message,initial_context=row.initial_context,
    keep_turns=row.keep_turns,is_default=row.is_default where id=row.id and work_id=target_work;
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'Start setting write denied' using errcode='42501'; end if;
 end loop;
 for item in select value from jsonb_array_elements(desired->'keywords') loop
  select * into book from public.keyword_books where id=(item->>'id')::uuid and work_id=target_work;
  if not found then raise exception 'Keyword book changed' using errcode='40001'; end if;
  book:=jsonb_populate_record(book,item);
  update public.keyword_books set name=book.name,keywords=book.keywords,content=book.content,activation_turns=book.activation_turns
    where id=book.id and work_id=target_work;
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'Keyword write denied' using errcode='42501'; end if;
 end loop;
 -- Detect triggers or scope guards that prevented the requested result.
 if public.work_editor_snapshot(target_work) is distinct from desired then raise exception 'Work snapshot was not saved' using errcode='40001'; end if;
 return true;
end $$;
revoke all on function public.work_editor_snapshot(uuid),public.save_work_editor(uuid,jsonb,jsonb) from public,anon;
grant execute on function public.work_editor_snapshot(uuid),public.save_work_editor(uuid,jsonb,jsonb) to authenticated;

-- Managed response attempts use server-created rows and a source fingerprint.
-- No periodic writes: the client's 8-minute limit is below this 15-minute grace.
alter table public.messages add column if not exists generation_context_hash text;
alter table public.messages add column if not exists generation_context_conflict boolean not null default false;

create or replace function public.session_response_context_hash(target_session uuid,excluded_message uuid default null)
returns text language sql stable security invoker set search_path=public as $$
select md5(jsonb_build_object('summary',s.summary,'turn',s.summary_last_turn,'messages',
 coalesce((select jsonb_agg(jsonb_build_array(m.id,m.content_version,m.is_active_variant,m.is_hidden,m.role,m.turn_index,
   m.command_id,m.command_name,md5(coalesce(m.command_prompt,''))) order by m.id)
 from public.messages m where m.session_id=s.id and m.id is distinct from excluded_message),'[]'::jsonb))::text)
from public.sessions s where s.id=target_session and s.user_id=(select auth.uid());
$$;

create or replace function public.recover_expired_session_responses(target_session uuid)
returns integer language plpgsql security invoker set search_path=public as $$
declare changed integer;
begin
 perform 1 from public.sessions where id=target_session and user_id=(select auth.uid()) for update;
 if not found then raise exception 'Session is inaccessible' using errcode='42501'; end if;
 update public.messages set generation_status='interrupted' where session_id=target_session
   and generation_status='streaming' and created_at<clock_timestamp()-interval '15 minutes';
 get diagnostics changed=row_count;
 return changed;
end $$;

create or replace function public.begin_session_response(target_session uuid,response_id uuid,user_message_id uuid,
 user_text text,user_command_id uuid,user_command_name text,user_command_prompt text,
 source_versions jsonb,expected_summary text,expected_summary_turn integer,
 reroll_message uuid default null,requested_turn integer default null,requested_variant integer default 1,expected_context_hash text default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
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
   raise exception 'Another response is generating; refresh' using errcode='40001'; end if;
 -- Lock the rows old clients can still mutate directly until the claim commits.
 perform 1 from public.messages where session_id=target_session for share;
 if expected_context_hash is not null then
  if expected_context_hash is distinct from public.session_response_context_hash(target_session) then
   raise exception 'Dialogue changed; preserve input and refresh' using errcode='40001'; end if;
 else
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',content_version,'active',is_active_variant) order by id),'[]'::jsonb)
  into current_sources from public.messages where session_id=target_session;
  select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'version',v.version,'active',v.active) order by v.id),'[]'::jsonb)
  into wanted_sources from jsonb_to_recordset(source_versions) v(id uuid,version integer,active boolean);
  if current_sources is distinct from wanted_sources then raise exception 'Dialogue changed; preserve input and refresh' using errcode='40001'; end if;
 end if;
 if s.summary is distinct from expected_summary or s.summary_last_turn is distinct from expected_summary_turn then
  raise exception 'Summary changed; preserve input and refresh' using errcode='40001'; end if;
 if reroll_message is not null then
  select * into source from public.messages where id=reroll_message and session_id=target_session and role='assistant' and is_active_variant;
  if not found then raise exception 'Reroll source changed' using errcode='40001'; end if;
  group_id:=coalesce(source.reroll_group_id,source.id); expected_turn:=source.turn_index;
  if requested_variant is distinct from (select coalesce(max(reroll_index),0)+1 from public.messages
    where session_id=target_session and role='assistant' and coalesce(reroll_group_id,id)=group_id) then
    raise exception 'Response variant changed' using errcode='40001'; end if;
 else
  select coalesce(max(turn_index),0)+1 into expected_turn from public.messages where session_id=target_session and not is_hidden and is_active_variant;
  if requested_variant is distinct from 1 then raise exception 'Invalid variant' using errcode='22023'; end if;
 end if;
 if requested_turn is distinct from expected_turn then raise exception 'Turn changed' using errcode='40001'; end if;
 if reroll_message is null and user_message_id is not null then
  insert into public.messages(id,session_id,role,content,turn_index,command_id,command_name,command_prompt)
  values(user_message_id,target_session,'user',coalesce(user_text,''),expected_turn,user_command_id,user_command_name,user_command_prompt) returning * into added;
 end if;
 stamp:=public.session_response_context_hash(target_session);
 insert into public.messages(id,session_id,role,content,turn_index,reroll_group_id,reroll_index,is_active_variant,generation_status,generation_context_hash)
 values(response_id,target_session,'assistant','',expected_turn,group_id,requested_variant,reroll_message is null,'streaming',stamp) returning * into draft;
 return jsonb_build_object('draft',to_jsonb(draft),'userMessage',case when added.id is not null then to_jsonb(added) else null end,'replayed',false);
end $$;
revoke all on function public.session_response_context_hash(uuid,uuid),public.recover_expired_session_responses(uuid),
 public.begin_session_response(uuid,uuid,uuid,text,uuid,text,text,jsonb,text,integer,uuid,integer,integer,text) from public,anon;
grant execute on function public.session_response_context_hash(uuid,uuid),public.recover_expired_session_responses(uuid),
 public.begin_session_response(uuid,uuid,uuid,text,uuid,text,text,jsonb,text,integer,uuid,integer,integer,text) to authenticated;

create or replace function public.finish_session_response(target_session uuid,target_message uuid,
  response_text text,in_tokens integer,out_tokens integer,response_cost numeric,
  read_tokens integer,write_tokens integer,target_group uuid default null,
  previous_message uuid default null,previous_summary text default null,previous_summary_turn integer default null,
  restored_summary text default null,restored_summary_turn integer default null,restored_versions uuid[] default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare s public.sessions; m public.messages;
begin
  select * into s from public.sessions where id=target_session and user_id=(select auth.uid()) for update;
  if not found then raise exception 'Session is inaccessible' using errcode='42501'; end if;
  select * into m from public.messages where id=target_message and session_id=target_session and role='assistant' for update;
  if not found then raise exception 'Response is inaccessible' using errcode='42501'; end if;
  perform 1 from public.messages where session_id=target_session and id<>target_message for share;
  if not m.usage_accounted and m.generation_context_hash is not null
    and m.generation_context_hash is distinct from public.session_response_context_hash(target_session,target_message) then
    update public.messages set content=response_text,input_tokens=greatest(in_tokens,0),output_tokens=greatest(out_tokens,0),cost=greatest(response_cost,0),
      cache_read_tokens=read_tokens,cache_write_tokens=write_tokens,generation_status='interrupted',is_active_variant=false,
      usage_accounted=true,generation_context_hash=null,generation_context_conflict=true where id=target_message returning * into m;
    update public.sessions set total_input_tokens=total_input_tokens+m.input_tokens,total_output_tokens=total_output_tokens+m.output_tokens,
      total_cost=total_cost+m.cost,updated_at=now() where id=target_session;
  end if;
  if not m.usage_accounted then
    if target_group is not null then
      perform public.select_session_variant(target_session,target_group,target_message,previous_message);
    end if;
    update public.messages set content=response_text,input_tokens=greatest(in_tokens,0),
      output_tokens=greatest(out_tokens,0),cost=greatest(response_cost,0),cache_read_tokens=read_tokens,
      cache_write_tokens=write_tokens,generation_status='complete',usage_accounted=true,generation_context_hash=null
    where id=target_message returning * into m;
    update public.sessions set total_input_tokens=total_input_tokens+m.input_tokens,
      total_output_tokens=total_output_tokens+m.output_tokens,total_cost=total_cost+m.cost,updated_at=now()
    where id=target_session;
    -- A different tab's newer memory must never be overwritten by this response.
    if restored_summary is not null and s.summary is not distinct from previous_summary
      and s.summary_last_turn is not distinct from previous_summary_turn then
      if exists(select 1 from unnest(coalesce(restored_versions,'{}')) v
        where not exists(select 1 from public.summary_versions where id=v and session_id=target_session)) then
        raise exception 'Summary selection is inaccessible' using errcode='42501';
      end if;
      update public.summary_versions set is_active=(id=any(coalesce(restored_versions,'{}'))) where session_id=target_session;
      update public.sessions set summary=restored_summary,summary_last_turn=restored_summary_turn where id=target_session;
    end if;
  end if;
  select * into s from public.sessions where id=target_session;
  return jsonb_build_object('message',to_jsonb(m),'session',to_jsonb(s),'contextConflict',m.generation_context_conflict);
end $$;

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
  if exists(select 1 from public.messages where session_id=target_session and generation_status='streaming'
    and id is distinct from null::uuid and created_at>=clock_timestamp()-interval '15 minutes') then
    raise exception 'Response is generating in another screen' using errcode='40001';
  end if;
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

create or replace function public.select_session_variant(target_session uuid,target_group uuid,
  target_message uuid,expected_active uuid default null) returns void
language plpgsql security invoker set search_path=public as $$
declare s public.sessions; m public.messages; selected_turn integer;
begin
  select * into s from public.sessions where id=target_session and user_id=(select auth.uid()) for update;
  if not found then raise exception 'Session is inaccessible' using errcode='42501'; end if;
  if exists(select 1 from public.messages where session_id=target_session and generation_status='streaming'
    and id is distinct from target_message::uuid and created_at>=clock_timestamp()-interval '15 minutes') then
    raise exception 'Response is generating in another screen' using errcode='40001';
  end if;
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

create or replace function public.mutate_session_summary(target_session uuid,operation text,
  target_version uuid default null,summary_text text default null,selected_ids uuid[] default '{}') returns jsonb
language plpgsql security invoker set search_path=public as $$
declare s public.sessions; target_active boolean;
begin
  select * into s from public.sessions where id=target_session and user_id=(select auth.uid()) for update;
  if not found then raise exception 'Session is inaccessible' using errcode='42501'; end if;
  if exists(select 1 from public.messages where session_id=target_session and generation_status='streaming'
    and id is distinct from null::uuid and created_at>=clock_timestamp()-interval '15 minutes') then
    raise exception 'Response is generating in another screen' using errcode='40001';
  end if;
  if operation in ('edit','delete') then
    select is_active into target_active from public.summary_versions where id=target_version and session_id=target_session;
    if not found then raise exception 'Summary is inaccessible' using errcode='42501'; end if;
  end if;
  if operation='edit' then
    if nullif(trim(summary_text),'') is null then raise exception 'Summary is empty'; end if;
    update public.summary_versions set content=summary_text where id=target_version;
    if not target_active then return to_jsonb(s); end if;
  elsif operation='delete' then
    delete from public.summary_versions where id=target_version;
    if not target_active then return to_jsonb(s); end if;
    if not exists(select 1 from public.summary_versions where session_id=target_session and is_active) then
      update public.summary_versions set is_active=true where id=(select id from public.summary_versions
        where session_id=target_session order by created_at desc,id desc limit 1);
    end if;
  elsif operation='select' then
    if exists(select 1 from unnest(selected_ids) v where not exists(select 1 from public.summary_versions
      where id=v and session_id=target_session)) then raise exception 'Summary is inaccessible' using errcode='42501'; end if;
    update public.summary_versions set is_active=(id=any(selected_ids)) where session_id=target_session;
  else raise exception 'Invalid summary operation'; end if;
  update public.sessions set
    summary=coalesce((select string_agg(content,E'\n\n--- 추가 요약 노트 ---\n\n' order by created_at,id)
      from public.summary_versions where session_id=target_session and is_active),''),
    summary_last_turn=coalesce((select max(summarized_through_turn) from public.summary_versions where session_id=target_session and is_active),0)
  where id=target_session returning * into s;
  return to_jsonb(s);
end $$;

-- Preserve interrupted output without marking it complete or inventing usage.
create or replace function public.interrupt_session_response(target_session uuid,target_message uuid,response_text text,
 target_group uuid default null,previous_message uuid default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare s public.sessions; m public.messages; conflict boolean;
begin
 select * into s from public.sessions where id=target_session and user_id=(select auth.uid()) for update;
 if not found then raise exception 'Session is inaccessible' using errcode='42501'; end if;
 select * into m from public.messages where id=target_message and session_id=target_session and role='assistant' for update;
 if not found then raise exception 'Response is inaccessible' using errcode='42501'; end if;
 if m.usage_accounted then return jsonb_build_object('message',to_jsonb(m),'session',to_jsonb(s),'contextConflict',m.generation_context_conflict); end if;
 perform 1 from public.messages where session_id=target_session and id<>target_message for share;
 if m.generation_status='interrupted' then
   if m.content is distinct from response_text then raise exception 'Interrupted response changed; preserve copy' using errcode='40001'; end if;
 else
   if m.generation_status<>'streaming' then raise exception 'Response changed' using errcode='40001'; end if;
   conflict:=m.generation_context_hash is not null and m.generation_context_hash is distinct from public.session_response_context_hash(target_session,target_message);
   update public.messages set content=coalesce(response_text,''),generation_status='interrupted',generation_context_hash=null,
     generation_context_conflict=conflict,is_active_variant=case when conflict then false else is_active_variant end where id=target_message returning * into m;
 end if;
 if target_group is not null and not m.generation_context_conflict then
   perform public.select_session_variant(target_session,target_group,target_message,previous_message);
   select * into m from public.messages where id=target_message;
   select * into s from public.sessions where id=target_session;
 end if;
 return jsonb_build_object('message',to_jsonb(m),'session',to_jsonb(s),'contextConflict',m.generation_context_conflict);
end $$;
revoke all on function public.interrupt_session_response(uuid,uuid,text,uuid,uuid) from public,anon;
grant execute on function public.interrupt_session_response(uuid,uuid,text,uuid,uuid) to authenticated;

create or replace function public.session_generation_context(target_session uuid,after_summary integer default 0,
  keyword_turns integer default 0,reroll boolean default false) returns jsonb
language plpgsql stable security invoker set search_path=public as $$
declare result jsonb; memory text; cutoff integer;
begin
  select summary,summary_last_turn into memory,cutoff from public.sessions where id=target_session and user_id=(select auth.uid());
  if not found then
    raise exception 'Session is inaccessible' using errcode='42501'; end if;
  with positions as (
    select id,count(*) filter(where role='user' and not is_hidden and is_active_variant)
      over(order by turn_index,case when role='user' then 0 else 1 end,created_at,id) as position
    from public.messages where session_id=target_session
  ), total as (select count(*) n from public.messages where session_id=target_session
    and role='user' and not is_hidden and is_active_variant)
  select jsonb_agg(case when m.is_active_variant and (reroll or m.is_hidden or p.position>cutoff
      or (m.role='user' and p.position>t.n-greatest(keyword_turns,1))) then to_jsonb(m)
    else jsonb_build_object('id',m.id,'session_id',m.session_id,'role',m.role,'content','',
      'turn_index',m.turn_index,'is_hidden',m.is_hidden,'is_active_variant',m.is_active_variant,
      'reroll_group_id',m.reroll_group_id,'reroll_index',m.reroll_index,'created_at',m.created_at,
      'input_tokens',m.input_tokens,'output_tokens',m.output_tokens,'cost',m.cost,
      'cache_read_tokens',m.cache_read_tokens,'cache_write_tokens',m.cache_write_tokens,
      'is_summarized',m.is_summarized,'generation_status',m.generation_status,
      'command_id',m.command_id,'command_name',m.command_name,'command_prompt',null,
      'content_version',m.content_version,'content_omitted',true) end
    order by m.turn_index,case when m.role='user' then 0 else 1 end,m.created_at,m.id)
  into result from positions p join public.messages m on m.id=p.id cross join total t;
  return jsonb_build_object('messages',coalesce(result,'[]'),'summary',memory,'summaryLastTurn',cutoff,'contextHash',public.session_response_context_hash(target_session));
end $$;

-- Long prompts travel in the RPC body, never in URL equality filters.
create or replace function public.save_platform_prompts(previous jsonb,desired jsonb)
returns boolean language plpgsql security invoker set search_path=public as $$
declare cfg public.platform_config; current_value jsonb; changed integer;
begin
 if (select auth.uid()) is null or not public.is_app_admin() then raise exception 'Administrator only' using errcode='42501'; end if;
 select * into cfg from public.platform_config where id=1 for update;
 if not found then raise exception 'Configuration is inaccessible' using errcode='42501'; end if;
 current_value:=jsonb_build_object('system_prompt',cfg.system_prompt,'theme_prompt',cfg.theme_prompt,'multichat_system_prompt',cfg.multichat_system_prompt);
 if current_value=desired then return true; end if;
 if current_value is distinct from previous then raise exception 'Configuration changed; preserve edits' using errcode='40001'; end if;
 if jsonb_typeof(desired->'system_prompt') is distinct from 'string' or jsonb_typeof(desired->'theme_prompt') is distinct from 'string'
  or jsonb_typeof(desired->'multichat_system_prompt') is distinct from 'string' then raise exception 'Invalid prompts' using errcode='22023'; end if;
 update public.platform_config set system_prompt=desired->>'system_prompt',theme_prompt=desired->>'theme_prompt',
  multichat_system_prompt=desired->>'multichat_system_prompt',updated_at=clock_timestamp() where id=1;
 get diagnostics changed=row_count;
 if changed<>1 then raise exception 'Configuration write denied' using errcode='42501'; end if;
 return true;
end $$;
revoke all on function public.save_platform_prompts(jsonb,jsonb) from public,anon;
grant execute on function public.save_platform_prompts(jsonb,jsonb) to authenticated;

notify pgrst, 'reload schema';
