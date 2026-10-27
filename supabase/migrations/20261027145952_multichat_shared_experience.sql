-- Multichat shares the ordinary session settings, prompt context and menu.
alter table public.multichat_rooms
  add column billing_mode text not null default 'alternate' check(billing_mode in ('alternate','pc1','pc2')),
  add column billing_pc1_turns integer not null default 1 check(billing_pc1_turns between 1 and 1000),
  add column billing_pc2_turns integer not null default 1 check(billing_pc2_turns between 1 and 1000),
  add column billing_first_slot smallint not null default 1 check(billing_first_slot in (1,2)),
  add column billing_start_round integer not null default 1;
alter table public.multichat_members add column user_note text not null default '';
alter table public.multichat_submissions add column persona_name text not null default '',
  add column command_name text, add column command_prompt text;
alter table public.multichat_submissions drop constraint if exists multichat_submissions_content_check;
alter table public.multichat_messages add column generation_slot smallint,
  add column generation_user_id uuid references public.profiles(id), add column claim_token uuid,
  add column claimed_at timestamptz, add column requested_by uuid references public.profiles(id),
  add column cache_read_tokens integer, add column cache_write_tokens integer;
alter table public.sessions add column multichat_room_id uuid unique references public.multichat_rooms(id) on delete cascade;

create or replace function public.multichat_payer_slot(target_room uuid,target_round integer) returns smallint
language sql stable security invoker set search_path=public as $$
 select case when billing_mode='pc1' then 1 when billing_mode='pc2' then 2
 when greatest(0,target_round-billing_start_round) % (billing_pc1_turns+billing_pc2_turns)
   < case when billing_first_slot=1 then billing_pc1_turns else billing_pc2_turns end
 then billing_first_slot else 3-billing_first_slot end::smallint from public.multichat_rooms where id=target_room
$$;
create or replace function public.is_multichat_host(target_room uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.multichat_rooms where id=target_room and host_user_id=(select auth.uid()))
$$;
-- Listing a room never grants access to its transcript or API credentials.
create policy multichat_rooms_list on public.multichat_rooms for select to authenticated using(true);
create policy multichat_members_list on public.multichat_members for select to authenticated using(true);
drop policy multichat_submissions_member_select on public.multichat_submissions;
create policy multichat_submissions_member_select on public.multichat_submissions for select to authenticated using(public.is_multichat_member(room_id));
create policy multichat_session_read on public.sessions for select to authenticated using(multichat_room_id is not null and public.is_multichat_member(multichat_room_id));
create policy multichat_session_settings on public.sessions for update to authenticated
 using(multichat_room_id is not null and public.is_multichat_member(multichat_room_id))
 with check(multichat_room_id=id and public.is_multichat_member(multichat_room_id));
create policy multichat_context_read on public.messages for select to authenticated using(public.is_multichat_member(session_id));
create policy multichat_summary_read on public.summary_versions for select to authenticated using(public.is_multichat_member(session_id));
create policy multichat_story_read on public.story_notes for select to authenticated using(public.is_multichat_member(session_id));
create policy multichat_work_read on public.works for select to authenticated using(exists(select 1 from public.multichat_rooms r where r.work_id=works.id));
create policy multichat_books_read on public.keyword_books for select to authenticated using(exists(select 1 from public.sessions s where s.multichat_room_id is not null and public.is_multichat_member(s.id) and (keyword_books.work_id=s.work_id or (s.work_combination_enabled and keyword_books.work_id=any(s.combined_work_ids)))));
create policy multichat_starts_read on public.start_configs for select to authenticated using(exists(select 1 from public.multichat_rooms r where r.work_id=start_configs.work_id));
create policy multichat_themes_read on public.themes for select to authenticated using(exists(select 1 from public.sessions s where s.multichat_room_id is not null and public.is_multichat_member(s.id) and (themes.id=s.theme_id or themes.work_id=s.work_id or (s.work_combination_enabled and themes.work_id=any(s.combined_work_ids)))));

create or replace function public.multichat_create_session() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 insert into public.sessions(id,user_id,work_id,title,multichat_room_id,model_override,output_tokens_override,output_settings_override_enabled,start_config_id)
 values(new.id,new.host_user_id,new.work_id,new.title,new.id,new.model,new.output_tokens,new.output_tokens is not null,
 (select id from public.start_configs where work_id=new.work_id order by is_default desc,sort_order,id limit 1));
 return new;
end $$;
create trigger multichat_create_session after insert on public.multichat_rooms for each row execute function public.multichat_create_session();
insert into public.sessions(id,user_id,work_id,title,multichat_room_id,model_override,output_tokens_override,total_input_tokens,total_output_tokens,total_cost,output_settings_override_enabled,start_config_id)
 select r.id,r.host_user_id,r.work_id,r.title,r.id,r.model,r.output_tokens,r.total_input_tokens,r.total_output_tokens,r.total_cost,r.output_tokens is not null,
 (select id from public.start_configs where work_id=r.work_id order by is_default desc,sort_order,id limit 1)
 from public.multichat_rooms r on conflict(id) do nothing;
create or replace function public.multichat_session_identity() returns trigger language plpgsql set search_path=public as $$
begin
 if old.multichat_room_id is not null and (new.user_id is distinct from old.user_id or new.work_id is distinct from old.work_id or new.multichat_room_id is distinct from old.multichat_room_id or new.id<>old.id) then
 raise exception '멀티챗의 소유자와 원본 작품은 변경할 수 없습니다.'; end if;
 return new;
end $$;
create trigger multichat_session_identity before update on public.sessions for each row execute function public.multichat_session_identity();

-- Ordinary prompt/summary components consume this canonical transcript. Party
-- messages are deliberately stored only in their own table and never mirrored.
create or replace function public.multichat_mirror_message() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 insert into public.messages(id,session_id,role,content,turn_index,reroll_index,is_active_variant,generation_status,input_tokens,output_tokens,cost,cache_read_tokens,cache_write_tokens,created_at,usage_accounted)
 values(new.id,new.room_id,new.role,new.content,new.round_number,new.reroll_index+1,new.is_active_variant,new.generation_status,new.input_tokens,new.output_tokens,new.cost,new.cache_read_tokens,new.cache_write_tokens,new.created_at,new.generation_status='complete')
 on conflict(id) do update set content=excluded.content,is_active_variant=excluded.is_active_variant,generation_status=excluded.generation_status,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cost=excluded.cost,cache_read_tokens=excluded.cache_read_tokens,cache_write_tokens=excluded.cache_write_tokens,usage_accounted=excluded.usage_accounted;
 return new;
end $$;
create trigger multichat_mirror_message after insert or update on public.multichat_messages for each row execute function public.multichat_mirror_message();
insert into public.messages(id,session_id,role,content,turn_index,reroll_index,is_active_variant,generation_status,input_tokens,output_tokens,cost,created_at,usage_accounted)
 select id,room_id,role,content,round_number,reroll_index+1,is_active_variant,generation_status,input_tokens,output_tokens,cost,created_at,generation_status='complete' from public.multichat_messages on conflict(id) do nothing;

create or replace function public.join_multichat_room(target_room uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms; pid uuid;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;
 select * into r from public.multichat_rooms where id=target_room for update;
 if not found then raise exception '방을 찾을 수 없습니다.'; end if;
 if public.is_multichat_member(target_room) then return target_room; end if;
 if r.status<>'lobby' or (select count(*) from public.multichat_members where room_id=target_room)>=2 then raise exception '참가 가능한 빈자리가 없습니다.'; end if;
 select id into pid from public.personas where user_id=auth.uid() order by is_default desc,created_at limit 1;
 insert into public.multichat_members(room_id,user_id,slot,persona_id) values(target_room,auth.uid(),2,pid);
 return target_room;
end $$;
create or replace function public.set_multichat_note(target_room uuid,note text) returns void language plpgsql security definer set search_path=public as $$
begin
 update public.multichat_members set user_note=coalesce(note,'') where room_id=target_room and user_id=auth.uid();
 if not found then raise exception '참여자가 아닙니다.'; end if;
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
 update public.multichat_messages set generation_slot=public.multichat_payer_slot(target_room,round_number)
 where room_id=target_room and generation_status='streaming' and generation_user_id is null;
 return r;
end $$;
create or replace function public.start_multichat(target_room uuid) returns void language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms; cfg public.start_configs;
begin
 select * into r from public.multichat_rooms where id=target_room for update;
 if not found or r.host_user_id is distinct from auth.uid() or r.status<>'lobby' then raise exception '방장만 시작할 수 있습니다.'; end if;
 if (select count(*) from public.multichat_members where room_id=target_room)<>2 then raise exception '두 명이 모두 참가해야 합니다.'; end if;
 update public.multichat_members m set persona_id=(select p.id from public.personas p where p.user_id=m.user_id order by is_default desc,created_at limit 1) where m.room_id=target_room and m.persona_id is null;
 select c.* into cfg from public.start_configs c join public.sessions s on s.start_config_id=c.id where s.id=target_room;
 if cfg.initial_context<>'' then insert into public.messages(session_id,role,content,turn_index,is_hidden) values(target_room,'user',cfg.initial_context,0,true); end if;
 if cfg.initial_message<>'' then insert into public.multichat_messages(room_id,round_number,role,content) values(target_room,0,'assistant',cfg.initial_message); end if;
 update public.multichat_rooms set status='active',current_round=1,started_at=now(),updated_at=now() where id=target_room;
end $$;
create or replace function public.submit_multichat_action(target_room uuid,submission_content text,command_label text default null,command_body text default null,submission_id uuid default gen_random_uuid()) returns void language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms; m public.multichat_members; pname text;
begin
 select * into r from public.multichat_rooms where id=target_room for update;
 if not found or r.status<>'active' then raise exception '진행 중인 방이 아닙니다.'; end if;
 select * into m from public.multichat_members where room_id=target_room and user_id=auth.uid();
 if not found then raise exception '참여자가 아닙니다.'; end if;
 if exists(select 1 from public.multichat_messages where room_id=target_room and round_number=r.current_round and role='assistant') then raise exception '현재 응답을 생성 중입니다.'; end if;
 select name into pname from public.personas where id=m.persona_id;
 if exists(select 1 from public.multichat_submissions where id=submission_id and room_id=target_room and user_id=auth.uid()) then return; end if;
 insert into public.multichat_submissions(id,room_id,round_number,user_id,slot,content,is_skip,persona_name,command_name,command_prompt)
 values(submission_id,target_room,r.current_round,auth.uid(),m.slot,coalesce(submission_content,''),trim(coalesce(submission_content,''))='',coalesce(nullif(pname,''),'PC'||m.slot),command_label,command_body);
end $$;
create or replace function public.multichat_input(target_room uuid,target_round integer) returns text language sql stable security definer set search_path=public as $$
 select string_agg(coalesce(nullif(s.persona_name,''),p.name,'PC'||s.slot)||'(PC'||s.slot||'): '||case when s.is_skip then '[skip]' else s.content end||case when coalesce(s.command_prompt,'')<>'' then E'\n[Selected Command /'||coalesce(s.command_name,'')||E']\n'||s.command_prompt else '' end,E'\n\n' order by s.slot)
 from public.multichat_submissions s left join public.multichat_members m on m.room_id=s.room_id and m.user_id=s.user_id left join public.personas p on p.id=m.persona_id
 where s.room_id=target_room and s.round_number=target_round and public.is_multichat_member(target_room)
$$;
create or replace function public.request_multichat_reroll(target_room uuid) returns void language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms; idx integer;
begin
 select * into r from public.multichat_rooms where id=target_room for update;
 if not found or r.host_user_id is distinct from auth.uid() or r.status<>'active' then raise exception '방장만 리롤할 수 있습니다.'; end if;
 if r.current_round<=1 then raise exception '리롤할 응답이 없습니다.'; end if;
 if exists(select 1 from public.multichat_messages where room_id=target_room and generation_status='streaming') then raise exception '생성이 끝난 뒤 다시 시도해 주세요.'; end if;
 select coalesce(max(reroll_index),-1)+1 into idx from public.multichat_messages where room_id=target_room and round_number=r.current_round-1 and role='assistant';
 insert into public.multichat_messages(room_id,round_number,role,generation_status,reroll_index,is_active_variant,generation_slot,requested_by)
 values(target_room,r.current_round-1,'assistant','streaming',idx,false,public.multichat_payer_slot(target_room,r.current_round-1),auth.uid());
end $$;

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
 if m.id is not null then round:=m.round_number; payer:=case when m.generation_user_id is null and m.generation_slot is not null then m.generation_slot else public.multichat_payer_slot(target_room,round) end;
 else
   round:=r.current_round; payer:=public.multichat_payer_slot(target_room,round);
   if exists(select 1 from public.multichat_messages where room_id=target_room and role='assistant' and (round_number=round or (round_number=round-1 and generation_status='interrupted' and reroll_index=(select max(x.reroll_index) from public.multichat_messages x where x.room_id=target_room and x.round_number=round-1 and x.role='assistant')))) then return null; end if;
   if (select count(*) from public.multichat_submissions where room_id=target_room and round_number=round)<>2 then return null; end if;
 end if;
 if not exists(select 1 from public.multichat_members where room_id=target_room and user_id=auth.uid() and slot=payer) then return null; end if;
 token:=gen_random_uuid();
 if m.id is null then
   insert into public.multichat_messages(room_id,round_number,role,content) values(target_room,round,'user',public.multichat_input(target_room,round));
   insert into public.multichat_messages(room_id,round_number,role,generation_status,generation_slot,generation_user_id,claim_token,claimed_at) values(target_room,round,'assistant','streaming',payer,auth.uid(),token,now()) returning * into m;
 else
   update public.multichat_messages set generation_status='streaming',content='',generation_slot=payer,generation_user_id=auth.uid(),claim_token=token,claimed_at=now() where id=m.id returning * into m;
 end if;
 return jsonb_build_object('messageId',m.id,'round',round,'slot',payer,'token',token);
end $$;
create or replace function public.stream_multichat_response(target_message uuid,token uuid,partial_text text) returns void language plpgsql security definer set search_path=public as $$
begin
 update public.multichat_messages set content=partial_text where id=target_message and claim_token=token and generation_user_id=auth.uid() and generation_status='streaming';
end $$;
create or replace function public.finish_multichat_response(target_message uuid,token uuid,response_text text,in_tokens integer,out_tokens integer,response_cost numeric,read_tokens integer default null,write_tokens integer default null,failed boolean default false) returns void language plpgsql security definer set search_path=public as $$
declare m public.multichat_messages; r public.multichat_rooms;
begin
 select r0.* into r from public.multichat_rooms r0 join public.multichat_messages x on x.room_id=r0.id where x.id=target_message for update of r0;
 select * into m from public.multichat_messages where id=target_message for update;
 if m.id is null or m.claim_token is distinct from token or m.generation_user_id is distinct from auth.uid() or auth.uid() is null then raise exception '이 생성의 담당자가 아닙니다.'; end if;
 if m.generation_status<>'streaming' then return; end if;
 if not failed then
  update public.multichat_messages set is_active_variant=false where room_id=m.room_id and round_number=m.round_number and role='assistant' and id<>m.id;
  if m.round_number<r.current_round then
   delete from public.summary_versions where session_id=r.id and summarized_through_turn>=m.round_number;
   update public.sessions set summary=coalesce((select string_agg(content,E'\n\n' order by created_at) from public.summary_versions where session_id=r.id and is_active),''),summary_last_turn=coalesce((select max(summarized_through_turn) from public.summary_versions where session_id=r.id and is_active),0) where id=r.id;
  end if;
 end if;
 update public.multichat_messages set content=coalesce(response_text,''),generation_status=case when failed then 'interrupted' else 'complete' end,is_active_variant=case when failed then is_active_variant else true end,input_tokens=greatest(coalesce(in_tokens,0),0),output_tokens=greatest(coalesce(out_tokens,0),0),cost=greatest(coalesce(response_cost,0),0),cache_read_tokens=read_tokens,cache_write_tokens=write_tokens where id=m.id;
 if not failed then
  update public.multichat_rooms set current_round=current_round+case when m.round_number=current_round then 1 else 0 end,total_input_tokens=total_input_tokens+greatest(coalesce(in_tokens,0),0),total_output_tokens=total_output_tokens+greatest(coalesce(out_tokens,0),0),total_cost=total_cost+greatest(coalesce(response_cost,0),0),updated_at=now() where id=r.id;
  update public.sessions set total_input_tokens=total_input_tokens+greatest(coalesce(in_tokens,0),0),total_output_tokens=total_output_tokens+greatest(coalesce(out_tokens,0),0),total_cost=total_cost+greatest(coalesce(response_cost,0),0),updated_at=now() where id=r.id;
 end if;
end $$;
create or replace function public.edit_multichat_item(target_room uuid,item_kind text,item_id uuid,new_content text) returns void language plpgsql security definer set search_path=public as $$
declare affected integer;
begin
 perform 1 from public.multichat_rooms where id=target_room and host_user_id=auth.uid() for update;
 if not found then raise exception '방장만 수정할 수 있습니다.'; end if;
 if exists(select 1 from public.multichat_messages where room_id=target_room and generation_status='streaming') then raise exception '생성 중에는 수정할 수 없습니다.'; end if;
 if item_kind='submission' then
  update public.multichat_submissions set content=new_content,is_skip=trim(new_content)='',command_name=null,command_prompt=null where id=item_id and room_id=target_room returning round_number into affected;
  if not found then raise exception '입력을 찾을 수 없습니다.'; end if;
  update public.multichat_messages set content=public.multichat_input(target_room,affected) where room_id=target_room and round_number=affected and role='user';
 elsif item_kind='assistant' then
  update public.multichat_messages set content=new_content where id=item_id and room_id=target_room and role='assistant' returning round_number into affected;
  if not found then raise exception '응답을 찾을 수 없습니다.'; end if;
 elsif item_kind='party' then
  update public.multichat_party_messages set content=new_content where id=item_id and room_id=target_room;
  if not found then raise exception '메시지를 찾을 수 없습니다.'; end if;
 else raise exception '잘못된 메시지 종류입니다.'; end if;
 if affected is not null then
  delete from public.summary_versions where session_id=target_room and summarized_through_turn>=affected;
  update public.sessions set summary=coalesce((select string_agg(content,E'\n\n' order by created_at) from public.summary_versions where session_id=target_room and is_active),''),summary_last_turn=coalesce((select max(summarized_through_turn) from public.summary_versions where session_id=target_room and is_active),0) where id=target_room;
 end if;
end $$;
-- Keep the ordinary branching RPC unavailable for a multichat transcript.
do $$ declare definition text;
begin
 select pg_get_functiondef(p.oid) into definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='branch_session_at_message';
 if definition is not null then
  definition:=regexp_replace(definition,'begin',E'begin\n if exists(select 1 from public.multichat_rooms where id=target_session) then raise exception ''멀티챗에서는 분기할 수 없습니다.''; end if;', 'i');
  execute definition;
 end if;
end $$;
-- Old browser generation endpoints cannot bypass the new host-only reroll flow.
revoke all on function public.claim_multichat_generation(uuid,boolean), public.complete_multichat_generation(uuid,integer,text,integer,integer,numeric,boolean) from public,anon,authenticated;
do $$ declare f record;
begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('multichat_payer_slot','is_multichat_host','join_multichat_room','set_multichat_note','set_multichat_billing','start_multichat','submit_multichat_action','multichat_input','request_multichat_reroll','claim_multichat_response','stream_multichat_response','finish_multichat_response','edit_multichat_item') loop
  execute format('revoke all on function %s from public,anon',f.signature);
  execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';

create or replace function public.set_multichat_persona(target_room uuid,target_persona uuid) returns void language plpgsql security definer set search_path=public as $$
begin
 if target_persona is not null and not exists(select 1 from public.personas where id=target_persona and user_id=auth.uid()) then raise exception '잘못된 페르소나입니다.'; end if;
 update public.multichat_members set persona_id=target_persona where room_id=target_room and user_id=auth.uid();
 if not found then raise exception '참여자가 아닙니다.'; end if;
end $$;
create or replace function public.save_multichat_summary(target_room uuid,summary_text text,through_turn integer,previous_summary text,in_tokens integer,out_tokens integer,response_cost numeric)
returns public.sessions language plpgsql security definer set search_path=public as $$
declare s public.sessions;
begin
 perform 1 from public.multichat_rooms where id=target_room for update;
 if not public.is_multichat_member(target_room) then raise exception '참여자가 아닙니다.'; end if;
 select * into s from public.sessions where id=target_room for update;
 if s.summary is distinct from previous_summary then raise exception '메모리가 변경되었습니다. 다시 생성해 주세요.'; end if;
 if exists(select 1 from public.multichat_messages where room_id=target_room and generation_status='streaming') then raise exception '대화 생성이 끝난 뒤 요약해 주세요.'; end if;
 if through_turn<1 or through_turn>coalesce((select max(round_number) from public.multichat_messages where room_id=target_room and role='assistant' and generation_status='complete'),0) then raise exception '요약 범위를 확인해 주세요.'; end if;
 update public.summary_versions set is_active=false where session_id=target_room;
 insert into public.summary_versions(session_id,content,summarized_through_turn,is_active,input_tokens,output_tokens,cost) values(target_room,summary_text,through_turn,true,greatest(in_tokens,0),greatest(out_tokens,0),greatest(response_cost,0)) on conflict(session_id,summarized_through_turn) do update set content=excluded.content,is_active=true,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cost=excluded.cost;
 update public.sessions set summary=summary_text,summary_last_turn=through_turn,total_input_tokens=total_input_tokens+greatest(in_tokens,0),total_output_tokens=total_output_tokens+greatest(out_tokens,0),total_cost=total_cost+greatest(response_cost,0) where id=target_room returning * into s;
 update public.messages set is_summarized=true where session_id=target_room and turn_index<=through_turn;
 return s;
end $$;
create or replace function public.mutate_multichat_summary(target_room uuid,operation text,target_version uuid default null,summary_text text default null,selected_ids uuid[] default '{}') returns public.sessions language plpgsql security definer set search_path=public as $$
declare s public.sessions;
begin
 perform 1 from public.multichat_rooms where id=target_room for update;
 if not public.is_multichat_member(target_room) then raise exception '참여자가 아닙니다.'; end if;
 if exists(select 1 from public.multichat_messages where room_id=target_room and generation_status='streaming') then raise exception '대화 생성이 끝난 뒤 메모리를 변경해 주세요.'; end if;
 if operation='edit' then update public.summary_versions set content=summary_text where id=target_version and session_id=target_room;
 elsif operation='delete' then delete from public.summary_versions where id=target_version and session_id=target_room;
 elsif operation='select' then update public.summary_versions set is_active=(id=any(selected_ids)) where session_id=target_room;
 else raise exception '잘못된 메모리 작업입니다.'; end if;
 update public.sessions set summary=coalesce((select string_agg(content,E'\n\n--- Additional Summary Note ---\n\n' order by created_at,id) from public.summary_versions where session_id=target_room and is_active),''),summary_last_turn=coalesce((select max(summarized_through_turn) from public.summary_versions where session_id=target_room and is_active),0) where id=target_room returning * into s;
 return s;
end $$;
revoke all on function public.save_multichat_summary(uuid,text,integer,text,integer,integer,numeric),public.mutate_multichat_summary(uuid,text,uuid,text,uuid[]) from public,anon;
grant execute on function public.save_multichat_summary(uuid,text,integer,text,integer,integer,numeric),public.mutate_multichat_summary(uuid,text,uuid,text,uuid[]) to authenticated;

create policy multichat_story_write on public.story_notes for all to authenticated using(public.is_multichat_member(session_id)) with check(public.is_multichat_member(session_id));

-- Summary requests use the same selected API payer, including single-key mode.
alter table public.multichat_rooms add column summary_request_id uuid,add column summary_request jsonb,
 add column summary_claimed_by uuid references public.profiles(id),add column summary_claim_token uuid,
 add column summary_claimed_at timestamptz,add column summary_error text;
create or replace function public.request_multichat_summary(target_room uuid,through_round integer default null,merge_ids uuid[] default '{}') returns void language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms; last_round integer;
begin
 select * into r from public.multichat_rooms where id=target_room for update;
 if not found or not public.is_multichat_member(target_room) then raise exception '참여자가 아닙니다.'; end if;
 if r.summary_request_id is not null and r.summary_error is null and (r.summary_claimed_at is null or r.summary_claimed_at>now()-interval '8 minutes') then raise exception '요약 요청을 처리 중입니다.'; end if;
 if exists(select 1 from public.multichat_messages where room_id=target_room and generation_status='streaming') then raise exception '대화 생성이 끝난 뒤 요약해 주세요.'; end if;
 select max(round_number) into last_round from public.multichat_messages where room_id=target_room and role='assistant' and generation_status='complete';
 if coalesce(last_round,0)<1 then raise exception '요약할 대화가 없습니다.'; end if;
 if exists(select 1 from unnest(merge_ids) x where not exists(select 1 from public.summary_versions where id=x and session_id=target_room)) then raise exception '합칠 메모리를 찾을 수 없습니다.'; end if;
 update public.multichat_rooms set summary_request_id=gen_random_uuid(),summary_request=jsonb_build_object('through',least(coalesce(through_round,last_round),last_round),'mergeIds',to_jsonb(merge_ids)),summary_claimed_by=null,summary_claim_token=null,summary_claimed_at=null,summary_error=null where id=target_room;
end $$;
create or replace function public.claim_multichat_summary(target_room uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms; payer smallint; token uuid;
begin
 select * into r from public.multichat_rooms where id=target_room for update;
 if not found or not public.is_multichat_member(target_room) then raise exception '참여자가 아닙니다.'; end if;
 if r.summary_request_id is null or r.summary_error is not null then return null; end if;
 if r.summary_claimed_by is not null and r.summary_claimed_at>now()-interval '8 minutes' then return null; end if;
 payer:=public.multichat_payer_slot(target_room,greatest(1,r.current_round));
 if not exists(select 1 from public.multichat_members where room_id=target_room and user_id=auth.uid() and slot=payer) then return null; end if;
 token:=gen_random_uuid();
 update public.multichat_rooms set summary_claimed_by=auth.uid(),summary_claim_token=token,summary_claimed_at=now() where id=target_room;
 return r.summary_request||jsonb_build_object('id',r.summary_request_id,'token',token);
end $$;
create or replace function public.fail_multichat_summary(target_room uuid,request_id uuid,token uuid,error_text text) returns void language plpgsql security definer set search_path=public as $$
begin
 update public.multichat_rooms set summary_error=left(error_text,1000) where id=target_room and summary_request_id=request_id and summary_claim_token=token and summary_claimed_by=auth.uid();
end $$;
create or replace function public.finish_multichat_summary(target_room uuid,request_id uuid,token uuid,summary_text text,through_turn integer,previous_summary text,in_tokens integer,out_tokens integer,response_cost numeric,source_versions jsonb default '[]') returns public.sessions language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms; s public.sessions;
begin
 select * into r from public.multichat_rooms where id=target_room for update;
 if not found or auth.uid() is null or not public.is_multichat_member(target_room) then raise exception '참여자가 아닙니다.'; end if;
 -- A lost acknowledged commit may be replayed without charging twice.
 if r.summary_request_id is null then select * into s from public.sessions where id=target_room;return s;end if;
 if r.summary_request_id is distinct from request_id or r.summary_claim_token is distinct from token or r.summary_claimed_by is distinct from auth.uid() then raise exception '요약 요청이 변경되었습니다.'; end if;
 if exists(select 1 from jsonb_array_elements(source_versions) v left join public.messages m on m.id=(v->>'id')::uuid and m.session_id=target_room where m.id is null or m.content_version is distinct from (v->>'version')::integer or not m.is_active_variant) then raise exception '요약 원본이 변경되었습니다. 응답을 보관하고 다시 확인해 주세요.'; end if;
 select * into s from public.save_multichat_summary(target_room,summary_text,through_turn,previous_summary,in_tokens,out_tokens,response_cost);
 update public.multichat_rooms set summary_request_id=null,summary_request=null,summary_claimed_by=null,summary_claim_token=null,summary_claimed_at=null,summary_error=null where id=target_room;
 return s;
end $$;
revoke all on function public.request_multichat_summary(uuid,integer,uuid[]),public.claim_multichat_summary(uuid),public.fail_multichat_summary(uuid,uuid,uuid,text),public.finish_multichat_summary(uuid,uuid,uuid,text,integer,text,integer,integer,numeric,jsonb) from public,anon;
grant execute on function public.request_multichat_summary(uuid,integer,uuid[]),public.claim_multichat_summary(uuid),public.fail_multichat_summary(uuid,uuid,uuid,text),public.finish_multichat_summary(uuid,uuid,uuid,text,integer,text,integer,integer,numeric,jsonb) to authenticated;
-- Internal-only implementation; clients complete the claimed request above.
revoke all on function public.save_multichat_summary(uuid,text,integer,text,integer,integer,numeric) from authenticated;
notify pgrst,'reload schema';

create or replace function public.select_multichat_variant(target_room uuid,target_message uuid) returns void language plpgsql security definer set search_path=public as $$
declare m public.multichat_messages;
begin
 perform 1 from public.multichat_rooms where id=target_room and host_user_id=auth.uid() for update;
 if not found then raise exception '방장만 답변을 선택할 수 있습니다.'; end if;
 if exists(select 1 from public.multichat_messages where room_id=target_room and generation_status='streaming') then raise exception '생성이 끝난 뒤 선택해 주세요.'; end if;
 select * into m from public.multichat_messages where id=target_message and room_id=target_room and role='assistant' and generation_status='complete';
 if not found then raise exception '완료된 응답을 찾을 수 없습니다.'; end if;
 update public.multichat_messages set is_active_variant=(id=target_message) where room_id=target_room and round_number=m.round_number and role='assistant';
 delete from public.summary_versions where session_id=target_room and summarized_through_turn>=m.round_number;
 update public.sessions set summary=coalesce((select string_agg(content,E'\n\n' order by created_at,id) from public.summary_versions where session_id=target_room and is_active),''),summary_last_turn=coalesce((select max(summarized_through_turn) from public.summary_versions where session_id=target_room and is_active),0) where id=target_room;
end $$;
revoke all on function public.select_multichat_variant(uuid,uuid),public.multichat_create_session(),public.multichat_mirror_message() from public,anon;
grant execute on function public.select_multichat_variant(uuid,uuid) to authenticated;
do $$ declare table_name text;
begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  foreach table_name in array array['sessions','story_notes','summary_versions'] loop
   if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=table_name) then
    execute format('alter publication supabase_realtime add table public.%I',table_name);
   end if;
  end loop;
 end if;
end $$;

create policy multichat_combined_work_read on public.works for select to authenticated using(exists(select 1 from public.sessions s where s.multichat_room_id is not null and public.is_multichat_member(s.id) and s.work_combination_enabled and works.id=any(s.combined_work_ids)));

-- Compatibility for already-open browser tabs while the new frontend deploys.
-- These wrappers still enforce the new payer snapshot and host-only reroll.
create or replace function public.claim_multichat_generation(target_room uuid,is_reroll boolean default false) returns integer language plpgsql security definer set search_path=public as $$
declare ticket jsonb;
begin
 if is_reroll then perform public.request_multichat_reroll(target_room); end if;
 ticket:=public.claim_multichat_response(target_room,false);
 return coalesce((ticket->>'round')::integer,0);
end $$;
create or replace function public.complete_multichat_generation(target_room uuid,target_round integer,response_content text,in_tokens integer,out_tokens integer,response_cost numeric,failed boolean default false) returns void language plpgsql security definer set search_path=public as $$
declare m public.multichat_messages;
begin
 select * into m from public.multichat_messages where room_id=target_room and round_number=target_round and role='assistant' and generation_user_id=auth.uid() order by reroll_index desc limit 1;
 if m.id is null or m.claim_token is null then raise exception '이 생성의 담당자가 아닙니다.'; end if;
 perform public.finish_multichat_response(m.id,m.claim_token,response_content,in_tokens,out_tokens,response_cost,null,null,failed);
end $$;
revoke all on function public.claim_multichat_generation(uuid,boolean),public.complete_multichat_generation(uuid,integer,text,integer,integer,numeric,boolean),public.set_multichat_persona(uuid,uuid) from public,anon;
grant execute on function public.claim_multichat_generation(uuid,boolean),public.complete_multichat_generation(uuid,integer,text,integer,integer,numeric,boolean),public.set_multichat_persona(uuid,uuid) to authenticated;
notify pgrst,'reload schema';
