-- Apply before the matching frontend. Existing message IDs, bodies, logical
-- indexes, selected answers, summaries and cache references are preserved.
create schema if not exists private;

-- Public identity is a deliberately small projection; settings stay owner-only.
create table if not exists public.public_profiles (
  id uuid primary key references public.profiles(id) on delete cascade,
  display_name text not null default '', avatar_url text, bio text
);
alter table public.public_profiles enable row level security;
drop policy if exists public_profiles_read on public.public_profiles;
create policy public_profiles_read on public.public_profiles for select using (true);
revoke all on public.public_profiles from anon, authenticated;
grant select on public.public_profiles to anon, authenticated;
create or replace function private.sync_public_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.public_profiles(id,display_name,avatar_url,bio)
  values(new.id,new.display_name,new.avatar_url,new.bio)
  on conflict(id) do update set display_name=excluded.display_name,
    avatar_url=excluded.avatar_url,bio=excluded.bio;
  return new;
end $$;
revoke all on function private.sync_public_profile() from public,anon,authenticated;
insert into public.public_profiles select id,display_name,avatar_url,bio from public.profiles
on conflict(id) do update set display_name=excluded.display_name,
  avatar_url=excluded.avatar_url,bio=excluded.bio;
drop trigger if exists sync_public_profile on public.profiles;
create trigger sync_public_profile after insert or update of display_name,avatar_url,bio
on public.profiles for each row execute function private.sync_public_profile();
drop policy if exists profiles_select_all on public.profiles;
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated
using ((select auth.uid())=id);
-- INSERT ... RETURNING must see the just-created private row without a STABLE
-- lookup function trying to re-read that row from the statement's old snapshot.
drop policy if exists works_select_by_visibility on public.works;
create policy works_select_by_visibility on public.works for select using (
  creator_id=(select auth.uid()) or visibility in ('public','unlisted') or public.can_edit_work(id)
);
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.multichat_members'::regclass
    and conname='multichat_members_public_profile_fk') then
    alter table public.multichat_members add constraint multichat_members_public_profile_fk
      foreign key(user_id) references public.public_profiles(id) on delete cascade;
  end if;
end $$;

-- Grandfather historical key collisions instead of deleting or renumbering them.
-- New browser writes always enter the protected, non-legacy set.
alter table public.messages add column if not exists legacy_turn_conflict boolean not null default false;
with conflicts as (
  select id from (
    select id,count(*) over(partition by session_id,turn_index,
      case when role='assistant' then reroll_index else 0 end,role) n
    from public.messages where not is_hidden and role in ('user','assistant')
  ) q where n>1
) update public.messages set legacy_turn_conflict=true where id in(select id from conflicts);
create or replace function public.protect_message_legacy_marker() returns trigger
language plpgsql set search_path=public as $$
begin
  if current_user in ('anon','authenticated') and
    ((tg_op='INSERT' and new.legacy_turn_conflict) or
     (tg_op='UPDATE' and new.legacy_turn_conflict is distinct from old.legacy_turn_conflict)) then
    raise exception 'Historical conflict markers cannot be changed' using errcode='42501';
  end if;
  return new;
end $$;
drop trigger if exists protect_message_legacy_marker on public.messages;
create trigger protect_message_legacy_marker before insert or update of legacy_turn_conflict
on public.messages for each row execute function public.protect_message_legacy_marker();
create unique index if not exists messages_one_user_per_turn_idx
on public.messages(session_id,turn_index) where role='user' and not is_hidden and not legacy_turn_conflict;
create unique index if not exists messages_one_assistant_variant_per_turn_idx
on public.messages(session_id,turn_index,reroll_index) where role='assistant' and not is_hidden and not legacy_turn_conflict;
create index if not exists messages_logical_order_idx
on public.messages(session_id,turn_index,created_at,id);
drop policy if exists messages_select_own on public.messages;
drop policy if exists messages_write_own on public.messages;
create policy messages_write_own on public.messages for all to authenticated
using (exists(select 1 from public.sessions s where s.id=session_id and s.user_id=(select auth.uid())))
with check (exists(select 1 from public.sessions s where s.id=session_id and s.user_id=(select auth.uid())));
drop policy if exists sessions_all_own on public.sessions;
create policy sessions_all_own on public.sessions for all to authenticated
using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));

alter table public.messages add column if not exists usage_accounted boolean not null default true;
alter table public.messages alter column usage_accounted set default false;
alter table public.messages add column if not exists content_version integer not null default 0;
create or replace function public.bump_message_content_version() returns trigger
language plpgsql set search_path=public as $$
begin
  new.content_version:=old.content_version + case when new.content is distinct from old.content
    or new.is_active_variant is distinct from old.is_active_variant
    or new.is_hidden is distinct from old.is_hidden then 1 else 0 end;
  return new;
end $$;
drop trigger if exists bump_message_content_version on public.messages;
create trigger bump_message_content_version before update on public.messages
for each row execute function public.bump_message_content_version();

-- Locking the owned session serializes all of the following commit operations.
create or replace function public.select_session_variant(target_session uuid,target_group uuid,
  target_message uuid,expected_active uuid default null) returns void
language plpgsql security invoker set search_path=public as $$
begin
  perform 1 from public.sessions where id=target_session and user_id=(select auth.uid()) for update;
  if not found then raise exception 'Session is inaccessible' using errcode='42501'; end if;
  if not exists(select 1 from public.messages where session_id=target_session and id=target_message
    and role='assistant' and coalesce(reroll_group_id,id)=target_group) then
    raise exception 'Response is inaccessible' using errcode='42501';
  end if;
  if expected_active is not null and not exists(select 1 from public.messages where
    session_id=target_session and id=expected_active and is_active_variant
    and coalesce(reroll_group_id,id)=target_group) then
    raise exception 'Response selection changed; refresh and retry' using errcode='40001';
  end if;
  update public.messages set is_active_variant=(id=target_message),reroll_group_id=target_group
  where session_id=target_session and role='assistant' and coalesce(reroll_group_id,id)=target_group;
end $$;

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
  if not m.usage_accounted then
    if target_group is not null then
      perform public.select_session_variant(target_session,target_group,target_message,previous_message);
    end if;
    update public.messages set content=response_text,input_tokens=greatest(in_tokens,0),
      output_tokens=greatest(out_tokens,0),cost=greatest(response_cost,0),cache_read_tokens=read_tokens,
      cache_write_tokens=write_tokens,generation_status='complete',usage_accounted=true
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
  return jsonb_build_object('message',to_jsonb(m),'session',to_jsonb(s));
end $$;

create or replace function public.save_generated_summary(target_session uuid,summary_text text,through_turn integer,
  source_versions jsonb,previous_summary text,previous_summary_turn integer,
  in_tokens integer,out_tokens integer,response_cost numeric) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare s public.sessions;
begin
  select * into s from public.sessions where id=target_session and user_id=(select auth.uid()) for update;
  if not found then raise exception 'Session is inaccessible' using errcode='42501'; end if;
  if nullif(trim(summary_text),'') is null or through_turn<0 then raise exception 'Invalid summary'; end if;
  if s.summary is distinct from previous_summary or s.summary_last_turn is distinct from previous_summary_turn then
    raise exception 'Summary changed while generating; refresh and retry' using errcode='40001';
  end if;
  if exists(select 1 from jsonb_to_recordset(source_versions) as v(id uuid,version integer)
    where not exists(select 1 from public.messages m where m.id=v.id and m.session_id=target_session
      and m.content_version=v.version and m.is_active_variant and m.generation_status<>'streaming')) then
    raise exception 'Source dialogue changed while generating' using errcode='40001';
  end if;
  update public.summary_versions set is_active=false where session_id=target_session;
  insert into public.summary_versions(session_id,content,summarized_through_turn,input_tokens,output_tokens,cost)
  values(target_session,summary_text,through_turn,greatest(in_tokens,0),greatest(out_tokens,0),greatest(response_cost,0))
  on conflict(session_id,summarized_through_turn) do update set content=excluded.content,
    input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cost=excluded.cost,is_active=true;
  update public.messages set is_summarized=true where session_id=target_session
    and id in(select (v->>'id')::uuid from jsonb_array_elements(source_versions) v);
  update public.sessions set summary=summary_text,summary_last_turn=through_turn,
    total_input_tokens=total_input_tokens+greatest(in_tokens,0),total_output_tokens=total_output_tokens+greatest(out_tokens,0),
    total_cost=total_cost+greatest(response_cost,0),updated_at=now()
  where id=target_session returning * into s;
  return to_jsonb(s);
end $$;

create or replace function public.mutate_session_summary(target_session uuid,operation text,
  target_version uuid default null,summary_text text default null,selected_ids uuid[] default '{}') returns jsonb
language plpgsql security invoker set search_path=public as $$
declare s public.sessions; target_active boolean;
begin
  select * into s from public.sessions where id=target_session and user_id=(select auth.uid()) for update;
  if not found then raise exception 'Session is inaccessible' using errcode='42501'; end if;
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

-- A JSON page is not truncated by the REST maximum-row setting; the cursor is
-- a logical turn rather than a timestamp, including for old copied messages.
create or replace function public.session_message_page(target_session uuid,before_turn integer default null)
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare cutoff integer; more boolean; result jsonb;
begin
  if not exists(select 1 from public.sessions where id=target_session and user_id=(select auth.uid())) then
    raise exception 'Session is inaccessible' using errcode='42501'; end if;
  select count(*)>5 into more from (select 1 from public.messages where session_id=target_session and role='user'
    and not is_hidden and is_active_variant and (before_turn is null or turn_index<before_turn)
    order by turn_index desc,created_at desc,id desc limit 6) q;
  if more then
    select min(turn_index) into cutoff from (select turn_index from public.messages where session_id=target_session and role='user'
      and not is_hidden and is_active_variant and (before_turn is null or turn_index<before_turn)
      order by turn_index desc,created_at desc,id desc limit 5) q;
  end if;
  select jsonb_agg(to_jsonb(m) order by turn_index,case when role='user' then 0 else 1 end,created_at,id)
  into result from public.messages m where session_id=target_session
    and (cutoff is null or turn_index>=cutoff) and (before_turn is null or turn_index<before_turn);
  return jsonb_build_object('messages',coalesce(result,'[]'),'hasOlder',more,'oldestTurn',cutoff,
    'totalUserTurns',(select count(*) from public.messages where session_id=target_session and role='user' and not is_hidden and is_active_variant));
end $$;

-- Old turns need only IDs/order/variant metadata, not their large prompt bodies.
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
  return jsonb_build_object('messages',coalesce(result,'[]'),'summary',memory,'summaryLastTurn',cutoff);
end $$;

-- Only authenticated invokers may call the new API. Its queries still obey RLS.
do $$ declare fn regprocedure; begin
  for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('select_session_variant','finish_session_response',
      'save_generated_summary','mutate_session_summary','session_message_page','session_generation_context') loop
    execute format('revoke all on function %s from public, anon',fn);
    execute format('grant execute on function %s to authenticated',fn);
  end loop;
end $$;

create or replace function public.claim_multichat_generation(target_room uuid, is_reroll boolean default false) returns integer language plpgsql security definer set search_path=public as $$
declare r multichat_rooms; idx integer;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다.' using errcode='42501'; end if;
 select * into r from multichat_rooms where id=target_room for update;
 if not found or r.host_user_id is distinct from auth.uid() or r.status is distinct from 'active' then raise exception '방장만 생성할 수 있습니다.'; end if;
 if is_reroll then
   if r.current_round<=1 then raise exception '리롤할 응답이 없습니다.'; end if;
   select coalesce(max(reroll_index),-1)+1 into idx from multichat_messages where room_id=target_room and round_number=r.current_round-1 and role='assistant';
   update multichat_messages set is_active_variant=false where room_id=target_room and round_number=r.current_round-1 and role='assistant';
   insert into multichat_messages(room_id,round_number,role,generation_status,reroll_index) values(target_room,r.current_round-1,'assistant','streaming',idx); return r.current_round-1;
 end if;
 if (select count(*) from multichat_submissions where room_id=target_room and round_number=r.current_round)<>2 then raise exception '두 사용자의 제출을 기다리고 있습니다.'; end if;
 if exists(select 1 from multichat_messages where room_id=target_room and round_number=r.current_round and role='assistant' and generation_status='interrupted') then
   update multichat_messages set generation_status='streaming',content='' where room_id=target_room and round_number=r.current_round and role='assistant'; return r.current_round;
 end if;
 if exists(select 1 from multichat_messages where room_id=target_room and round_number=r.current_round and role='assistant') then return 0; end if;
 insert into multichat_messages(room_id,round_number,role,content) select target_room,r.current_round,'user',string_agg('user'||slot||': '||case when is_skip then '[skip]' else content end,E'\n\n' order by slot) from multichat_submissions where room_id=target_room and round_number=r.current_round;
 insert into multichat_messages(room_id,round_number,role,generation_status) values(target_room,r.current_round,'assistant','streaming'); return r.current_round;
end $$;

revoke all on function public.claim_multichat_generation(uuid,boolean) from public,anon;
grant execute on function public.claim_multichat_generation(uuid,boolean) to authenticated;

create or replace function public.duplicate_work_atomic(target_work uuid) returns uuid
language plpgsql security invoker set search_path=public as $$
declare original public.works; copied uuid; theme public.themes; copied_theme uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into original from public.works where id=target_work;
  if not found then raise exception 'Work is inaccessible' using errcode='42501'; end if;
  insert into public.works(creator_id,title,description,thumbnail_url,main_prompt,multichat_prompt,visibility,is_published)
  values(auth.uid(),original.title||' (복제본)',original.description,original.thumbnail_url,
    original.main_prompt,original.multichat_prompt,'private',false) returning id into copied;
  insert into public.start_configs(work_id,name,initial_message,initial_context,keep_turns,sort_order,is_default)
    select copied,name,initial_message,initial_context,keep_turns,sort_order,is_default from public.start_configs where work_id=target_work;
  insert into public.keyword_books(work_id,name,keywords,content,activation_turns,sort_order)
    select copied,name,keywords,content,activation_turns,sort_order from public.keyword_books where work_id=target_work;
  insert into public.commands(work_id,owner_id,name,description,prompt,is_published)
    select copied,auth.uid(),name,description,prompt,false from public.commands where work_id=target_work;
  for theme in select * from public.themes where work_id=target_work and work_shared loop
    insert into public.themes(owner_id,work_id,name,description,ai_prompt,day_night_enabled,
      use_day_night_variants,work_shared,dark_colors,light_colors,is_published)
    values(auth.uid(),copied,theme.name,theme.description,theme.ai_prompt,theme.day_night_enabled,
      theme.use_day_night_variants,true,theme.dark_colors,theme.light_colors,false) returning id into copied_theme;
    if theme.id=original.default_theme_id then
      update public.works set default_theme_id=copied_theme,default_theme_variant=original.default_theme_variant where id=copied;
    end if;
  end loop;
  if original.default_theme_id is not null and exists(select 1 from public.themes
    where id=original.default_theme_id and work_id is null) then
    update public.works set default_theme_id=original.default_theme_id,default_theme_variant=original.default_theme_variant where id=copied;
  end if;
  return copied;
end $$;
revoke all on function public.duplicate_work_atomic(uuid) from public,anon;
grant execute on function public.duplicate_work_atomic(uuid) to authenticated;

create or replace function public.create_session_with_start(target_work uuid,target_persona uuid default null,
  target_config uuid default null) returns uuid language plpgsql security invoker set search_path=public as $$
declare p public.profiles; w public.works; c public.start_configs; result uuid;
begin
  select * into p from public.profiles where id=(select auth.uid());
  if not found then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into w from public.works where id=target_work;
  if not found then raise exception 'Work is inaccessible' using errcode='42501'; end if;
  if target_persona is not null and not exists(select 1 from public.personas where id=target_persona and user_id=p.id) then
    raise exception 'Persona is inaccessible' using errcode='42501'; end if;
  if target_config is not null then
    select * into c from public.start_configs where id=target_config and work_id=target_work;
    if not found then raise exception 'Start configuration is inaccessible' using errcode='42501'; end if;
  end if;
  insert into public.sessions(user_id,work_id,title,persona_id,start_config_id,summary_model_override,
    summary_reasoning_override,summary_level_override,summary_allow_omission_override,
    summary_parameters_enabled_override,summary_source_mode_override)
  values(p.id,w.id,w.title,target_persona,target_config,coalesce(nullif(p.summary_model,''),nullif(p.default_model,'')),
    p.summary_reasoning,p.summary_level,p.summary_allow_omission,p.summary_parameters_enabled,p.summary_source_mode)
  returning id into result;
  if nullif(trim(c.initial_context),'') is not null then
    insert into public.messages(session_id,role,content,turn_index,is_hidden)
    values(result,'user',E'[시작 설정: 아래 내용을 참고해 첫 장면을 시작하세요]\n\n'||c.initial_context,0,true);
  end if;
  if nullif(trim(c.initial_message),'') is not null then
    insert into public.messages(session_id,role,content,turn_index,is_hidden)
    values(result,'assistant',c.initial_message,0,false);
  end if;
  return result;
end $$;
revoke all on function public.create_session_with_start(uuid,uuid,uuid) from public,anon;
grant execute on function public.create_session_with_start(uuid,uuid,uuid) to authenticated;
