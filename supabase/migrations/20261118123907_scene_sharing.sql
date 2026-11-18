create schema scene_sharing;
revoke all on schema scene_sharing from public;
grant usage on schema scene_sharing to anon, authenticated;

create table scene_sharing.shares (
  token uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  hide_user boolean not null,
  fingerprint text not null,
  scene jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  unique (session_id, owner_id, hide_user, fingerprint)
);
create index shares_expiry_idx on scene_sharing.shares (expires_at);
alter table scene_sharing.shares enable row level security;
revoke all on table scene_sharing.shares from public, anon, authenticated;

create function scene_sharing.prepare(p_session uuid, p_start integer, p_end integer, p_hide boolean)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  scene jsonb;
  scene_title text;
  has_streaming boolean;
  has_end_turn boolean;
  messages jsonb;
begin
  if auth.uid() is null or p_hide is null or p_start is null or p_end is null
    or p_start < 0 or p_end < p_start or p_end::bigint - p_start >= 20 then
    raise exception 'SCENE_INVALID_RANGE';
  end if;

  select coalesce(nullif(btrim(left(w.title, 100)), ''), '공유 장면')
  into scene_title
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
    'title', scene_title, 'start', p_start, 'end', p_end, 'hideUser', p_hide, 'messages', messages
  );
  if octet_length(scene::text) > 393216 then raise exception 'SCENE_TOO_LARGE'; end if;

  return jsonb_build_object('scene', scene, 'fingerprint', encode(sha256(convert_to(scene::text, 'UTF8')), 'hex'));
end;
$$;

create function scene_sharing.publish(
  p_session uuid, p_start integer, p_end integer, p_hide boolean, p_fingerprint text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  prepared jsonb;
  published jsonb;
begin
  if auth.uid() is null then raise exception 'SCENE_NOT_FOUND'; end if;
  prepared := scene_sharing.prepare(p_session, p_start, p_end, p_hide);
  if (prepared->>'fingerprint') is distinct from p_fingerprint then raise exception 'SCENE_CHANGED'; end if;

  insert into scene_sharing.shares as shares (session_id, owner_id, hide_user, fingerprint, scene)
  values (p_session, auth.uid(), p_hide, p_fingerprint, prepared->'scene')
  on conflict (session_id, owner_id, hide_user, fingerprint) do update set
    token = case when shares.expires_at <= now() then excluded.token else shares.token end,
    created_at = case when shares.expires_at <= now() then excluded.created_at else shares.created_at end,
    expires_at = case when shares.expires_at <= now() then excluded.expires_at else shares.expires_at end
  returning jsonb_build_object('token', token, 'expiresAt', expires_at) into published;
  return published;
end;
$$;

create function scene_sharing.read(p_token uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select scene from scene_sharing.shares where token = p_token and expires_at > now();
$$;

create function scene_sharing.list(p_session uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'token', token, 'start', scene->'start', 'end', scene->'end', 'hideUser', hide_user, 'expiresAt', expires_at
  ) order by created_at desc, token), '[]'::jsonb)
  from scene_sharing.shares
  where session_id = p_session and owner_id = auth.uid() and expires_at > now();
$$;

create function scene_sharing.revoke(p_session uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from scene_sharing.shares where token = p_token and session_id = p_session and owner_id = auth.uid();
  return found;
end;
$$;

create function public.preview_scene_share(p_session uuid, p_start integer, p_end integer, p_hide boolean)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select scene_sharing.prepare(p_session, p_start, p_end, p_hide);
$$;

create function public.publish_scene_share(
  p_session uuid, p_start integer, p_end integer, p_hide boolean, p_fingerprint text
)
returns jsonb language sql security invoker set search_path = '' as $$
  select scene_sharing.publish(p_session, p_start, p_end, p_hide, p_fingerprint);
$$;

create function public.read_scene_share(p_token uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select scene_sharing.read(p_token);
$$;

create function public.list_scene_shares(p_session uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select scene_sharing.list(p_session);
$$;

create function public.revoke_scene_share(p_session uuid, p_token uuid)
returns boolean language sql security invoker set search_path = '' as $$
  select scene_sharing.revoke(p_session, p_token);
$$;

revoke execute on all functions in schema scene_sharing from public, anon, authenticated;
revoke execute on function public.preview_scene_share(uuid, integer, integer, boolean),
  public.publish_scene_share(uuid, integer, integer, boolean, text), public.read_scene_share(uuid),
  public.list_scene_shares(uuid), public.revoke_scene_share(uuid, uuid) from public, anon, authenticated;
grant execute on function scene_sharing.read(uuid), public.read_scene_share(uuid) to anon, authenticated;
grant execute on function scene_sharing.prepare(uuid, integer, integer, boolean),
  scene_sharing.publish(uuid, integer, integer, boolean, text), scene_sharing.list(uuid), scene_sharing.revoke(uuid, uuid),
  public.preview_scene_share(uuid, integer, integer, boolean),
  public.publish_scene_share(uuid, integer, integer, boolean, text),
  public.list_scene_shares(uuid), public.revoke_scene_share(uuid, uuid) to authenticated;

-- Public reads stop at expires_at. Embedded test databases lack the scheduler.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule(
      'inuchat-delete-expired-scene-shares',
      '*/15 * * * *',
      $job$delete from scene_sharing.shares where expires_at <= now()$job$
    );
  end if;
end;
$$;
