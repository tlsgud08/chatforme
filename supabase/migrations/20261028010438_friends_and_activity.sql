-- Mutual friendship, per-browser liveness and a persistent last-played work.
create table public.friendships (
 id uuid primary key default gen_random_uuid(),
 user_a uuid not null references public.profiles(id) on delete cascade,
 user_b uuid not null references public.profiles(id) on delete cascade,
 requested_by uuid not null references public.profiles(id) on delete cascade,
 status text not null check(status in ('pending','accepted','removed')),
 updated_at timestamptz not null default now(),
 unique(user_a,user_b),check(user_a<user_b),check(requested_by in (user_a,user_b))
);
create index friendships_user_b_idx on public.friendships(user_b);
alter table public.friendships enable row level security;
create policy friendships_read on public.friendships for select to authenticated using((select auth.uid()) in (user_a,user_b));
grant select on public.friendships to authenticated;

create function public.is_my_friend(other_user uuid) returns boolean
language sql stable security invoker set search_path=public as $$
 select exists(select 1 from public.friendships where status='accepted' and user_a=least(auth.uid(),other_user) and user_b=greatest(auth.uid(),other_user))
$$;
create function public.change_friendship(other_user uuid,operation text) returns void
language plpgsql security definer set search_path=public as $$
declare me uuid:=auth.uid(); a uuid; b uuid; f public.friendships;
begin
 if me is null then raise exception '로그인이 필요합니다.'; end if;
 if other_user is null or other_user=me or not exists(select 1 from public.profiles where id=other_user) then raise exception '친구로 추가할 유저를 확인해 주세요.'; end if;
 a:=least(me,other_user);b:=greatest(me,other_user);
 perform pg_advisory_xact_lock(hashtextextended(a::text||b::text,0));
 select * into f from public.friendships where user_a=a and user_b=b for update;
 if operation='request' then
  if f.status='accepted' or (f.status='pending' and f.requested_by=me) then return; end if;
  insert into public.friendships(user_a,user_b,requested_by,status) values(a,b,me,case when f.status='pending' then 'accepted' else 'pending' end)
   on conflict(user_a,user_b) do update set requested_by=excluded.requested_by,status=excluded.status,updated_at=clock_timestamp();
 elsif operation='accept' then
  if f.status='accepted' then return; end if;
  if f.status is distinct from 'pending' or f.requested_by=me then raise exception '받은 친구 요청이 없습니다.'; end if;
  update public.friendships set status='accepted',updated_at=clock_timestamp() where id=f.id;
 elsif operation in ('reject','cancel','remove') then
  if f.id is null or f.status='removed' then return; end if;
  if operation='reject' and (f.status<>'pending' or f.requested_by=me) then raise exception '받은 친구 요청이 없습니다.'; end if;
  if operation='cancel' and (f.status<>'pending' or f.requested_by<>me) then raise exception '보낸 친구 요청이 없습니다.'; end if;
  if operation='remove' and f.status<>'accepted' then raise exception '등록된 친구가 아닙니다.'; end if;
  update public.friendships set status='removed',updated_at=clock_timestamp() where id=f.id;
 else raise exception '잘못된 친구 요청입니다.'; end if;
end $$;

create table public.friend_activity (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 sharing_enabled boolean not null default true,
 last_work_id uuid references public.works(id) on delete set null,
 last_played_at timestamptz
);
create table public.friend_connections (
 connection_id uuid primary key,
 user_id uuid not null references public.profiles(id) on delete cascade,
 seen_at timestamptz not null,
 active_at timestamptz not null,
 closed boolean not null default false,
 work_id uuid references public.works(id) on delete set null
);
create index friend_connections_user_seen_idx on public.friend_connections(user_id,seen_at desc);
-- Only this tiny invalidation row is exposed to Realtime subscribers. The
-- underlying activity and connection rows stay private to their owner.
create table public.friend_activity_signals (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 revision bigint not null default 0
);
alter table public.friend_activity enable row level security;
alter table public.friend_connections enable row level security;
alter table public.friend_activity_signals enable row level security;
create policy friend_activity_own on public.friend_activity for select to authenticated using(user_id=(select auth.uid()));
create policy friend_connections_own on public.friend_connections for select to authenticated using(user_id=(select auth.uid()));
create policy friend_signals_read on public.friend_activity_signals for select to authenticated using(user_id=(select auth.uid()) or public.is_my_friend(user_id));
grant select on public.friend_activity,public.friend_connections,public.friend_activity_signals to authenticated;

create function public.touch_friend_activity(connection_key uuid,playing_session uuid default null,interaction_at timestamptz default null) returns void
language plpgsql security definer set search_path=public as $$
declare me uuid:=auth.uid(); wid uuid; stamp timestamptz:=clock_timestamp(); interacted timestamptz;
begin
 if me is null or connection_key is null then raise exception '로그인이 필요합니다.'; end if;
 if playing_session is not null then
  select s.work_id into wid from public.sessions s where s.id=playing_session
   and (s.user_id=me or public.is_multichat_member(s.id))
   and (s.multichat_room_id is null or exists(select 1 from public.multichat_rooms r where r.id=s.id and r.status='active'));
  if not found then raise exception '플레이 중인 채팅방을 확인해 주세요.'; end if;
 end if;
 insert into public.friend_activity(user_id) values(me) on conflict do nothing;
 perform 1 from public.friend_activity where user_id=me for update;
 interacted:=greatest(stamp-interval '1 day',least(stamp,coalesce(interaction_at,stamp)));
 if exists(select 1 from public.friend_connections where connection_id=connection_key and user_id<>me) then raise exception '다른 접속의 상태는 변경할 수 없습니다.'; end if;
 insert into public.friend_connections(connection_id,user_id,seen_at,active_at,work_id) values(connection_key,me,stamp,interacted,wid)
  on conflict(connection_id) do update set seen_at=excluded.seen_at,active_at=greatest(friend_connections.active_at,excluded.active_at),work_id=excluded.work_id where not friend_connections.closed;
 if not found then return; end if; -- A late request cannot reopen a closed tab.
 if wid is not null then
  update public.friend_activity set last_work_id=wid,last_played_at=interacted
   where user_id=me and (last_played_at is null or interacted>last_played_at);
 end if;
 delete from public.friend_connections where user_id=me and seen_at<stamp-interval '1 day';
 if exists(select 1 from public.friend_activity where user_id=me and sharing_enabled) then
  insert into public.friend_activity_signals(user_id,revision) values(me,1)
   on conflict(user_id) do update set revision=friend_activity_signals.revision+1;
 end if;
end $$;

create function public.stop_friend_activity(connection_key uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or connection_key is null then return; end if;
 insert into public.friend_connections(connection_id,user_id,seen_at,active_at,closed)
 values(connection_key,auth.uid(),clock_timestamp(),clock_timestamp(),true)
 on conflict(connection_id) do update set closed=true,seen_at=clock_timestamp()
 where friend_connections.user_id=auth.uid() and not friend_connections.closed;
 if found and exists(select 1 from public.friend_activity where user_id=auth.uid() and sharing_enabled) then
  insert into public.friend_activity_signals(user_id,revision) values(auth.uid(),1)
   on conflict(user_id) do update set revision=friend_activity_signals.revision+1;
 end if;
end $$;
create function public.set_friend_activity_sharing(enabled boolean) returns void
language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or enabled is null then raise exception '로그인이 필요합니다.'; end if;
 insert into public.friend_activity(user_id,sharing_enabled) values(auth.uid(),enabled)
  on conflict(user_id) do update set sharing_enabled=excluded.sharing_enabled;
 insert into public.friend_activity_signals(user_id,revision) values(auth.uid(),1)
  on conflict(user_id) do update set revision=friend_activity_signals.revision+1;
end $$;

create function public.get_friend_social_state() returns jsonb
language plpgsql security definer set search_path=public as $$
declare me uuid:=auth.uid(); result jsonb;
begin
 if me is null then raise exception '로그인이 필요합니다.'; end if;
 select jsonb_build_object('server_time',clock_timestamp(),'sharing_enabled',coalesce((select sharing_enabled from public.friend_activity where user_id=me),true),
  'relationships',coalesce(jsonb_agg(jsonb_build_object(
   'user_id',p.id,'display_name',p.display_name,'avatar_url',p.avatar_url,'status',f.status,'requested_by',f.requested_by,
   'sharing_enabled',coalesce(a.sharing_enabled,true),
   'last_work_id',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_work_id end,
   'last_played_at',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_played_at end,
   'connections',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then coalesce((select jsonb_agg(jsonb_build_object('seen_at',c.seen_at,'active_at',c.active_at,'work_id',c.work_id) order by c.active_at desc,c.seen_at desc) from public.friend_connections c where c.user_id=p.id and not c.closed and c.seen_at>clock_timestamp()-interval '5 minutes'),'[]'::jsonb) else '[]'::jsonb end
  ) order by p.display_name,p.id),'[]'::jsonb)) into result
 from public.friendships f join public.public_profiles p on p.id=case when f.user_a=me then f.user_b else f.user_a end
 left join public.friend_activity a on a.user_id=p.id
 where me in (f.user_a,f.user_b) and f.status in ('pending','accepted');
 return result;
end $$;
revoke all on function public.is_my_friend(uuid),public.change_friendship(uuid,text),public.touch_friend_activity(uuid,uuid,timestamptz),public.stop_friend_activity(uuid),public.set_friend_activity_sharing(boolean),public.get_friend_social_state() from public,anon;
grant execute on function public.is_my_friend(uuid),public.change_friendship(uuid,text),public.touch_friend_activity(uuid,uuid,timestamptz),public.stop_friend_activity(uuid),public.set_friend_activity_sharing(boolean),public.get_friend_social_state() to authenticated;
do $$ declare table_name text;
begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  foreach table_name in array array['friendships','friend_activity_signals'] loop
   if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=table_name) then
    execute format('alter publication supabase_realtime add table public.%I',table_name);
   end if;
  end loop;
 end if;
end $$;

-- Retire unused follows. Old migrations remain immutable deployment history.
drop table if exists public.user_follows;
-- Member-only application data; account registration uses the one pre-login RPC.
revoke all on all tables in schema public from anon;
drop policy if exists plays_select on public.work_plays;
drop policy if exists plays_insert on public.work_plays;
create policy plays_select_members on public.work_plays for select to authenticated using(true);
create policy plays_insert_members on public.work_plays for insert to authenticated with check(user_id=(select auth.uid()));
do $$ declare f record;
begin
 for f in select p.oid,p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname<>'verify_signup_master_password' loop
  -- Preserve the existing authenticated API while retiring PUBLIC/anon access.
  if has_function_privilege('authenticated',f.oid,'EXECUTE') then execute format('grant execute on function %s to authenticated',f.signature); end if;
  execute format('revoke all on function %s from public,anon',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';
