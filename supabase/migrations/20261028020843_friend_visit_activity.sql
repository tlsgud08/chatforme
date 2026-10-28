-- Keep the current visit's last work separate from the lifetime last work.
create table public.friend_visits (
 visit_id uuid primary key,
 user_id uuid not null references public.profiles(id) on delete cascade,
 last_work_id uuid references public.works(id) on delete set null,
 last_played_at timestamptz,
 created_at timestamptz not null default now()
);
create index friend_visits_user_id_idx on public.friend_visits(user_id);
create index friend_visits_last_work_id_idx on public.friend_visits(last_work_id);
alter table public.friend_visits enable row level security;
create policy friend_visits_own on public.friend_visits for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.friend_visits from anon;
grant select on public.friend_visits to authenticated;
alter table public.friend_connections add column visit_id uuid references public.friend_visits(visit_id) on delete set null;
create index friend_connections_visit_id_idx on public.friend_connections(visit_id);

create function public.touch_friend_visit(connection_key uuid,visit_key uuid,playing_session uuid default null,interaction_at timestamptz default null) returns void
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
  update public.friend_visits set last_work_id=c.work_id,last_played_at=c.active_at
   where visit_id=visit_key and (last_played_at is null or c.active_at>=last_played_at);
  -- Equal client timestamps can occur when switching rooms quickly. The latest
  -- validated update wins the tie without letting an older tab replace history.
  update public.friend_activity set last_work_id=c.work_id,last_played_at=c.active_at
   where user_id=me and (last_played_at is null or c.active_at>=last_played_at);
 end if;
end $$;
revoke all on function public.touch_friend_visit(uuid,uuid,uuid,timestamptz) from public,anon;
grant execute on function public.touch_friend_visit(uuid,uuid,uuid,timestamptz) to authenticated;

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
   'last_played_at',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_played_at end,
   'connections',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then coalesce((select jsonb_agg(jsonb_build_object('seen_at',c.seen_at,'active_at',c.active_at,'work_id',c.work_id,'last_work_id',v.last_work_id) order by c.active_at desc,c.seen_at desc)
    from public.friend_connections c left join public.friend_visits v on v.visit_id=c.visit_id and v.user_id=c.user_id
    where c.user_id=p.id and not c.closed and c.seen_at>clock_timestamp()-interval '5 minutes'),'[]'::jsonb) else '[]'::jsonb end
  ) order by p.display_name,p.id),'[]'::jsonb)) into result
 from public.friendships f join public.public_profiles p on p.id=case when f.user_a=me then f.user_b else f.user_a end
 left join public.friend_activity a on a.user_id=p.id
 where me in (f.user_a,f.user_b) and f.status in ('pending','accepted');
 return result;
end $$;
notify pgrst,'reload schema';
