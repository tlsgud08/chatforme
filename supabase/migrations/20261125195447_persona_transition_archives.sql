set local lock_timeout = '3s';
CREATE OR REPLACE FUNCTION private.mutate_session_persona_archive(target_session uuid, target_persona uuid, operation text, mutation_id uuid, expected_revision uuid, next_persona uuid, changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
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
  if (operation = 'create' and ((saved.persona_id is not null and (not saved.is_living or saved.request_id is distinct from expected_revision))
      or room.persona_id is distinct from target_persona))
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
  if status_action = 'keep' and saved.persona_id is not null then
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
       or exists (select 1 from public.session_persona_deaths a where a.session_id = room.id and a.persona_id = next_persona and not a.is_living)) then
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
    )
    on conflict (session_id, persona_id) do update set
      request_id = excluded.request_id, persona_name = excluded.persona_name, persona_description = excluded.persona_description,
      status_message_id = excluded.status_message_id, status_block = excluded.status_block, status_turn = excluded.status_turn,
      death_note = excluded.death_note, is_living = excluded.is_living, may_appear = excluded.may_appear,
      image_url = excluded.image_url, archived_after_message_id = excluded.archived_after_message_id,
      recorded_at = excluded.recorded_at;
    update public.sessions set persona_id = next_persona where id = room.id;
  else
    if room.persona_id = target_persona and not archive_living then
      raise exception '플레이 중인 페르소나는 현재 페르소나 보관에서 사망 처리해 주세요.' using errcode = 'PT409';
    end if;
    update public.session_persona_deaths a set request_id = mutation_id, death_note = archive_note,
      status_message_id = status_id, status_block = status_text, status_turn = status_turn_number,
      is_living = archive_living, may_appear = archive_appearance, image_url = archive_image
    where a.session_id = room.id and a.persona_id = target_persona;
  end if;
  return public.session_persona_archive_context(room.id);
end $function$;
