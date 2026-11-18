alter table scene_sharing.shares
  add column display jsonb not null default '{}'::jsonb,
  add column card_jpeg bytea;

create table scene_sharing.view_theme (
  singleton boolean primary key default true check (singleton),
  theme_id uuid,
  variant text not null check (variant in ('dark', 'light'))
);
alter table scene_sharing.view_theme enable row level security;
revoke all on table scene_sharing.view_theme from public, anon, authenticated;

create function scene_sharing.theme_choice(p_theme_id uuid, p_variant text, p_write boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_app_admin() then
    raise exception 'SCENE_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  if p_write then
    if p_variant is null or p_variant not in ('dark', 'light') or (p_theme_id is not null and not exists (
      select 1 from public.themes as theme
      where theme.id = p_theme_id and (theme.owner_id = auth.uid() or theme.is_published)
        and (case when p_variant = 'dark' then theme.dark_colors else theme.light_colors end) is not null
    )) then
      raise exception 'SCENE_INVALID_THEME';
    end if;
    insert into scene_sharing.view_theme (theme_id, variant) values (p_theme_id, p_variant)
    on conflict (singleton) do update set theme_id = excluded.theme_id, variant = excluded.variant;
  end if;

  return coalesce(
    (select jsonb_build_object('id', theme_id, 'variant', variant) from scene_sharing.view_theme where singleton),
    jsonb_build_object('id', null, 'variant', 'dark')
  );
end;
$$;

create function public.get_scene_share_theme()
returns jsonb language sql security invoker set search_path = '' as $$
  select scene_sharing.theme_choice(null, null, false);
$$;

create function public.set_scene_share_theme(p_theme_id uuid, p_variant text)
returns jsonb language sql security invoker set search_path = '' as $$
  select scene_sharing.theme_choice(p_theme_id, p_variant, true);
$$;

create function scene_sharing.publish_view(
  p_session uuid, p_start integer, p_end integer, p_hide boolean, p_fingerprint text,
  p_display jsonb, p_card text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  link jsonb;
  card bytea;
begin
  if coalesce(octet_length(p_display::text), 0) > 1024
    or coalesce(length(p_card), 0) > 400000 then
    raise exception 'SCENE_TOO_LARGE';
  end if;

  if p_card is not null then
    card := decode(p_card, 'base64');
    if substring(card for 3) <> decode('ffd8ff', 'hex') then
      raise exception 'SCENE_INVALID_CARD';
    end if;
  end if;

  link := scene_sharing.publish(p_session, p_start, p_end, p_hide, p_fingerprint);
  update scene_sharing.shares
  set display = jsonb_strip_nulls(jsonb_build_object(
      'interfaceDesign', p_display->'interfaceDesign',
      'chatWidthLimited', p_display->'chatWidthLimited',
      'showImages', p_display->'showImages',
      'codeBlockStyle', p_display->'codeBlockStyle',
      'fontSize', p_display->'fontSize',
      'fontWeight', p_display->'fontWeight',
      'boldWeight', p_display->'boldWeight'
    )),
    card_jpeg = coalesce(card, card_jpeg)
  where token = (link->>'token')::uuid and owner_id = auth.uid();
  return link;
end;
$$;

create function public.publish_scene_share_view(
  p_session uuid, p_start integer, p_end integer, p_hide boolean, p_fingerprint text,
  p_display jsonb, p_card text
)
returns jsonb language sql security invoker set search_path = '' as $$
  select scene_sharing.publish_view(p_session, p_start, p_end, p_hide, p_fingerprint, p_display, p_card);
$$;

create or replace function scene_sharing.read(p_token uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select share.scene || jsonb_build_object(
    'display', share.display,
    'hasCard', share.card_jpeg is not null,
    'viewTheme', jsonb_build_object(
      'variant', case when config.theme_id is not null and (case when config.variant = 'dark' then theme.dark_colors else theme.light_colors end) is null then 'dark' else coalesce(config.variant, 'dark') end,
      'palette', case when config.variant = 'dark' then theme.dark_colors else theme.light_colors end
    )
  )
  from scene_sharing.shares as share
  left join scene_sharing.view_theme as config on config.singleton
  left join public.themes as theme on theme.id = config.theme_id
  where share.token = p_token and share.expires_at > now();
$$;

create function scene_sharing.read_card(p_token uuid)
returns text language sql stable security definer set search_path = '' as $$
  select encode(card_jpeg, 'base64') from scene_sharing.shares
  where token = p_token and expires_at > now();
$$;

create function public.read_scene_share_card(p_token uuid)
returns text language sql stable security invoker set search_path = '' as $$
  select scene_sharing.read_card(p_token);
$$;

revoke execute on function scene_sharing.theme_choice(uuid,text,boolean),
  public.get_scene_share_theme(), public.set_scene_share_theme(uuid,text),
  scene_sharing.publish_view(uuid,integer,integer,boolean,text,jsonb,text),
  public.publish_scene_share_view(uuid,integer,integer,boolean,text,jsonb,text),
  scene_sharing.read_card(uuid), public.read_scene_share_card(uuid) from public, anon, authenticated;
grant execute on function scene_sharing.theme_choice(uuid,text,boolean),
  public.get_scene_share_theme(), public.set_scene_share_theme(uuid,text),
  scene_sharing.publish_view(uuid,integer,integer,boolean,text,jsonb,text),
  public.publish_scene_share_view(uuid,integer,integer,boolean,text,jsonb,text) to authenticated;
grant execute on function scene_sharing.read_card(uuid), public.read_scene_share_card(uuid) to anon, authenticated;
