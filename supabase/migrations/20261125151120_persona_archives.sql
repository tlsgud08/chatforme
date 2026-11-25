-- Existing death rows keep their original snapshots and become deceased archives.
alter table public.platform_config add column persona_living_archive_prompt text not null default '';
alter table public.messages add column author_persona_id uuid;
alter table public.session_persona_deaths
  drop constraint session_persona_deaths_check,
  add column is_living boolean not null default false,
  add column may_appear boolean not null default false,
  add column image_url text,
  add column status_turn integer,
  add column archived_after_message_id uuid,
  add constraint persona_archive_status_reference check (status_message_id is null or status_block is not null),
  add constraint persona_archive_living_options check (is_living or (not may_appear and image_url is null));

update public.session_persona_deaths a set status_turn = m.turn_index
from public.messages m where m.id = a.status_message_id and m.session_id = a.session_id;

create index messages_persona_archive_history on public.messages (session_id, author_persona_id, turn_index desc, created_at desc, id desc)
where role = 'user' and author_persona_id is not null and is_active_variant and not is_hidden;

create function public.session_persona_archive_context(target_session uuid, include_voice boolean default false)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'persona', to_jsonb(p), 'archives', coalesce(history.records, '[]'::jsonb),
    'deathPrompt', coalesce(cfg.persona_death_prompt, ''),
    'livingPrompt', coalesce(cfg.persona_living_archive_prompt, '')
  )
  from public.sessions s
  left join public.personas p on p.id = s.persona_id and p.user_id = s.user_id
  left join public.platform_config cfg on cfg.id = 1
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'persona_id', a.persona_id, 'persona_name', a.persona_name, 'persona_description', a.persona_description,
      'status_block', a.status_block, 'status_turn', a.status_turn, 'note', a.death_note,
      'is_living', a.is_living, 'may_appear', a.may_appear, 'image_url', a.image_url, 'revision', a.request_id
    ) || case when voice.lines is null then '{}'::jsonb else jsonb_build_object('past_lines', voice.lines) end
    order by a.recorded_at, a.persona_id) as records
    from public.session_persona_deaths a
    left join lateral (
      select jsonb_agg(line.body order by line.turn_index, line.created_at, line.id) as lines
      from (
        select left(m.content, 600) as body, m.turn_index, m.created_at, m.id
        from public.messages m
        where include_voice and a.is_living and a.may_appear
          and m.session_id = a.session_id and m.author_persona_id = a.persona_id
          and m.role = 'user' and m.is_active_variant and not m.is_hidden and btrim(m.content) <> ''
        order by m.turn_index desc, m.created_at desc, m.id desc limit 5
      ) line
    ) voice on true
    where a.session_id = s.id
  ) history on true
  where s.id = target_session and s.user_id = (select auth.uid()) and s.multichat_room_id is null
$$;

-- The old context remains readable by an open client during rollout.
create or replace function public.session_persona_death_context(target_session uuid)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object('persona', c.value->'persona', 'deaths', coalesce((
    select jsonb_agg(jsonb_build_object('persona_id', a->'persona_id', 'persona_name', a->'persona_name',
      'persona_description', a->'persona_description', 'status_block', a->'status_block', 'death_note', a->'note') order by n)
    from jsonb_array_elements(c.value->'archives') with ordinality as records(a, n)
    where a->'is_living' = 'false'::jsonb
  ), '[]'::jsonb), 'prompt', case when exists (
    select 1 from jsonb_array_elements(c.value->'archives') a where a->'is_living' = 'false'::jsonb
  ) then c.value->'deathPrompt' else '""'::jsonb end)
  from (select public.session_persona_archive_context(target_session) as value) c where c.value is not null
$$;

create function public.session_persona_status_turn(target_session uuid, target_turn integer)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'content', m.content,
    'turn_index', m.turn_index, 'content_version', m.content_version)
    order by case when m.role = 'user' then 0 else 1 end, m.created_at, m.id), '[]'::jsonb)
  from public.messages m
  join public.sessions s on s.id = m.session_id
  where s.id = target_session and s.user_id = (select auth.uid()) and s.multichat_room_id is null
    and m.turn_index = target_turn and m.is_active_variant and not m.is_hidden and m.generation_status <> 'streaming'
$$;

create schema if not exists private;
grant usage on schema private to authenticated;

create function private.mutate_session_persona_archive(
  target_session uuid, target_persona uuid, operation text, mutation_id uuid,
  expected_revision uuid, next_persona uuid, changes jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare
  room public.sessions;
  pc public.personas;
  saved public.session_persona_deaths;
  source_message public.messages;
  archive_living boolean;
  archive_appearance boolean;
  archive_image text;
  archive_note text;
  status_action text;
  status_id uuid;
  status_text text;
  status_turn_number integer;
begin
  select * into room from public.sessions
    where id = target_session and user_id = (select auth.uid()) and multichat_room_id is null for update;
  if not found then
    raise exception '이 채팅방의 보관 기록을 변경할 수 없습니다.' using errcode = '42501';
  end if;
  if target_persona is null or mutation_id is null or operation is null or operation not in ('create', 'edit', 'delete') then
    raise exception '페르소나 보관 요청을 확인해 주세요.' using errcode = '22023';
  end if;
  select * into saved from public.session_persona_deaths a where a.session_id = room.id and a.persona_id = target_persona;
  if saved.request_id = mutation_id or (operation = 'delete' and saved.persona_id is null) then
    return public.session_persona_archive_context(room.id);
  end if;
  if (operation = 'create' and (saved.persona_id is not null or room.persona_id is distinct from target_persona))
    or (operation <> 'create' and (saved.persona_id is null or saved.request_id is distinct from expected_revision)) then
    raise exception '페르소나나 보관 기록이 변경되었습니다. 다시 불러와 주세요.' using errcode = 'PT409';
  end if;
  perform public.recover_expired_session_responses(room.id);
  if exists (select 1 from public.messages where session_id = room.id and generation_status = 'streaming') then
    raise exception '답변 생성이 끝난 뒤 보관 기록을 변경해 주세요.' using errcode = 'PT409';
  end if;
  if operation = 'delete' then
    delete from public.session_persona_deaths a where a.session_id = room.id and a.persona_id = target_persona;
    return public.session_persona_archive_context(room.id);
  end if;

  if jsonb_typeof(changes->'is_living') is distinct from 'boolean' or jsonb_typeof(changes->'may_appear') is distinct from 'boolean'
    or jsonb_typeof(changes->'note') is distinct from 'string' then
    raise exception '보관 상태를 다시 선택해 주세요.' using errcode = '22023';
  end if;
  archive_living := (changes->>'is_living')::boolean;
  archive_appearance := archive_living and (changes->>'may_appear')::boolean;
  archive_image := case when archive_living then nullif(btrim(changes->>'image_url'), '') end;
  archive_note := changes->>'note';
  if archive_image is not null and (length(archive_image) > 2048 or archive_image !~* '^https?://[^[:space:]<>]+$') then
    raise exception 'HTTP 또는 HTTPS 이미지 링크 한 개를 입력해 주세요.' using errcode = '22023';
  end if;
  status_action := changes->>'status_action';
  if status_action = 'keep' and operation = 'edit' then
    status_id := saved.status_message_id;
    status_text := saved.status_block;
    status_turn_number := saved.status_turn;
  elsif status_action = 'replace' then
    status_text := nullif(changes->>'status_block', '');
    if status_text is null then
      raise exception '상태창 코드블록을 다시 선택해 주세요.' using errcode = '22023';
    end if;
    select * into source_message from public.messages m
    where m.id = (changes->>'status_message')::uuid and m.session_id = room.id
      and m.content_version = (changes->>'status_version')::integer
      and not m.is_hidden and m.is_active_variant and m.generation_status <> 'streaming'
      and strpos(m.content, status_text) > 0 for share;
    if not found then
      raise exception '선택한 메시지가 변경되었습니다. 상태창을 다시 불러와 주세요.' using errcode = 'PT409';
    end if;
    status_id := source_message.id;
    status_turn_number := source_message.turn_index;
  elsif status_action is distinct from 'remove' then
    raise exception '상태창을 다시 선택해 주세요.' using errcode = '22023';
  end if;

  if operation = 'create' then
    select * into pc from public.personas where id = target_persona and user_id = room.user_id;
    if not found then raise exception '현재 페르소나를 찾지 못했습니다.' using errcode = 'PT409'; end if;
    if next_persona is not null and (next_persona = target_persona
       or not exists (select 1 from public.personas where id = next_persona and user_id = room.user_id)
       or exists (select 1 from public.session_persona_deaths a where a.session_id = room.id and a.persona_id = next_persona)) then
      raise exception '다음 페르소나를 다시 선택해 주세요.' using errcode = '22023';
    end if;
    insert into public.session_persona_deaths (
      session_id, persona_id, request_id, persona_name, persona_description, status_message_id,
      status_block, status_turn, death_note, is_living, may_appear, image_url, archived_after_message_id
    ) values (
      room.id, pc.id, mutation_id, pc.name, pc.description, status_id,
      status_text, status_turn_number, archive_note, archive_living, archive_appearance, archive_image,
      (select m.id from public.messages m where m.session_id = room.id and m.is_active_variant and not m.is_hidden
        order by m.turn_index desc, case when m.role = 'user' then 0 else 1 end desc, m.created_at desc, m.id desc limit 1)
    );
    update public.sessions set persona_id = next_persona where id = room.id;
  else
    update public.session_persona_deaths a set request_id = mutation_id, death_note = archive_note,
      status_message_id = status_id, status_block = status_text, status_turn = status_turn_number,
      is_living = archive_living, may_appear = archive_appearance, image_url = archive_image
    where a.session_id = room.id and a.persona_id = target_persona;
  end if;
  return public.session_persona_archive_context(room.id);
end $$;

create function public.mutate_session_persona_archive(
  target_session uuid, target_persona uuid, operation text, mutation_id uuid,
  expected_revision uuid, next_persona uuid, changes jsonb
) returns jsonb language sql security invoker set search_path = public, pg_temp as $$
  select private.mutate_session_persona_archive(target_session, target_persona, operation, mutation_id, expected_revision, next_persona, changes)
$$;

create or replace function public.record_session_persona_death(
  target_session uuid, expected_persona uuid, next_persona uuid, request_id uuid,
  death_note text, status_block text, status_message uuid, status_version integer
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if (status_message is null and (status_block is not null or status_version is not null))
    or (status_message is not null and (nullif(status_block, '') is null or status_version is null)) then
    raise exception '상태창 코드블록을 다시 선택해 주세요.' using errcode = '22023';
  end if;
  perform public.mutate_session_persona_archive(target_session, expected_persona, 'create', request_id, null, next_persona,
    jsonb_build_object('is_living', false, 'may_appear', false, 'note', coalesce(death_note, ''),
      'status_action', case when status_message is null then 'remove' else 'replace' end,
      'status_message', status_message, 'status_version', status_version, 'status_block', status_block));
  return public.session_persona_death_context(target_session);
end $$;

create or replace function public.guard_session_persona_death() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.session_persona_deaths a where a.session_id = new.id and a.persona_id = new.persona_id) then
    raise exception '이 채팅방에 보관된 페르소나는 보관 기록을 삭제한 뒤 다시 선택할 수 있습니다.' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.session_persona_deaths a where a.session_id = new.id)
    and exists (select 1 from public.messages where session_id = new.id and generation_status = 'streaming') then
    raise exception '답변 생성이 끝난 뒤 페르소나를 변경해 주세요.' using errcode = 'PT409';
  end if;
  return new;
end $$;

create function public.save_admin_settings_with_persona_archives(
  previous jsonb, desired jsonb, new_master_password text, previous_death_prompt text, desired_death_prompt text,
  previous_living_prompt text, desired_living_prompt text
) returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare current_living_prompt text;
begin
  if auth.uid() is null or not public.is_settings_admin() then
    raise exception '관리자만 설정을 변경할 수 있습니다.' using errcode = '42501';
  end if;
  if previous_living_prompt is null or desired_living_prompt is null then
    raise exception '페르소나 생존 보관 지침을 확인해 주세요.' using errcode = '22023';
  end if;
  select persona_living_archive_prompt into strict current_living_prompt from public.platform_config where id = 1 for update;
  if current_living_prompt is distinct from desired_living_prompt and current_living_prompt is distinct from previous_living_prompt then
    raise exception '다른 화면에서 관리자 설정이 변경되었습니다. 입력은 유지했습니다.' using errcode = '40001';
  end if;
  perform public.save_admin_settings_with_persona_death(previous, desired, new_master_password, previous_death_prompt, desired_death_prompt);
  update public.platform_config set persona_living_archive_prompt = desired_living_prompt where id = 1;
  return true;
end $$;

-- Keep the current RPCs and their grants. Add attribution at the only regular
-- chat insertion point with the locked session persona available.
do $$
declare definition text; updated text;
begin
  select pg_get_functiondef('public.begin_session_response(uuid,uuid,uuid,text,uuid,text,text,jsonb,text,integer,uuid,integer,integer,text)'::regprocedure) into definition;
  updated := replace(definition,
    'insert into public.messages(id,session_id,role,content,turn_index,command_id,command_name,command_prompt)',
    'insert into public.messages(id,session_id,role,content,turn_index,command_id,command_name,command_prompt,author_persona_id)');
  updated := replace(updated,
    'expected_turn,user_command_id,user_command_name,user_command_prompt) returning * into added',
    'expected_turn,user_command_id,user_command_name,user_command_prompt,s.persona_id) returning * into added');
  if updated = definition or position('user_command_prompt,s.persona_id)' in updated) = 0 then
    raise exception 'Response claim changed; review persona attribution.';
  end if;
  execute updated;

  select pg_get_functiondef('public.session_generation_context(uuid,integer,integer,boolean)'::regprocedure) into definition;
  updated := replace(definition, '''personaDeaths'',public.session_persona_death_context(target_session)',
    '''personaDeaths'',public.session_persona_death_context(target_session),''personaArchives'',public.session_persona_archive_context(target_session,true)');
  if updated = definition then raise exception 'Generation context changed; review archive delivery.'; end if;
  execute updated;
end $$;

create function private.branch_session_at_message_with_archives(
  target_session uuid, target_message uuid, branch_id uuid, expected_version integer
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sessions; m public.messages; target public.messages;
  copied public.messages; fork public.sessions; turns integer:=0; assistant_index integer:=0;
  valid_through integer; cache_id uuid;
  included_archives uuid[]; first_future_pc uuid; archive_refs uuid[];
  archive_anchors jsonb; copied_refs jsonb := '{}'::jsonb;
begin
  if exists (select 1 from public.multichat_rooms where id = target_session) then
    raise exception '멀티챗에서는 분기할 수 없습니다.';
  end if;
  if branch_id is null or branch_id=target_session or expected_version is null then
    raise exception 'Invalid branch request' using errcode='22023';
  end if;
  select * into s from public.sessions where id=target_session and user_id=(select auth.uid()) for update;
  if not found then raise exception 'Session is inaccessible' using errcode='42501'; end if;
  if exists(select 1 from public.sessions where id=branch_id and user_id=(select auth.uid())) then return branch_id; end if;
  select * into target from public.messages where session_id=target_session and id=target_message and is_active_variant;
  if not found then raise exception 'Branch source is inaccessible' using errcode='42501'; end if;
  if target.content_version<>expected_version then raise exception 'Branch source changed; refresh' using errcode='PT409'; end if;
  -- Existing clients may still write rows directly. Lock the source rows as well
  -- as the session so the copied history cannot change halfway through.
  perform 1 from public.messages where session_id=target_session for share;
  perform 1 from public.summary_versions where session_id=target_session for share;
  perform 1 from public.story_notes where session_id=target_session for share;
  select * into target from public.messages where id=target_message and session_id=target_session and is_active_variant;
  if not found or target.content_version<>expected_version then raise exception 'Branch source changed; refresh' using errcode='PT409'; end if;
  -- A record belongs to the scene that had been reached when it was saved.
  -- Older installations did not store that message ID, so infer it from the
  -- original archive timestamp and the surviving transcript.
  with locations as (
    select a.persona_id, a.recorded_at, a.status_message_id, anchor.id as anchor_id,
      anchor.id is null or
        (anchor.turn_index, case when anchor.role = 'user' then 0 else 1 end, anchor.created_at, anchor.id)
        <= (target.turn_index, case when target.role = 'user' then 0 else 1 end, target.created_at, target.id) as included
    from public.session_persona_deaths a
    left join lateral (
      select anchor_msg.id, anchor_msg.turn_index, anchor_msg.role, anchor_msg.created_at
      from public.messages anchor_msg where anchor_msg.session_id = target_session and (
        anchor_msg.id = a.archived_after_message_id or
        (anchor_msg.is_active_variant and not anchor_msg.is_hidden and anchor_msg.created_at <= a.recorded_at)
      )
      order by (anchor_msg.id is not distinct from a.archived_after_message_id) desc,
        anchor_msg.turn_index desc, case when anchor_msg.role = 'user' then 0 else 1 end desc, anchor_msg.created_at desc, anchor_msg.id desc
      limit 1
    ) anchor on true
    where a.session_id = target_session
  )
  select array_agg(persona_id order by recorded_at, persona_id) filter (where included),
    (array_agg(persona_id order by recorded_at, persona_id) filter (where not included))[1],
    coalesce(array_agg(anchor_id) filter (where included and anchor_id is not null), '{}'::uuid[])
      || coalesce(array_agg(status_message_id) filter (where included and status_message_id is not null), '{}'::uuid[]),
    jsonb_object_agg(persona_id::text, anchor_id) filter (where included and anchor_id is not null)
  into included_archives, first_future_pc, archive_refs, archive_anchors from locations;

  fork:=jsonb_populate_record(null::public.sessions,to_jsonb(s)||jsonb_build_object(
    'id',branch_id,'title',s.title||' (분기)','created_at',now(),'updated_at',now(),'is_archived',false,
    'summary','','summary_last_turn',0,'total_input_tokens',0,'total_output_tokens',0,'total_cost',0,
    'prompt_cache_message_id',null));
  if first_future_pc is not null then
    select p.id into fork.persona_id from public.personas p where p.id = first_future_pc and p.user_id = s.user_id;
  end if;
  insert into public.sessions select (fork).*;
  for m in select * from public.messages where session_id=target_session and is_active_variant
    order by turn_index,case when role='user' then 0 else 1 end,created_at,id
  loop
    if m.generation_status='streaming' then raise exception 'Response is still generating' using errcode='PT409'; end if;
    if m.role='user' and not m.is_hidden then turns:=turns+1; assistant_index:=0; end if;
    if m.role='assistant' then assistant_index:=assistant_index+1; end if;
    copied:=jsonb_populate_record(null::public.messages,to_jsonb(m)||jsonb_build_object(
      'id',gen_random_uuid(),'session_id',branch_id,'turn_index',turns,'reroll_group_id',null,
      'reroll_index',case when m.role='assistant' then assistant_index else 1 end,
      'is_summarized',false,'legacy_turn_conflict',false,'usage_accounted',true,'content_version',0));
    insert into public.messages select (copied).*;
    if m.id = any(archive_refs) then
      copied_refs := copied_refs || jsonb_build_object(m.id::text, jsonb_build_array(copied.id, copied.turn_index));
    end if;
    if m.id=s.prompt_cache_message_id then cache_id:=copied.id; end if;
    exit when m.id=target_message;
  end loop;
  insert into public.session_persona_deaths (
    session_id, persona_id, request_id, persona_name, persona_description, status_message_id,
    status_block, death_note, recorded_at, is_living, may_appear, image_url, status_turn, archived_after_message_id
  )
  select branch_id, a.persona_id, a.request_id, a.persona_name, a.persona_description,
    (copied_refs->a.status_message_id::text->>0)::uuid,
    a.status_block, a.death_note, a.recorded_at, a.is_living, a.may_appear, a.image_url,
    coalesce((copied_refs->a.status_message_id::text->>1)::integer, a.status_turn),
    (copied_refs->(archive_anchors->>a.persona_id::text)->>0)::uuid
  from public.session_persona_deaths a
  where a.session_id = target_session and a.persona_id = any(included_archives);

  -- A branch ending on a user message does not contain that turn's answer.
  valid_through:=case when target.role='assistant' and not target.is_hidden then turns else greatest(0,turns-1) end;
  insert into public.summary_versions(session_id,content,summarized_through_turn,is_active,input_tokens,output_tokens,cost,created_at,narrative_target_chars,narrative_target_enabled)
    select branch_id,content,summarized_through_turn,true,input_tokens,output_tokens,cost,created_at,narrative_target_chars,narrative_target_enabled
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

create or replace function public.branch_session_at_message(
  target_session uuid, target_message uuid, branch_id uuid, expected_version integer
) returns uuid language sql security invoker set search_path = public, pg_temp as $$
  select private.branch_session_at_message_with_archives(target_session, target_message, branch_id, expected_version)
$$;

revoke all on function public.session_persona_archive_context(uuid,boolean), public.session_persona_status_turn(uuid,integer),
  public.mutate_session_persona_archive(uuid,uuid,text,uuid,uuid,uuid,jsonb),
  public.save_admin_settings_with_persona_archives(jsonb,jsonb,text,text,text,text,text),
  private.mutate_session_persona_archive(uuid,uuid,text,uuid,uuid,uuid,jsonb),
  private.branch_session_at_message_with_archives(uuid,uuid,uuid,integer) from public, anon;
grant execute on function public.session_persona_archive_context(uuid,boolean), public.session_persona_status_turn(uuid,integer),
  public.mutate_session_persona_archive(uuid,uuid,text,uuid,uuid,uuid,jsonb),
  public.save_admin_settings_with_persona_archives(jsonb,jsonb,text,text,text,text,text),
  private.mutate_session_persona_archive(uuid,uuid,text,uuid,uuid,uuid,jsonb),
  private.branch_session_at_message_with_archives(uuid,uuid,uuid,integer) to authenticated;

notify pgrst, 'reload schema';
