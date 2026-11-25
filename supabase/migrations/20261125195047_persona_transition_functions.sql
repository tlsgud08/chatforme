set local lock_timeout = '3s';
create or replace function public.guard_session_persona_death() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if new.multichat_room_id is not null then return new; end if;
  if exists (select 1 from public.session_persona_deaths a where a.session_id = new.id and a.persona_id = new.persona_id
      and not a.is_living) then
    raise exception '이 채팅방에서 사망 보관된 페르소나는 선택할 수 없습니다.' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.messages where session_id = new.id and generation_status = 'streaming') then
    raise exception '답변 생성이 끝난 뒤 페르소나를 변경해 주세요.' using errcode = 'PT409';
  end if;
  -- At the first selection change in a legacy room, remember the outgoing
  -- selection on the latest untagged user turn. Do not replace known authors.
  with latest as (
    select m.id, m.author_persona_id, m.author_persona_name, m.created_at
    from public.messages m where m.session_id = old.id and m.role = 'user' and not m.is_hidden and m.is_active_variant
    order by m.turn_index desc, m.created_at desc, m.id desc limit 1
  )
  update public.messages m
  set author_persona_id = coalesce(legacy.persona_id, old.persona_id),
      author_persona_name = coalesce(legacy.persona_name, previous_pc.name, '')
  from latest
  left join public.personas previous_pc on previous_pc.id = old.persona_id and previous_pc.user_id = old.user_id
  left join lateral (
    select a.persona_id, a.persona_name from public.session_persona_deaths a
    where a.session_id = old.id and a.recorded_at >= latest.created_at
    order by a.recorded_at, a.persona_id limit 1
  ) legacy on true
  where m.id = latest.id and latest.author_persona_id is null and latest.author_persona_name is null
    and m.author_persona_id is null and m.author_persona_name is null;
  return new;
end $$;

create function public.session_persona_turn_context(target_session uuid)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'persona', to_jsonb(current_pc),
    'notice', case when coalesce(account.persona_transition_notice_enabled, true)
      and current_pc.id is not null and prior.id is distinct from current_pc.id and prior.name is not null
      then jsonb_build_object('from', prior.name, 'to', current_pc.name,
        'template', coalesce(config.persona_transition_notice_template, ''))
      else null end
  )
  from public.sessions s
  left join public.personas current_pc on current_pc.id = s.persona_id and current_pc.user_id = s.user_id
  left join public.profiles account on account.id = s.user_id
  left join public.platform_config config on config.id = 1
  left join lateral (
    select m.author_persona_id, m.author_persona_name, m.created_at
    from public.messages m where m.session_id = s.id and m.role = 'user' and not m.is_hidden and m.is_active_variant
    order by m.turn_index desc, m.created_at desc, m.id desc limit 1
  ) latest on true
  left join lateral (
    -- Older archives recorded before turn attribution was available can still
    -- identify the outgoing PC when the archive immediately follows that turn.
    select a.persona_id, a.persona_name from public.session_persona_deaths a
    where latest.author_persona_id is null and latest.author_persona_name is null
      and a.session_id = s.id and a.recorded_at >= latest.created_at
    order by a.recorded_at, a.persona_id limit 1
  ) legacy_archive on true
  left join public.personas old_pc on old_pc.id = latest.author_persona_id and old_pc.user_id = s.user_id
  left join public.session_persona_deaths old_archive on old_archive.session_id = s.id and old_archive.persona_id = latest.author_persona_id
  cross join lateral (
    select coalesce(latest.author_persona_id, legacy_archive.persona_id) as id,
      nullif(coalesce(latest.author_persona_name, old_pc.name, old_archive.persona_name, legacy_archive.persona_name), '') as name
  ) prior
  where s.id = target_session and s.user_id = (select auth.uid()) and s.multichat_room_id is null
$$;

-- Lock the selected PC against the same snapshot used to build the user turn.
-- The existing signature continues to serve already-open clients and retries.
create function public.begin_session_response(
  target_session uuid, response_id uuid, user_message_id uuid, user_text text,
  user_command_id uuid, user_command_name text, user_command_prompt text, source_versions jsonb,
  expected_summary text, expected_summary_turn integer, reroll_message uuid,
  requested_turn integer, requested_variant integer, expected_context_hash text, expected_persona uuid
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare active_persona uuid;
begin
  select s.persona_id into active_persona from public.sessions s
    where s.id = target_session and s.user_id = (select auth.uid()) and s.multichat_room_id is null for update;
  if not found then raise exception 'Session is inaccessible' using errcode = '42501'; end if;
  if active_persona is distinct from expected_persona and not exists (
    select 1 from public.messages m where m.id = response_id and m.session_id = target_session and m.role = 'assistant'
  ) then
    raise exception 'Persona changed; preserve input and refresh' using errcode = 'PT409';
  end if;
  return public.begin_session_response(target_session, response_id, user_message_id, user_text,
    user_command_id, user_command_name, user_command_prompt, source_versions, expected_summary,
    expected_summary_turn, reroll_message, requested_turn, requested_variant, expected_context_hash);
end $$;

create function public.save_admin_settings_with_persona_transition(
  previous jsonb, desired jsonb, new_master_password text, previous_death_prompt text, desired_death_prompt text,
  previous_living_prompt text, desired_living_prompt text, previous_transition_template text, desired_transition_template text
) returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare current_template text;
begin
  if auth.uid() is null or not public.is_settings_admin() then
    raise exception '관리자만 설정을 변경할 수 있습니다.' using errcode = '42501';
  end if;
  if previous_transition_template is null or desired_transition_template is null then
    raise exception '페르소나 전환 문구를 확인해 주세요.' using errcode = '22023';
  end if;
  select persona_transition_notice_template into strict current_template from public.platform_config where id = 1 for update;
  if current_template is distinct from desired_transition_template and current_template is distinct from previous_transition_template then
    raise exception '다른 화면에서 관리자 설정이 변경되었습니다. 입력은 유지했습니다.' using errcode = '40001';
  end if;
  perform public.save_admin_settings_with_persona_archives(previous, desired, new_master_password, previous_death_prompt,
    desired_death_prompt, previous_living_prompt, desired_living_prompt);
  update public.platform_config set persona_transition_notice_template = desired_transition_template where id = 1;
  return true;
end $$;

revoke all on function public.session_persona_turn_context(uuid),
  public.begin_session_response(uuid,uuid,uuid,text,uuid,text,text,jsonb,text,integer,uuid,integer,integer,text,uuid),
  public.save_admin_settings_with_persona_transition(jsonb,jsonb,text,text,text,text,text,text,text) from public, anon;
grant execute on function public.session_persona_turn_context(uuid),
  public.begin_session_response(uuid,uuid,uuid,text,uuid,text,text,jsonb,text,integer,uuid,integer,integer,text,uuid),
  public.save_admin_settings_with_persona_transition(jsonb,jsonb,text,text,text,text,text,text,text) to authenticated;
