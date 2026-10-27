-- Personal site: signed-in users may read every persona. Writes remain owned.
alter table public.personas enable row level security;
drop policy if exists personas_read_authenticated on public.personas;
create policy personas_read_authenticated on public.personas
  for select to authenticated using (true);
grant select on public.personas to authenticated;

-- The API key stays in the assigned participant's browser. Odd rounds use PC1,
-- even rounds PC2; retries and rerolls retain the original round's assignment.
create or replace function public.claim_multichat_generation(
  target_room uuid, is_reroll boolean default false
) returns integer language plpgsql security definer set search_path=public as $$
declare
  r public.multichat_rooms;
  latest public.multichat_messages;
  generation_round integer;
  expected_slot smallint;
  idx integer;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.' using errcode='42501';
  end if;
  select * into r from public.multichat_rooms where id=target_room for update;
  if not found or r.status is distinct from 'active' then
    raise exception '진행 중인 방이 아닙니다.';
  end if;
  generation_round := r.current_round - case when is_reroll then 1 else 0 end;
  if generation_round < 1 then raise exception '리롤할 응답이 없습니다.'; end if;
  expected_slot := case when generation_round % 2 = 1 then 1 else 2 end;
  if not exists (
    select 1 from public.multichat_members
    where room_id=target_room and user_id=auth.uid() and slot=expected_slot
  ) then
    raise exception '이 턴은 PC%의 API 키로 생성해야 합니다.', expected_slot using errcode='42501';
  end if;
  -- Room locking serializes claims from both browsers and duplicate tabs.
  if exists (
    select 1 from public.multichat_messages
    where room_id=target_room and role='assistant' and generation_status='streaming'
  ) then return 0; end if;

  select * into latest from public.multichat_messages
    where room_id=target_room and round_number=generation_round and role='assistant'
    order by reroll_index desc limit 1;
  if is_reroll then
    if latest.id is null then raise exception '리롤할 응답이 없습니다.'; end if;
    idx := latest.reroll_index + 1;
    -- Keep the completed variant active until its replacement succeeds.
    insert into public.multichat_messages(room_id,round_number,role,generation_status,reroll_index,is_active_variant)
      values(target_room,generation_round,'assistant','streaming',idx,false);
    return generation_round;
  end if;
  -- A failed reroll must be retried before advancing the story.
  if exists (
    select 1 from public.multichat_messages
    where room_id=target_room and round_number=r.current_round-1
      and role='assistant' and generation_status='interrupted'
      and reroll_index=(select max(m.reroll_index) from public.multichat_messages m
        where m.room_id=target_room and m.round_number=r.current_round-1 and m.role='assistant')
  ) then raise exception '이전 턴의 리롤을 먼저 다시 시도해 주세요.'; end if;
  if (select count(*) from public.multichat_submissions
      where room_id=target_room and round_number=generation_round) <> 2 then
    raise exception '두 사용자의 제출을 기다리고 있습니다.';
  end if;
  if latest.id is not null then
    if latest.generation_status='interrupted' then
      update public.multichat_messages set generation_status='streaming',content=''
        where id=latest.id;
      return generation_round;
    end if;
    return 0;
  end if;
  insert into public.multichat_messages(room_id,round_number,role,content)
    select target_room,generation_round,'user',
      string_agg('PC'||slot||': '||case when is_skip then '[skip]' else content end,E'\n\n' order by slot)
    from public.multichat_submissions where room_id=target_room and round_number=generation_round;
  insert into public.multichat_messages(room_id,round_number,role,generation_status)
    values(target_room,generation_round,'assistant','streaming');
  return generation_round;
end $$;

create or replace function public.complete_multichat_generation(
  target_room uuid, target_round integer, response_content text,
  in_tokens integer, out_tokens integer, response_cost numeric, failed boolean default false
) returns void language plpgsql security definer set search_path=public as $$
declare
  r public.multichat_rooms;
  latest public.multichat_messages;
  expected_slot smallint;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.' using errcode='42501';
  end if;
  select * into r from public.multichat_rooms where id=target_room for update;
  if not found or r.status is distinct from 'active' or target_round is null
      or target_round < 1 or target_round not in (r.current_round,r.current_round-1) then
    raise exception '완료할 수 없는 턴입니다.';
  end if;
  expected_slot := case when target_round % 2 = 1 then 1 else 2 end;
  if not exists (
    select 1 from public.multichat_members
    where room_id=target_room and user_id=auth.uid() and slot=expected_slot
  ) then
    raise exception '이 턴은 PC%만 완료할 수 있습니다.', expected_slot using errcode='42501';
  end if;
  select * into latest from public.multichat_messages
    where room_id=target_room and round_number=target_round and role='assistant'
    order by reroll_index desc limit 1;
  -- Duplicate success/failure deliveries cannot overwrite a committed answer.
  if latest.id is null or latest.generation_status <> 'streaming' then return; end if;
  if not failed then
    update public.multichat_messages set is_active_variant=false
      where room_id=target_room and round_number=target_round and role='assistant' and id<>latest.id;
  end if;
  update public.multichat_messages set content=coalesce(response_content,''),
    generation_status=case when failed then 'interrupted' else 'complete' end,
    is_active_variant=case when failed then is_active_variant else true end,
    input_tokens=greatest(coalesce(in_tokens,0),0),
    output_tokens=greatest(coalesce(out_tokens,0),0),cost=greatest(coalesce(response_cost,0),0)
    where id=latest.id;
  if not failed then
    update public.multichat_rooms set
      current_round=current_round+case when target_round=r.current_round then 1 else 0 end,
      total_input_tokens=total_input_tokens+greatest(coalesce(in_tokens,0),0),
      total_output_tokens=total_output_tokens+greatest(coalesce(out_tokens,0),0),
      total_cost=total_cost+greatest(coalesce(response_cost,0),0),updated_at=now()
      where id=target_room;
  end if;
end $$;

revoke all on function public.claim_multichat_generation(uuid,boolean) from public,anon;
revoke all on function public.complete_multichat_generation(uuid,integer,text,integer,integer,numeric,boolean) from public,anon;
grant execute on function public.claim_multichat_generation(uuid,boolean) to authenticated;
grant execute on function public.complete_multichat_generation(uuid,integer,text,integer,integer,numeric,boolean) to authenticated;
notify pgrst, 'reload schema';
