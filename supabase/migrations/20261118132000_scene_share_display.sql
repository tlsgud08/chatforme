create or replace function scene_sharing.prepare(p_session uuid, p_start integer, p_end integer, p_hide boolean)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  scene jsonb;
  scene_title text;
  scene_thumbnail text;
  has_streaming boolean;
  has_end_turn boolean;
  messages jsonb;
begin
  if auth.uid() is null or p_hide is null or p_start is null or p_end is null
    or p_start < 0 or p_end < p_start or p_end::bigint - p_start >= 20 then
    raise exception 'SCENE_INVALID_RANGE';
  end if;

  select coalesce(nullif(btrim(left(s.title, 100)), ''), nullif(btrim(left(w.title, 100)), ''), '공유 장면'),
    case when w.thumbnail_url like 'https://%' then w.thumbnail_url else null end
  into scene_title, scene_thumbnail
  from public.sessions s left join public.works w on w.id = s.work_id
    and (w.creator_id = auth.uid() or w.visibility in ('public', 'unlisted'))
  where s.id = p_session and s.user_id = auth.uid() and s.multichat_room_id is null;
  if not found then raise exception 'SCENE_NOT_FOUND'; end if;

  -- Match the chat's displayed turn labels even when an earlier turn was deleted.
  with numbered as (
    select id, turn_index,
      count(*) filter (where role = 'user') over (
        order by turn_index, case when role = 'user' then 0 else 1 end, created_at, id
        rows unbounded preceding
      ) as display_turn
    from public.messages
    where session_id = p_session and turn_index >= 0
      and role in ('user', 'assistant') and is_hidden is not true and is_active_variant is not false
  ), selected as (
    select m.id, m.role, n.display_turn, n.turn_index, m.created_at, m.generation_status,
      case when m.role = 'user' and p_hide then null else
        btrim(regexp_replace(regexp_replace(content, '\{\{theme::[^{}]*\}\}', '', 'g'),
          E'\\{\\{sync_date::[^{}\\r\\n]{0,200}\\}\\}', '', 'g'))
      end as visible_content
    from numbered n join public.messages m on m.id = n.id
    where n.display_turn between p_start and p_end
  )
  select
    coalesce(bool_or(generation_status = 'streaming'), false),
    coalesce(bool_or(display_turn = p_end), false),
    jsonb_agg(
      jsonb_build_object('turn', display_turn, 'role', role, 'text', visible_content)
      order by display_turn, turn_index, case when role = 'user' then 0 else 1 end, created_at, id
    ) filter (where visible_content <> '' or (role = 'user' and p_hide))
  into has_streaming, has_end_turn, messages
  from selected;

  if has_streaming then raise exception 'SCENE_STREAMING'; end if;
  if not has_end_turn then raise exception 'SCENE_INVALID_RANGE'; end if;
  if messages is null or not exists (
    select 1 from jsonb_array_elements(messages) as message where message->>'text' <> ''
  ) then
    raise exception 'SCENE_EMPTY';
  end if;

  scene := jsonb_build_object(
    'title', scene_title, 'thumbnail', scene_thumbnail, 'start', p_start, 'end', p_end, 'hideUser', p_hide, 'messages', messages
  );
  if octet_length(scene::text) > 393216 then raise exception 'SCENE_TOO_LARGE'; end if;

  return jsonb_build_object('scene', scene, 'fingerprint', encode(sha256(convert_to(scene::text, 'UTF8')), 'hex'));
end;
$$;

