create or replace function public.session_persona_archive_context(target_session uuid, include_voice boolean default false)
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
          -- A blank send may also carry a persona-transition notice.
          and replace(btrim(m.content, E' \t\r\n'), E'\r\n', E'\n') <> '*이어서 계속 진행*'
          and replace(btrim(m.content, E' \t\r\n'), E'\r\n', E'\n') not like E'*이어서 계속 진행*\n\n*%*'
        order by m.turn_index desc, m.created_at desc, m.id desc limit 20
      ) line
    ) voice on true
    where a.session_id = s.id
  ) history on true
  where s.id = target_session and s.user_id = (select auth.uid()) and s.multichat_room_id is null
$$;
