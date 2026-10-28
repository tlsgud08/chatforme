-- Room preference is separate from immutable PC slots and each generated turn.
alter table public.multichat_rooms
 add column progress_mode text not null default 'together' check(progress_mode in ('together','solo')),
 add column solo_slot smallint,
 add column progress_revision bigint not null default 0,
 add constraint multichat_progress_slot check((progress_mode='together' and solo_slot is null) or (progress_mode='solo' and solo_slot in(1,2) and solo_slot is not null));
alter table public.multichat_messages
 add column progress_mode text not null default 'together' check(progress_mode in ('together','solo')),
 add column active_slot smallint,
 add constraint multichat_turn_active_slot check((progress_mode='together' and active_slot is null) or (progress_mode='solo' and active_slot in(1,2) and active_slot is not null));

create function public.set_multichat_progress(target_room uuid,mode text,expected_revision bigint)
returns public.multichat_rooms language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms; own_slot smallint;
begin
 select * into r from public.multichat_rooms where id=target_room for update;
 select slot into own_slot from public.multichat_members where room_id=target_room and user_id=auth.uid();
 if r.id is null or own_slot is null or r.status<>'active' then raise exception '진행 중인 방의 참여자만 변경할 수 있습니다.'; end if;
 if mode is null or mode not in('together','solo') then raise exception '진행 방식을 확인해 주세요.'; end if;
 if expected_revision is null or expected_revision<>r.progress_revision then raise exception '다른 참여자가 진행 방식을 변경했습니다. 현재 설정을 확인하고 다시 선택해 주세요.'; end if;
 -- A mode change never discards the other PC's already submitted action.
 if mode='solo' and not exists(select 1 from public.multichat_messages where room_id=target_room and round_number=r.current_round and role='assistant')
 and exists(select 1 from public.multichat_submissions where room_id=target_room and round_number=r.current_round and slot<>own_slot) then
  raise exception '상대방이 이미 입력을 제출했습니다. 이번 턴을 함께 마치거나 해당 입력을 정리한 뒤 전환해 주세요.';
 end if;
 update public.multichat_rooms set progress_mode=mode,solo_slot=case when mode='solo' then own_slot end,
 progress_revision=progress_revision+1,updated_at=clock_timestamp() where id=target_room returning * into r;
 -- An unclaimed summary may follow the new mode; an already claimed one stays with its caller.
 return r;
end $$;
revoke all on function public.set_multichat_progress(uuid,text,bigint) from public,anon;
grant execute on function public.set_multichat_progress(uuid,text,bigint) to authenticated;

-- Solo calls use the current player's local key. The saved shared billing rule
-- remains intact. Historical solo retries/rerolls retain their original PC.
create or replace function public.multichat_payer_slot(target_room uuid,target_round integer) returns smallint
language sql stable security invoker set search_path=public as $$
 select coalesce(
 (select m.active_slot from public.multichat_messages m where m.room_id=r.id and m.round_number=target_round and m.role='assistant' and m.progress_mode='solo' order by m.reroll_index desc limit 1),
 case when r.progress_mode='solo' and target_round>=r.current_round then r.solo_slot
 when r.billing_mode='pc1' then 1 when r.billing_mode='pc2' then 2
 when greatest(0,target_round-r.billing_start_round) % (r.billing_pc1_turns+r.billing_pc2_turns)
 < case when r.billing_first_slot=1 then r.billing_pc1_turns else r.billing_pc2_turns end
 then r.billing_first_slot else 3-r.billing_first_slot end)::smallint
 from public.multichat_rooms r where r.id=target_room
$$;
create or replace function public.submit_multichat_action(target_room uuid,submission_content text,command_label text default null,command_body text default null,submission_id uuid default gen_random_uuid()) returns void language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms; m public.multichat_members; pname text;
begin
 select * into r from public.multichat_rooms where id=target_room for update;
 if not found or r.status<>'active' then raise exception '진행 중인 방이 아닙니다.'; end if;
 select * into m from public.multichat_members where room_id=target_room and user_id=auth.uid();
 if not found then raise exception '참여자가 아닙니다.'; end if;
 if r.progress_mode='solo' and m.slot<>r.solo_slot then raise exception '다른 참여자가 혼자 진행 중입니다. 진행 방식을 변경한 뒤 입력해 주세요.'; end if;
 if exists(select 1 from public.multichat_messages where room_id=target_room and round_number=r.current_round and role='assistant') then raise exception '현재 응답을 생성 중입니다.'; end if;
 select name into pname from public.personas where id=m.persona_id;
 if exists(select 1 from public.multichat_submissions where id=submission_id and room_id=target_room and user_id=auth.uid()) then return; end if;
 insert into public.multichat_submissions(id,room_id,round_number,user_id,slot,content,is_skip,persona_name,command_name,command_prompt)
 values(submission_id,target_room,r.current_round,auth.uid(),m.slot,coalesce(submission_content,''),trim(coalesce(submission_content,''))='',coalesce(nullif(pname,''),'PC'||m.slot),command_label,command_body);
end $$;

-- Compatibility: older browser tabs must pass through the same slot guards.
create or replace function public.submit_multichat_turn(target_room uuid,submission_content text) returns void
language plpgsql security definer set search_path=public as $$
begin perform public.submit_multichat_action(target_room,submission_content); end $$;
create or replace function public.claim_multichat_response(target_room uuid,retry boolean default false) returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms; m public.multichat_messages; payer smallint; round integer; token uuid;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;
 select * into r from public.multichat_rooms where id=target_room for update;
 if not found or r.status<>'active' or not public.is_multichat_member(target_room) then raise exception '참여자가 아닙니다.'; end if;
 if to_jsonb(r)->>'summary_request_id' is not null then return null; end if;
 select * into m from public.multichat_messages where room_id=target_room and role='assistant' and generation_status='streaming' order by round_number,reroll_index desc limit 1;
 if m.id is not null and m.generation_user_id is not null and m.claimed_at>now()-interval '8 minutes' then return null; end if;
 if m.id is not null and m.generation_user_id is not null and not retry then return null; end if;
 if m.id is null and retry then
   select * into m from public.multichat_messages where room_id=target_room and role='assistant' and generation_status='interrupted' and round_number>=r.current_round-1 order by round_number desc,reroll_index desc limit 1;
 end if;
 if m.id is not null then round:=m.round_number; payer:=case when m.progress_mode='solo' then m.active_slot when m.generation_slot is not null then m.generation_slot else public.multichat_payer_slot(target_room,round) end;
 else
   round:=r.current_round; payer:=public.multichat_payer_slot(target_room,round);
   if exists(select 1 from public.multichat_messages where room_id=target_room and role='assistant' and (round_number=round or (round_number=round-1 and generation_status='interrupted' and reroll_index=(select max(x.reroll_index) from public.multichat_messages x where x.room_id=target_room and x.round_number=round-1 and x.role='assistant')))) then return null; end if;
   if r.progress_mode='solo' then
    if not exists(select 1 from public.multichat_submissions where room_id=target_room and round_number=round and slot=r.solo_slot)
     or exists(select 1 from public.multichat_submissions where room_id=target_room and round_number=round and slot<>r.solo_slot) then return null; end if;
   elsif (select count(*) from public.multichat_submissions where room_id=target_room and round_number=round)<>2 then return null; end if;
 end if;
 if not exists(select 1 from public.multichat_members where room_id=target_room and user_id=auth.uid() and slot=payer) then return null; end if;
 token:=gen_random_uuid();
 if m.id is null then
   insert into public.multichat_messages(room_id,round_number,role,content) values(target_room,round,'user',public.multichat_input(target_room,round));
   insert into public.multichat_messages(room_id,round_number,role,generation_status,generation_slot,generation_user_id,claim_token,claimed_at,progress_mode,active_slot) values(target_room,round,'assistant','streaming',payer,auth.uid(),token,now(),r.progress_mode,r.solo_slot) returning * into m;
 else
   update public.multichat_messages set generation_status='streaming',content='',generation_slot=payer,generation_user_id=auth.uid(),claim_token=token,claimed_at=now() where id=m.id returning * into m;
 end if;
 return jsonb_build_object('messageId',m.id,'round',round,'slot',payer,'token',token,'progressMode',m.progress_mode,'activeSlot',m.active_slot);
end $$;
create or replace function public.request_multichat_reroll(target_room uuid) returns void language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms; idx integer; original public.multichat_messages;
begin
 select * into r from public.multichat_rooms where id=target_room for update;
 if not found or r.host_user_id is distinct from auth.uid() or r.status<>'active' then raise exception '방장만 리롤할 수 있습니다.'; end if;
 if r.current_round<=1 then raise exception '리롤할 응답이 없습니다.'; end if;
 if exists(select 1 from public.multichat_messages where room_id=target_room and generation_status='streaming') then raise exception '생성이 끝난 뒤 다시 시도해 주세요.'; end if;
 select coalesce(max(reroll_index),-1)+1 into idx from public.multichat_messages where room_id=target_room and round_number=r.current_round-1 and role='assistant';
 select * into original from public.multichat_messages where room_id=target_room and round_number=r.current_round-1 and role='assistant' order by is_active_variant desc,reroll_index desc limit 1;
 insert into public.multichat_messages(room_id,round_number,role,generation_status,reroll_index,is_active_variant,generation_slot,requested_by,progress_mode,active_slot)
 values(target_room,r.current_round-1,'assistant','streaming',idx,false,public.multichat_payer_slot(target_room,r.current_round-1),auth.uid(),original.progress_mode,original.active_slot);
end $$;
create or replace function public.set_multichat_billing(target_room uuid,mode text,pc1_turns integer default 1,pc2_turns integer default 1,first_slot integer default 1)
returns public.multichat_rooms language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms;
begin
 select * into r from public.multichat_rooms where id=target_room for update;
 if not found or not public.is_multichat_member(target_room) then raise exception '참여자가 아닙니다.'; end if;
 if mode not in ('alternate','pc1','pc2') or mode is null or pc1_turns is null or pc2_turns is null or pc1_turns not between 1 and 1000 or pc2_turns not between 1 and 1000 or first_slot not in(1,2) or first_slot is null then raise exception 'API 키 사용 규칙을 확인해 주세요.'; end if;
 update public.multichat_rooms set billing_mode=mode,billing_pc1_turns=pc1_turns,billing_pc2_turns=pc2_turns,billing_first_slot=first_slot,
 billing_start_round=greatest(1,current_round)+case when exists(select 1 from public.multichat_messages where room_id=target_room and round_number=r.current_round and generation_status='streaming' and generation_user_id is not null) then 1 else 0 end,updated_at=now()
 where id=target_room returning * into r;
 update public.multichat_messages set generation_slot=case when progress_mode='solo' then active_slot else public.multichat_payer_slot(target_room,round_number) end
 where room_id=target_room and generation_status='streaming' and generation_user_id is null;
 return r;
end $$;

notify pgrst,'reload schema';

-- Reject a submit that raced a turn advance or mode change. Old clients still
-- use the guarded legacy endpoint; current clients also carry their snapshot.
create function public.submit_multichat_action_checked(target_room uuid,expected_round integer,expected_progress_revision bigint,
 submission_content text,command_label text default null,command_body text default null,submission_id uuid default gen_random_uuid())
returns void language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms;
begin
 select * into r from public.multichat_rooms where id=target_room for update;
 if r.id is null or not public.is_multichat_member(target_room) then raise exception '참여자가 아닙니다.'; end if;
 if expected_round is distinct from r.current_round or expected_progress_revision is distinct from r.progress_revision then
  raise exception '턴 또는 진행 방식이 변경되었습니다. 현재 상태를 확인하고 다시 전송해 주세요.';
 end if;
 perform public.submit_multichat_action(target_room,submission_content,command_label,command_body,submission_id);
end $$;
revoke all on function public.submit_multichat_action_checked(uuid,integer,bigint,text,text,text,uuid) from public,anon;
grant execute on function public.submit_multichat_action_checked(uuid,integer,bigint,text,text,text,uuid) to authenticated;
notify pgrst,'reload schema';
