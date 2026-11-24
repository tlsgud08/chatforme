-- Archive PC deaths as immutable snapshots owned by the individual chat room.
alter table public.platform_config add column persona_death_prompt text not null default '';

create table public.session_persona_deaths (
  session_id uuid not null references public.sessions(id) on delete cascade,
  persona_id uuid not null,
  request_id uuid not null,
  persona_name text not null,
  persona_description text not null,
  status_message_id uuid,
  status_block text,
  death_note text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (session_id, persona_id),
  check ((status_message_id is null) = (status_block is null))
);
alter table public.session_persona_deaths enable row level security;
revoke all on public.session_persona_deaths from public, anon, authenticated;
grant select on public.session_persona_deaths to authenticated;
create policy session_persona_deaths_read on public.session_persona_deaths
  for select to authenticated using (
    exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid()))
  );

create function public.session_persona_death_context(target_session uuid) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'persona', to_jsonb(p),
    'deaths', coalesce(history.records, '[]'::jsonb),
    'prompt', case when history.records is not null then
      coalesce((select persona_death_prompt from public.platform_config where id = 1), '') else '' end
  )
  from public.sessions s
  left join public.personas p on p.id = s.persona_id and p.user_id = s.user_id
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'persona_id', d.persona_id, 'persona_name', d.persona_name,
      'persona_description', d.persona_description, 'status_block', d.status_block,
      'death_note', d.death_note
    ) order by d.recorded_at, d.persona_id) as records
    from public.session_persona_deaths d where d.session_id = s.id
  ) history on true
  where s.id = target_session and s.user_id = (select auth.uid()) and s.multichat_room_id is null
$$;

create function public.record_session_persona_death(
  target_session uuid, expected_persona uuid, next_persona uuid, request_id uuid,
  death_note text, status_block text, status_message uuid, status_version integer
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare
  room public.sessions;
  pc public.personas;
begin
  select * into room from public.sessions
    where id = target_session and user_id = (select auth.uid()) and multichat_room_id is null for update;
  if not found then
    raise exception '이 채팅방에 사망 기록을 저장할 수 없습니다.' using errcode = '42501';
  end if;
  if request_id is null or expected_persona is null then
    raise exception '사망 처리할 페르소나를 선택해 주세요.' using errcode = '22023';
  end if;
  if exists (select 1 from public.session_persona_deaths d where d.session_id = target_session
      and d.persona_id = expected_persona and d.request_id = record_session_persona_death.request_id) then
    return public.session_persona_death_context(target_session);
  end if;
  if room.persona_id is distinct from expected_persona then
    raise exception '현재 페르소나가 변경되었습니다. 채팅방을 다시 열어 주세요.' using errcode = 'PT409';
  end if;
  perform public.recover_expired_session_responses(target_session);
  if exists (select 1 from public.messages where session_id = target_session and generation_status = 'streaming') then
    raise exception '답변 생성이 끝난 뒤 사망 처리해 주세요.' using errcode = 'PT409';
  end if;
  select * into pc from public.personas where id = expected_persona and user_id = room.user_id;
  if not found then
    raise exception '현재 페르소나를 찾지 못했습니다.' using errcode = 'PT409';
  end if;
  if next_persona is not null and (next_persona = expected_persona or not exists (
      select 1 from public.personas where id = next_persona and user_id = room.user_id
    ) or exists (select 1 from public.session_persona_deaths d where d.session_id = target_session and d.persona_id = next_persona)) then
    raise exception '다음 페르소나를 다시 선택해 주세요.' using errcode = '22023';
  end if;
  if status_message is not null then
    if status_block is null or length(status_block) = 0 or status_version is null then
      raise exception '상태창 코드블록을 다시 선택해 주세요.' using errcode = '22023';
    end if;
    perform 1 from public.messages m where m.id = status_message and m.session_id = target_session
      and m.content_version = status_version and not m.is_hidden and m.is_active_variant
      and m.generation_status <> 'streaming' and strpos(m.content, status_block) > 0 for share;
    if not found then
      raise exception '선택한 메시지가 변경되었습니다. 코드블록을 다시 불러와 주세요.' using errcode = 'PT409';
    end if;
  elsif status_block is not null or status_version is not null then
    raise exception '상태창 코드블록을 다시 선택해 주세요.' using errcode = '22023';
  end if;
  insert into public.session_persona_deaths (
    session_id, persona_id, request_id, persona_name, persona_description, status_message_id, status_block, death_note
  ) values (target_session, pc.id, request_id, pc.name, pc.description, status_message, status_block, coalesce(death_note, ''));
  update public.sessions set persona_id = next_persona where id = target_session;
  return public.session_persona_death_context(target_session);
end $$;

create function public.guard_session_persona_death() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.session_persona_deaths d where d.session_id = new.id and d.persona_id = new.persona_id) then
    raise exception '이 채팅방에서 사망한 페르소나는 다시 선택할 수 없습니다.' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.session_persona_deaths d where d.session_id = new.id)
    and exists (select 1 from public.messages where session_id = new.id and generation_status = 'streaming') then
    raise exception '답변 생성이 끝난 뒤 페르소나를 변경해 주세요.' using errcode = 'PT409';
  end if;
  return new;
end $$;
create trigger guard_session_persona_death before update of persona_id on public.sessions
for each row when (old.persona_id is distinct from new.persona_id)
execute function public.guard_session_persona_death();

revoke all on function public.session_persona_death_context(uuid),
  public.record_session_persona_death(uuid,uuid,uuid,uuid,text,text,uuid,integer),
  public.guard_session_persona_death() from public, anon, authenticated;
grant execute on function public.session_persona_death_context(uuid),
  public.record_session_persona_death(uuid,uuid,uuid,uuid,text,text,uuid,integer) to authenticated;

-- Changing the active persona or recording another death invalidates a stale
-- generation only in rooms that use the feature. Legacy room hashes are identical.
CREATE OR REPLACE FUNCTION public.session_response_context_hash(target_session uuid, excluded_message uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
select md5((jsonb_build_object('summary',s.summary,'turn',s.summary_last_turn,'messages',
 coalesce((select jsonb_agg(jsonb_build_array(m.id,m.content_version,m.is_active_variant,m.is_hidden,m.role,m.turn_index,
   m.command_id,m.command_name,md5(coalesce(m.command_prompt,''))) order by m.id)
 from public.messages m where m.session_id=s.id and m.id is distinct from excluded_message),'[]'::jsonb))
 || coalesce((select jsonb_build_object('persona',s.persona_id,'personaDeaths',jsonb_agg(d.request_id order by d.persona_id))
  from public.session_persona_deaths d where d.session_id=s.id having count(*)>0),'{}'::jsonb))::text)
from public.sessions s where s.id=target_session and s.user_id=(select auth.uid());
$function$;

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
    'contextHash',public.session_response_context_hash(target_session))
    || case when exists (select 1 from public.session_persona_deaths d where d.session_id=target_session) then
      jsonb_build_object('personaDeaths',public.session_persona_death_context(target_session)) else '{}'::jsonb end;
end $function$;

-- Keep the original administrator RPC usable during rollout and update the
-- new setting in the same transaction and with the same concurrent-edit check.
create function public.save_admin_settings_with_persona_death(
  previous jsonb, desired jsonb, new_master_password text, previous_death_prompt text, desired_death_prompt text
) returns boolean
language plpgsql security invoker set search_path = public, pg_temp as $$
declare current_death_prompt text;
begin
  if auth.uid() is null or not public.is_settings_admin() then
    raise exception '관리자만 설정을 변경할 수 있습니다.' using errcode = '42501';
  end if;
  if previous_death_prompt is null or desired_death_prompt is null then
    raise exception '페르소나 사망 처리 지침을 확인해 주세요.' using errcode = '22023';
  end if;
  select persona_death_prompt into strict current_death_prompt from public.platform_config where id = 1 for update;
  if current_death_prompt is distinct from desired_death_prompt and current_death_prompt is distinct from previous_death_prompt then
    raise exception '다른 화면에서 관리자 설정이 변경되었습니다. 입력은 유지했습니다.' using errcode = '40001';
  end if;
  perform public.save_admin_settings(previous, desired, new_master_password);
  update public.platform_config set persona_death_prompt = desired_death_prompt where id = 1;
  return true;
end $$;
revoke all on function public.save_admin_settings_with_persona_death(jsonb,jsonb,text,text,text) from public, anon;
grant execute on function public.save_admin_settings_with_persona_death(jsonb,jsonb,text,text,text) to authenticated;

notify pgrst, 'reload schema';
