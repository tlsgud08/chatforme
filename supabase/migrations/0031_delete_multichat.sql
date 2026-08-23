-- Only the host can permanently delete a multichat room. Cascading foreign
-- keys remove members, submissions, game messages, and party messages.
create or replace function public.delete_multichat(target_room uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.';
  end if;

  delete from public.multichat_rooms
  where id = target_room
    and host_user_id = auth.uid();

  if not found then
    raise exception '방장만 멀티챗 방을 삭제할 수 있습니다.';
  end if;
end;
$$;

revoke all on function public.delete_multichat(uuid) from public;
grant execute on function public.delete_multichat(uuid) to authenticated;
