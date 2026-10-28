-- Keep a server-confirmed last connection time after connection cleanup.
alter table public.friend_activity add column last_seen_at timestamptz;
update public.friend_activity a set last_seen_at=s.seen_at
from (select user_id,max(seen_at) seen_at from public.friend_connections group by user_id) s
where a.user_id=s.user_id;

-- Invoked only by validated connection writes. Reuse their transaction and
-- existing realtime signal; no extra heartbeat or public RPC is needed.
create function public.record_friend_last_seen() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if TG_OP='INSERT' then
  if new.closed then return new; end if; -- Stop-before-heartbeat tombstone.
 else
  if old.closed or new.seen_at is not distinct from old.seen_at then return new; end if;
 end if;
 insert into public.friend_activity(user_id,last_seen_at) values(new.user_id,new.seen_at)
 on conflict(user_id) do update set last_seen_at=greatest(friend_activity.last_seen_at,excluded.last_seen_at);
 return new;
end $$;
revoke all on function public.record_friend_last_seen() from public,anon,authenticated;
create trigger record_friend_last_seen after insert or update of seen_at on public.friend_connections
for each row execute function public.record_friend_last_seen();

create or replace function public.get_friend_social_state() returns jsonb
language plpgsql security definer set search_path=public as $$
declare me uuid:=auth.uid(); result jsonb;
begin
 if me is null then raise exception '로그인이 필요합니다.'; end if;
 select jsonb_build_object('server_time',clock_timestamp(),'sharing_enabled',coalesce((select sharing_enabled from public.friend_activity where user_id=me),true),
  'relationships',coalesce(jsonb_agg(jsonb_build_object(
   'user_id',p.id,'display_name',p.display_name,'avatar_url',p.avatar_url,'status',f.status,'requested_by',f.requested_by,
   'sharing_enabled',coalesce(a.sharing_enabled,true),
   'last_seen_at',case when f.status='accepted' and coalesce(a.sharing_enabled,true) then a.last_seen_at end,
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
