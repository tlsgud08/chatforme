-- Serialize stop and heartbeat in the same order before the last-seen trigger.
create or replace function public.stop_friend_activity(connection_key uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or connection_key is null then return; end if;
 -- Match heartbeat lock order: user activity first, then individual connection.
 insert into public.friend_activity(user_id) values(auth.uid()) on conflict do nothing;
 perform 1 from public.friend_activity where user_id=auth.uid() for update;
 insert into public.friend_connections(connection_id,user_id,seen_at,active_at,closed)
 values(connection_key,auth.uid(),clock_timestamp(),clock_timestamp(),true)
 on conflict(connection_id) do update set closed=true,seen_at=clock_timestamp()
 where friend_connections.user_id=auth.uid() and not friend_connections.closed;
 if found and exists(select 1 from public.friend_activity where user_id=auth.uid() and sharing_enabled) then
  insert into public.friend_activity_signals(user_id,revision) values(auth.uid(),1)
   on conflict(user_id) do update set revision=friend_activity_signals.revision+1;
 end if;
end $$;
