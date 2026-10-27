-- Both room participants may edit/delete every kind of message. Party chat is
-- independent of story generation and never enters the canonical transcript.
create or replace function public.multichat_forget_message() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 delete from public.messages where id=old.id and session_id=old.room_id;
 update public.sessions set prompt_cache_message_id=null where id=old.room_id and prompt_cache_message_id=old.id;
 return old;
end $$;
create trigger multichat_forget_message after delete on public.multichat_messages
 for each row execute function public.multichat_forget_message();
revoke all on function public.multichat_forget_message() from public,anon,authenticated;

create or replace function public.edit_multichat_item_checked(target_room uuid,item_kind text,item_id uuid,new_content text,expected_content text) returns void
language plpgsql security definer set search_path=public as $$
declare affected integer; previous text; r public.multichat_rooms;
begin
 select * into r from public.multichat_rooms where id=target_room for update;
 if not found or auth.uid() is null or not public.is_multichat_member(target_room) then raise exception '참여자가 아닙니다.'; end if;
 if item_kind is null or item_kind not in ('submission','assistant','party') then raise exception '잘못된 메시지 종류입니다.'; end if;
 if item_kind<>'party' and (r.summary_request_id is not null or exists(select 1 from public.multichat_messages where room_id=target_room and generation_status='streaming')) then raise exception '생성 또는 요약이 끝난 뒤 수정해 주세요.'; end if;
 if new_content is null or (item_kind='party' and (char_length(new_content)<1 or char_length(new_content)>4000)) then raise exception '메시지 내용을 확인해 주세요.'; end if;
 if item_kind='submission' then
  select content,round_number into previous,affected from public.multichat_submissions where id=item_id and room_id=target_room for update;
 elsif item_kind='assistant' then
  select content,round_number into previous,affected from public.multichat_messages where id=item_id and room_id=target_room and role='assistant' for update;
 else
  select content into previous from public.multichat_party_messages where id=item_id and room_id=target_room for update;
 end if;
 if not found then raise exception '메시지가 삭제되었거나 존재하지 않습니다.'; end if;
 if expected_content is not null and previous is distinct from expected_content then raise exception '다른 참여자가 메시지를 변경했어요. 최신 내용을 확인한 뒤 다시 수정해 주세요.'; end if;
 if item_kind='submission' then
  update public.multichat_submissions set content=new_content,is_skip=trim(new_content)='',command_name=null,command_prompt=null where id=item_id;
  update public.multichat_messages set content=public.multichat_input(target_room,affected) where room_id=target_room and round_number=affected and role='user';
 elsif item_kind='assistant' then update public.multichat_messages set content=new_content where id=item_id;
 else update public.multichat_party_messages set content=new_content where id=item_id;
 end if;
 if affected is not null then
  delete from public.summary_versions where session_id=target_room and summarized_through_turn>=affected;
  update public.sessions set summary=coalesce((select string_agg(content,E'\n\n' order by created_at,id) from public.summary_versions where session_id=target_room and is_active),''),summary_last_turn=coalesce((select max(summarized_through_turn) from public.summary_versions where session_id=target_room and is_active),0) where id=target_room;
 end if;
 update public.multichat_rooms set updated_at=clock_timestamp() where id=target_room;
end $$;
-- Keep existing browser tabs compatible with the relaxed participant policy.
create or replace function public.edit_multichat_item(target_room uuid,item_kind text,item_id uuid,new_content text) returns void
language sql security invoker set search_path=public as $$
 select public.edit_multichat_item_checked(target_room,item_kind,item_id,new_content,null)
$$;

create or replace function public.delete_multichat_item(target_room uuid,item_kind text,item_id uuid,expected_content text default null) returns void
language plpgsql security definer set search_path=public as $$
declare affected integer; previous text; active boolean; replacement uuid; r public.multichat_rooms;
begin
 select * into r from public.multichat_rooms where id=target_room for update;
 if not found or auth.uid() is null or not public.is_multichat_member(target_room) then raise exception '참여자가 아닙니다.'; end if;
 if item_kind is null or item_kind not in ('submission','assistant','party') then raise exception '잘못된 메시지 종류입니다.'; end if;
 if item_kind<>'party' and (r.summary_request_id is not null or exists(select 1 from public.multichat_messages where room_id=target_room and generation_status='streaming')) then raise exception '생성 또는 요약이 끝난 뒤 삭제해 주세요.'; end if;
 if item_kind='submission' then
  select content,round_number into previous,affected from public.multichat_submissions where id=item_id and room_id=target_room for update;
 elsif item_kind='assistant' then
  select content,round_number,is_active_variant into previous,affected,active from public.multichat_messages where id=item_id and room_id=target_room and role='assistant' for update;
 else
  select content into previous from public.multichat_party_messages where id=item_id and room_id=target_room for update;
 end if;
 if not found then return; end if; -- A lost delete acknowledgement is safe to retry.
 if expected_content is not null and previous is distinct from expected_content then raise exception '다른 참여자가 메시지를 변경했어요. 최신 내용을 확인한 뒤 삭제해 주세요.'; end if;
 if item_kind='submission' then
  delete from public.multichat_submissions where id=item_id;
  if exists(select 1 from public.multichat_submissions where room_id=target_room and round_number=affected) then
   update public.multichat_messages set content=public.multichat_input(target_room,affected) where room_id=target_room and round_number=affected and role='user';
  else delete from public.multichat_messages where room_id=target_room and round_number=affected and role='user'; end if;
 elsif item_kind='assistant' then
  delete from public.multichat_messages where id=item_id;
  if active then
   select id into replacement from public.multichat_messages where room_id=target_room and round_number=affected and role='assistant' and generation_status='complete' order by reroll_index desc limit 1;
   if replacement is not null then update public.multichat_messages set is_active_variant=(id=replacement) where room_id=target_room and round_number=affected and role='assistant'; end if;
  end if;
  -- Dismissing an interrupted current reply must not immediately regenerate it.
  if affected=r.current_round and not exists(select 1 from public.multichat_messages where room_id=target_room and round_number=affected and role='assistant') then
   update public.multichat_rooms set current_round=current_round+1 where id=target_room;
  end if;
 else delete from public.multichat_party_messages where id=item_id;
 end if;
 if affected is not null then
  delete from public.summary_versions where session_id=target_room and summarized_through_turn>=affected;
  update public.sessions set summary=coalesce((select string_agg(content,E'\n\n' order by created_at,id) from public.summary_versions where session_id=target_room and is_active),''),summary_last_turn=coalesce((select max(summarized_through_turn) from public.summary_versions where session_id=target_room and is_active),0) where id=target_room;
 end if;
 -- DELETE payloads may only contain primary keys. The room update makes every
 -- participant reconcile the transcript even if a filtered delete is omitted.
 update public.multichat_rooms set updated_at=clock_timestamp() where id=target_room;
end $$;
revoke all on function public.edit_multichat_item_checked(uuid,text,uuid,text,text),public.edit_multichat_item(uuid,text,uuid,text),public.delete_multichat_item(uuid,text,uuid,text) from public,anon;
grant execute on function public.edit_multichat_item_checked(uuid,text,uuid,text,text),public.edit_multichat_item(uuid,text,uuid,text),public.delete_multichat_item(uuid,text,uuid,text) to authenticated;
notify pgrst,'reload schema';
