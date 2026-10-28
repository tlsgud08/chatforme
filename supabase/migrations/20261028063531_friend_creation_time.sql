-- Reuse the same interval ledger and pause rules, with separate play/create runs.
alter table public.friend_play_runs add column activity_type text not null default 'play' check(activity_type in ('play','create'));
alter table public.friend_play_runs add constraint friend_creation_no_session check(activity_type<>'create' or session_id is null);
create index friend_creation_runs_user_work_idx on public.friend_play_runs(user_id,work_id,last_in_room_at desc) where activity_type='create';
create or replace function public.enter_friend_play(me uuid,playing_session uuid,wid uuid,stamp timestamptz) returns uuid
language plpgsql security invoker set search_path=public as $$
declare run_id uuid;
begin
 select id into run_id from public.friend_play_runs where activity_type='play' and user_id=me and session_id=playing_session and last_in_room_at>=stamp-interval '3 minutes' order by last_in_room_at desc,created_at desc,id limit 1;
 if run_id is null then
  insert into public.friend_play_runs(user_id,session_id,work_id,last_in_room_at) values(me,playing_session,wid,stamp) returning id into run_id;
 else update public.friend_play_runs set last_in_room_at=greatest(last_in_room_at,stamp) where id=run_id;
 end if;
 return run_id;
end $$;
create function public.enter_friend_creation(me uuid,wid uuid,stamp timestamptz) returns uuid
language plpgsql security invoker set search_path=public as $$
declare run_id uuid;
begin
 select id into run_id from public.friend_play_runs where user_id=me and work_id=wid and activity_type='create' and last_in_room_at>=stamp-interval '3 minutes' order by last_in_room_at desc,created_at desc,id limit 1;
 if run_id is null then
  insert into public.friend_play_runs(user_id,work_id,activity_type,last_in_room_at) values(me,wid,'create',stamp) returning id into run_id;
 else update public.friend_play_runs set last_in_room_at=greatest(last_in_room_at,stamp) where id=run_id;
 end if;
 return run_id;
end $$;
revoke all on function public.enter_friend_creation(uuid,uuid,timestamptz) from public,anon,authenticated;
create or replace function public.touch_friend_activity_state(connection_key uuid,visit_key uuid,playing_session uuid default null,editing_work uuid default null,interaction_at timestamptz default null) returns void
language plpgsql security definer set search_path=public as $$
declare me uuid:=auth.uid(); c public.friend_connections; kind text; wid uuid; run_id uuid;
begin
 if me is null then raise exception '로그인이 필요합니다.'; end if;
 if playing_session is not null and editing_work is not null then raise exception '현재 활동은 하나만 지정해 주세요.'; end if;
 if editing_work is not null and (not exists(select 1 from public.works where id=editing_work) or public.can_edit_work(editing_work) is not true) then raise exception '작품을 수정할 권한이 없습니다.'; end if;
 perform public.touch_friend_visit(connection_key,visit_key,playing_session,interaction_at);
 select * into c from public.friend_connections where connection_id=connection_key and user_id=me and not closed for update;
 if not found then return; end if;
 if editing_work is not null then kind:='create';wid:=editing_work;run_id:=public.enter_friend_creation(me,editing_work,c.seen_at);
 elsif playing_session is not null then kind:='play';wid:=c.work_id;run_id:=c.play_run_id;
 end if;
 update public.friend_connections set activity_type=kind,work_id=wid,play_run_id=run_id where connection_id=c.connection_id;
 if kind is not null then
  update public.friend_visits set last_work_id=wid,last_played_at=c.active_at,last_activity_type=kind,last_play_run_id=run_id
   where visit_id=visit_key and (last_played_at is null or c.active_at>=last_played_at);
  update public.friend_activity set last_work_id=wid,last_played_at=c.active_at,last_activity_type=kind,last_play_run_id=run_id
   where user_id=me and (last_played_at is null or c.active_at>=last_played_at);
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
   'last_activity_time',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then public.friend_play_time(a.last_play_run_id,stamp) end,
   'last_play_time',case when f.status='accepted' and coalesce(a.sharing_enabled,true) and a.last_activity_type='play' then public.friend_play_time(a.last_play_run_id,stamp) end,
   'last_seen_at',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_seen_at end,
   'last_work_id',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_work_id end,
   'last_activity_type',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_activity_type end,
   'last_played_at',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_played_at end,
   'connections',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then coalesce((select jsonb_agg(jsonb_build_object('seen_at',c.seen_at,'active_at',c.active_at,'work_id',c.work_id,'activity_type',c.activity_type,'last_work_id',v.last_work_id,'last_activity_type',v.last_activity_type,'activity_time',public.friend_play_time(c.play_run_id,stamp),'last_activity_time',public.friend_play_time(v.last_play_run_id,stamp),'play_time',case when c.activity_type='play' then public.friend_play_time(c.play_run_id,stamp) end,'last_play_time',case when v.last_activity_type='play' then public.friend_play_time(v.last_play_run_id,stamp) end) order by c.active_at desc,c.seen_at desc)
    from public.friend_connections c left join public.friend_visits v on v.visit_id=c.visit_id and v.user_id=c.user_id
    where c.user_id=p.id and not c.closed and c.seen_at>clock_timestamp()-interval '5 minutes'),'[]'::jsonb) else '[]'::jsonb end
  ) order by p.display_name,p.id),'[]'::jsonb)) into result
 from public.friendships f join public.public_profiles p on p.id=case when f.user_a=me then f.user_b else f.user_a end
 left join public.friend_activity a on a.user_id=p.id
 where me in (f.user_a,f.user_b) and f.status in ('pending','accepted');
 return result;
end $$;
notify pgrst,'reload schema';
