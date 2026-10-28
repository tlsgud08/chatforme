-- Play runs are per account and chat room. A quick re-entry resumes the run;
-- disjoint ranges exclude pauses, and their union prevents double-counting tabs.
create table public.friend_play_runs (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 session_id uuid references public.sessions(id) on delete set null,
 work_id uuid not null references public.works(id) on delete cascade,
 covered tstzmultirange not null default '{}',
 last_in_room_at timestamptz not null,
 created_at timestamptz not null default clock_timestamp()
);
create index friend_play_runs_user_session_idx on public.friend_play_runs(user_id,session_id,last_in_room_at desc);
create index friend_play_runs_session_idx on public.friend_play_runs(session_id);
create index friend_play_runs_work_idx on public.friend_play_runs(work_id);
alter table public.friend_play_runs enable row level security;
revoke all on public.friend_play_runs from anon,authenticated;
grant select on public.friend_play_runs to authenticated;
create policy friend_play_runs_own_read on public.friend_play_runs for select to authenticated using(user_id=(select auth.uid()));
alter table public.friend_connections add column play_run_id uuid references public.friend_play_runs(id) on delete set null;
alter table public.friend_visits add column last_play_run_id uuid references public.friend_play_runs(id) on delete set null;
alter table public.friend_activity add column last_play_run_id uuid references public.friend_play_runs(id) on delete set null;
create index friend_connections_play_run_idx on public.friend_connections(play_run_id);
create index friend_visits_play_run_idx on public.friend_visits(last_play_run_id);
create index friend_activity_play_run_idx on public.friend_activity(last_play_run_id);

-- Internal helpers run inside the existing validated RPCs, under their user
-- activity lock. Clients cannot supply durations or call these helpers.
create function public.settle_friend_play(connection_key uuid,stamp timestamptz) returns void
language plpgsql security invoker set search_path=public as $$
declare c public.friend_connections; finish timestamptz;
begin
 select * into c from public.friend_connections where connection_id=connection_key and not closed and play_run_id is not null;
 if not found then return; end if;
 finish:=least(stamp,c.seen_at+interval '2 minutes',c.active_at+interval '3 minutes');
 if finish>c.seen_at then
  update public.friend_play_runs set covered=covered+tstzmultirange(tstzrange(c.seen_at,finish,'[)')) where id=c.play_run_id;
 end if;
 update public.friend_play_runs set last_in_room_at=greatest(last_in_room_at,case when stamp<=c.seen_at+interval '2 minutes' then stamp else c.seen_at end) where id=c.play_run_id;
end $$;
create function public.enter_friend_play(me uuid,playing_session uuid,wid uuid,stamp timestamptz) returns uuid
language plpgsql security invoker set search_path=public as $$
declare run_id uuid;
begin
 select id into run_id from public.friend_play_runs where user_id=me and session_id=playing_session and last_in_room_at>=stamp-interval '3 minutes' order by last_in_room_at desc,created_at desc,id limit 1;
 if run_id is null then
  insert into public.friend_play_runs(user_id,session_id,work_id,last_in_room_at) values(me,playing_session,wid,stamp) returning id into run_id;
 else update public.friend_play_runs set last_in_room_at=greatest(last_in_room_at,stamp) where id=run_id;
 end if;
 return run_id;
end $$;

-- Read-only projection uses the same 2-minute connection lease and 3-minute
-- idle deadline as presence. Expired connections cannot accrue time forever.
create function public.friend_play_time(target_run uuid,stamp timestamptz) returns jsonb
language sql stable security invoker set search_path=public as $$
 select jsonb_build_object('duration_ms',coalesce((
  select floor(sum(extract(epoch from upper(piece)-lower(piece))*1000)) from unnest(
   r.covered+coalesce((select range_agg(tstzrange(c.seen_at,least(stamp,c.seen_at+interval '2 minutes',c.active_at+interval '3 minutes'),'[)'))
    from public.friend_connections c where c.play_run_id=r.id and not c.closed and c.seen_at<least(stamp,c.seen_at+interval '2 minutes',c.active_at+interval '3 minutes')),'{}'::tstzmultirange)
  ) piece),0),'measured_at',stamp,'running_until',(
   select max(least(c.seen_at+interval '2 minutes',c.active_at+interval '3 minutes')) from public.friend_connections c where c.play_run_id=r.id and not c.closed
  )) from public.friend_play_runs r where r.id=target_run
$$;
revoke all on function public.settle_friend_play(uuid,timestamptz),public.enter_friend_play(uuid,uuid,uuid,timestamptz),public.friend_play_time(uuid,timestamptz) from public,anon,authenticated;
create or replace function public.touch_friend_activity(connection_key uuid,playing_session uuid default null,interaction_at timestamptz default null) returns void
language plpgsql security definer set search_path=public as $$
declare me uuid:=auth.uid(); wid uuid; stamp timestamptz:=clock_timestamp(); interacted timestamptz; run_id uuid;
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
 stamp:=clock_timestamp(); -- Measure after acquiring the per-user lock.
 interacted:=greatest(stamp-interval '1 day',least(stamp,coalesce(interaction_at,stamp)));
 if exists(select 1 from public.friend_connections where connection_id=connection_key and user_id<>me) then raise exception '다른 접속의 상태는 변경할 수 없습니다.'; end if;
 perform public.settle_friend_play(connection_key,stamp);
 insert into public.friend_connections(connection_id,user_id,seen_at,active_at,work_id,activity_type) values(connection_key,me,stamp,interacted,wid,case when wid is not null then 'play' end)
  on conflict(connection_id) do update set seen_at=excluded.seen_at,active_at=greatest(friend_connections.active_at,excluded.active_at),work_id=excluded.work_id,activity_type=excluded.activity_type where not friend_connections.closed;
 if not found then return; end if; -- A late request cannot reopen a closed tab.
 if wid is not null then run_id:=public.enter_friend_play(me,playing_session,wid,stamp); end if;
 update public.friend_connections set play_run_id=run_id where connection_id=connection_key;
 if wid is not null then
  update public.friend_activity set last_work_id=wid,last_played_at=interacted,last_activity_type='play',last_play_run_id=run_id
   where user_id=me and (last_played_at is null or interacted>last_played_at);
 end if;
 perform public.settle_friend_play(connection_id,stamp) from public.friend_connections where user_id=me and seen_at<stamp-interval '1 day';
 delete from public.friend_connections where user_id=me and seen_at<stamp-interval '1 day';
 if exists(select 1 from public.friend_activity where user_id=me and sharing_enabled) then
  insert into public.friend_activity_signals(user_id,revision) values(me,1)
   on conflict(user_id) do update set revision=friend_activity_signals.revision+1;
 end if;
end $$;
create or replace function public.touch_friend_visit(connection_key uuid,visit_key uuid,playing_session uuid default null,interaction_at timestamptz default null) returns void
language plpgsql security definer set search_path=public as $$
declare me uuid:=auth.uid(); c public.friend_connections;
begin
 if me is null or visit_key is null then raise exception '로그인이 필요합니다.'; end if;
 -- Reuse the validated session, liveness, ownership and late-request guards.
 -- This also serializes activity updates from the same user's connections.
 perform public.touch_friend_activity(connection_key,playing_session,interaction_at);
 select * into c from public.friend_connections where connection_id=connection_key and user_id=me and not closed for update;
 if not found then return; end if;
 if c.visit_id is not null and c.visit_id<>visit_key then raise exception '다른 접속의 기록으로 변경할 수 없습니다.'; end if;
 insert into public.friend_visits(visit_id,user_id) values(visit_key,me) on conflict do nothing;
 if not exists(select 1 from public.friend_visits where visit_id=visit_key and user_id=me) then raise exception '다른 접속의 기록으로 변경할 수 없습니다.'; end if;
 update public.friend_connections set visit_id=visit_key where connection_id=c.connection_id;
 if c.work_id is not null then
  update public.friend_visits set last_work_id=c.work_id,last_played_at=c.active_at,last_activity_type='play',last_play_run_id=c.play_run_id
   where visit_id=visit_key and (last_played_at is null or c.active_at>=last_played_at);
  -- Equal client timestamps can occur when switching rooms quickly. The latest
  -- validated update wins the tie without letting an older tab replace history.
  update public.friend_activity set last_work_id=c.work_id,last_played_at=c.active_at,last_activity_type='play',last_play_run_id=c.play_run_id
   where user_id=me and (last_played_at is null or c.active_at>=last_played_at);
 end if;
end $$;
create or replace function public.touch_friend_activity_state(connection_key uuid,visit_key uuid,playing_session uuid default null,editing_work uuid default null,interaction_at timestamptz default null) returns void
language plpgsql security definer set search_path=public as $$
declare me uuid:=auth.uid(); c public.friend_connections; kind text; wid uuid;
begin
 if me is null then raise exception '로그인이 필요합니다.'; end if;
 if playing_session is not null and editing_work is not null then raise exception '현재 활동은 하나만 지정해 주세요.'; end if;
 if editing_work is not null and (not exists(select 1 from public.works where id=editing_work) or public.can_edit_work(editing_work) is not true) then raise exception '작품을 수정할 권한이 없습니다.'; end if;
 perform public.touch_friend_visit(connection_key,visit_key,playing_session,interaction_at);
 select * into c from public.friend_connections where connection_id=connection_key and user_id=me and not closed for update;
 if not found then return; end if;
 if editing_work is not null then kind:='create';wid:=editing_work;
 elsif playing_session is not null then kind:='play';wid:=c.work_id;
 end if;
 update public.friend_connections set activity_type=kind,work_id=wid where connection_id=c.connection_id;
 if kind is not null then
  update public.friend_visits set last_work_id=wid,last_played_at=c.active_at,last_activity_type=kind,last_play_run_id=case when kind='play' then c.play_run_id end
   where visit_id=visit_key and (last_played_at is null or c.active_at>=last_played_at);
  update public.friend_activity set last_work_id=wid,last_played_at=c.active_at,last_activity_type=kind,last_play_run_id=case when kind='play' then c.play_run_id end
   where user_id=me and (last_played_at is null or c.active_at>=last_played_at);
 end if;
end $$;
-- Serialize stop and heartbeat in the same order before the last-seen trigger.
create or replace function public.stop_friend_activity(connection_key uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or connection_key is null then return; end if;
 -- Match heartbeat lock order: user activity first, then individual connection.
 insert into public.friend_activity(user_id) values(auth.uid()) on conflict do nothing;
 perform 1 from public.friend_activity where user_id=auth.uid() for update;
 perform public.settle_friend_play(connection_key,clock_timestamp()) where exists(select 1 from public.friend_connections where connection_id=connection_key and user_id=auth.uid());
 insert into public.friend_connections(connection_id,user_id,seen_at,active_at,closed)
 values(connection_key,auth.uid(),clock_timestamp(),clock_timestamp(),true)
 on conflict(connection_id) do update set closed=true,seen_at=clock_timestamp()
 where friend_connections.user_id=auth.uid() and not friend_connections.closed;
 if found and exists(select 1 from public.friend_activity where user_id=auth.uid() and sharing_enabled) then
  insert into public.friend_activity_signals(user_id,revision) values(auth.uid(),1)
   on conflict(user_id) do update set revision=friend_activity_signals.revision+1;
 end if;
end $$;
create or replace function public.get_friend_social_state() returns jsonb
language plpgsql security definer set search_path=public as $$
declare me uuid:=auth.uid(); result jsonb; stamp timestamptz:=clock_timestamp();
begin
 if me is null then raise exception '로그인이 필요합니다.'; end if;
 select jsonb_build_object('server_time',stamp,'sharing_enabled',coalesce((select sharing_enabled from public.friend_activity where user_id=me),true),
  'relationships',coalesce(jsonb_agg(jsonb_build_object(
   'user_id',p.id,'display_name',p.display_name,'avatar_url',p.avatar_url,'status',f.status,'requested_by',f.requested_by,
   'sharing_enabled',coalesce(a.sharing_enabled,true),
   'last_play_time',case when f.status='accepted' and coalesce(a.sharing_enabled,true) and a.last_activity_type='play' then public.friend_play_time(a.last_play_run_id,stamp) end,
   'last_seen_at',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_seen_at end,
   'last_work_id',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_work_id end,
   'last_activity_type',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_activity_type end,
   'last_played_at',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_played_at end,
   'connections',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then coalesce((select jsonb_agg(jsonb_build_object('seen_at',c.seen_at,'active_at',c.active_at,'work_id',c.work_id,'activity_type',c.activity_type,'last_work_id',v.last_work_id,'last_activity_type',v.last_activity_type,'play_time',case when c.activity_type='play' then public.friend_play_time(c.play_run_id,stamp) end,'last_play_time',case when v.last_activity_type='play' then public.friend_play_time(v.last_play_run_id,stamp) end) order by c.active_at desc,c.seen_at desc)
    from public.friend_connections c left join public.friend_visits v on v.visit_id=c.visit_id and v.user_id=c.user_id
    where c.user_id=p.id and not c.closed and c.seen_at>clock_timestamp()-interval '5 minutes'),'[]'::jsonb) else '[]'::jsonb end
  ) order by p.display_name,p.id),'[]'::jsonb)) into result
 from public.friendships f join public.public_profiles p on p.id=case when f.user_a=me then f.user_b else f.user_a end
 left join public.friend_activity a on a.user_id=p.id
 where me in (f.user_a,f.user_b) and f.status in ('pending','accepted');
 return result;
end $$;
notify pgrst,'reload schema';
