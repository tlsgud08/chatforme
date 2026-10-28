-- Track playing and creating with the same visit/history semantics.
alter table public.friend_connections add column activity_type text check(activity_type in ('play','create'));
alter table public.friend_visits add column last_activity_type text not null default 'play' check(last_activity_type in ('play','create'));
alter table public.friend_activity add column last_activity_type text not null default 'play' check(last_activity_type in ('play','create'));

create or replace function public.touch_friend_activity(connection_key uuid,playing_session uuid default null,interaction_at timestamptz default null) returns void
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
 insert into public.friend_connections(connection_id,user_id,seen_at,active_at,work_id,activity_type) values(connection_key,me,stamp,interacted,wid,case when wid is not null then 'play' end)
  on conflict(connection_id) do update set seen_at=excluded.seen_at,active_at=greatest(friend_connections.active_at,excluded.active_at),work_id=excluded.work_id,activity_type=excluded.activity_type where not friend_connections.closed;
 if not found then return; end if; -- A late request cannot reopen a closed tab.
 if wid is not null then
  update public.friend_activity set last_work_id=wid,last_played_at=interacted,last_activity_type='play'
   where user_id=me and (last_played_at is null or interacted>last_played_at);
 end if;
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
  update public.friend_visits set last_work_id=c.work_id,last_played_at=c.active_at,last_activity_type='play'
   where visit_id=visit_key and (last_played_at is null or c.active_at>=last_played_at);
  -- Equal client timestamps can occur when switching rooms quickly. The latest
  -- validated update wins the tie without letting an older tab replace history.
  update public.friend_activity set last_work_id=c.work_id,last_played_at=c.active_at,last_activity_type='play'
   where user_id=me and (last_played_at is null or c.active_at>=last_played_at);
 end if;
end $$;

create function public.touch_friend_activity_state(connection_key uuid,visit_key uuid,playing_session uuid default null,editing_work uuid default null,interaction_at timestamptz default null) returns void
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
  update public.friend_visits set last_work_id=wid,last_played_at=c.active_at,last_activity_type=kind
   where visit_id=visit_key and (last_played_at is null or c.active_at>=last_played_at);
  update public.friend_activity set last_work_id=wid,last_played_at=c.active_at,last_activity_type=kind
   where user_id=me and (last_played_at is null or c.active_at>=last_played_at);
 end if;
end $$;
revoke all on function public.touch_friend_activity_state(uuid,uuid,uuid,uuid,timestamptz) from public,anon;
grant execute on function public.touch_friend_activity_state(uuid,uuid,uuid,uuid,timestamptz) to authenticated;

create or replace function public.get_friend_social_state() returns jsonb
language plpgsql security definer set search_path=public as $$
declare me uuid:=auth.uid(); result jsonb;
begin
 if me is null then raise exception '로그인이 필요합니다.'; end if;
 select jsonb_build_object('server_time',clock_timestamp(),'sharing_enabled',coalesce((select sharing_enabled from public.friend_activity where user_id=me),true),
  'relationships',coalesce(jsonb_agg(jsonb_build_object(
   'user_id',p.id,'display_name',p.display_name,'avatar_url',p.avatar_url,'status',f.status,'requested_by',f.requested_by,
   'sharing_enabled',coalesce(a.sharing_enabled,true),
   'last_work_id',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_work_id end,
   'last_activity_type',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_activity_type end,
   'last_played_at',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_played_at end,
   'connections',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then coalesce((select jsonb_agg(jsonb_build_object('seen_at',c.seen_at,'active_at',c.active_at,'work_id',c.work_id,'activity_type',c.activity_type,'last_work_id',v.last_work_id,'last_activity_type',v.last_activity_type) order by c.active_at desc,c.seen_at desc)
    from public.friend_connections c left join public.friend_visits v on v.visit_id=c.visit_id and v.user_id=c.user_id
    where c.user_id=p.id and not c.closed and c.seen_at>clock_timestamp()-interval '5 minutes'),'[]'::jsonb) else '[]'::jsonb end
  ) order by p.display_name,p.id),'[]'::jsonb)) into result
 from public.friendships f join public.public_profiles p on p.id=case when f.user_a=me then f.user_b else f.user_a end
 left join public.friend_activity a on a.user_id=p.id
 where me in (f.user_a,f.user_b) and f.status in ('pending','accepted');
 return result;
end $$;
notify pgrst,'reload schema';
