-- Both members can rename. Keep the public room and its canonical session in
-- sync in one transaction; deletion continues to use the existing host RPC.
create function public.rename_multichat(target_room uuid,new_title text) returns void
language plpgsql security definer set search_path=public as $$
declare title_value text:=btrim(new_title);
begin
 perform 1 from public.multichat_rooms where id=target_room for update;
 if not found or auth.uid() is null or not public.is_multichat_member(target_room) then raise exception '참여자만 방 이름을 변경할 수 있습니다.'; end if;
 if title_value is null or char_length(title_value) not between 1 and 60 then raise exception '방 이름은 1~60자로 입력해 주세요.'; end if;
 update public.multichat_rooms set title=title_value,updated_at=clock_timestamp() where id=target_room;
 update public.sessions set title=title_value,updated_at=clock_timestamp() where id=target_room and multichat_room_id=target_room;
end $$;
revoke all on function public.rename_multichat(uuid,text) from public,anon;
grant execute on function public.rename_multichat(uuid,text) to authenticated;
notify pgrst,'reload schema';
