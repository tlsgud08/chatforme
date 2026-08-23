-- Two-player, host-funded realtime multichat.
create extension if not exists pgcrypto;

alter table public.platform_config add column if not exists multichat_system_prompt text not null default '';
alter table public.works add column if not exists multichat_prompt text not null default '';

create table public.multichat_rooms (
  id uuid primary key default gen_random_uuid(),
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  work_id uuid not null references public.works(id) on delete cascade,
  host_user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 60),
  status text not null default 'lobby' check (status in ('lobby', 'active', 'ended')),
  password_hash text,
  current_round integer not null default 0,
  model text not null,
  output_tokens integer,
  total_input_tokens bigint not null default 0,
  total_output_tokens bigint not null default 0,
  total_cost numeric not null default 0,
  started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.multichat_members (
  room_id uuid not null references public.multichat_rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  slot smallint not null check (slot in (1, 2)),
  persona_id uuid references public.personas(id) on delete set null,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id), unique (room_id, slot)
);

create table public.multichat_submissions (
  id uuid primary key default gen_random_uuid(), room_id uuid not null references public.multichat_rooms(id) on delete cascade,
  round_number integer not null, user_id uuid not null references public.profiles(id) on delete cascade,
  slot smallint not null check (slot in (1, 2)), content text not null default '', is_skip boolean not null default false,
  created_at timestamptz not null default now(), unique(room_id, round_number, user_id), unique(room_id, round_number, slot),
  check (char_length(content) <= 4000)
);

create table public.multichat_messages (
  id uuid primary key default gen_random_uuid(), room_id uuid not null references public.multichat_rooms(id) on delete cascade,
  round_number integer not null, role text not null check(role in ('user','assistant')), content text not null default '',
  generation_status text not null default 'complete' check(generation_status in ('streaming','complete','interrupted')),
  reroll_index integer not null default 0, is_active_variant boolean not null default true,
  input_tokens integer not null default 0, output_tokens integer not null default 0, cost numeric not null default 0,
  created_at timestamptz not null default now(), unique(room_id, round_number, role, reroll_index)
);

create table public.multichat_party_messages (
  id uuid primary key default gen_random_uuid(), room_id uuid not null references public.multichat_rooms(id) on delete cascade,
  sender_user_id uuid not null references public.profiles(id) on delete cascade, content text not null check(char_length(content) between 1 and 4000),
  created_at timestamptz not null default now()
);

alter table public.multichat_rooms enable row level security;
alter table public.multichat_members enable row level security;
alter table public.multichat_submissions enable row level security;
alter table public.multichat_messages enable row level security;
alter table public.multichat_party_messages enable row level security;

create or replace function public.is_multichat_member(target_room uuid) returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from multichat_members where room_id=target_room and user_id=auth.uid())
$$;
create or replace function public.multichat_round_ready(target_room uuid,target_round integer) returns boolean language sql stable security definer set search_path=public as $$
  select count(*)=2 from multichat_submissions where room_id=target_room and round_number=target_round
$$;
create policy multichat_rooms_member_select on public.multichat_rooms for select using (public.is_multichat_member(id));
create policy multichat_members_member_select on public.multichat_members for select using (public.is_multichat_member(room_id));
-- A submitted body remains private until both immutable submissions exist.
create policy multichat_submissions_member_select on public.multichat_submissions for select using (
  public.is_multichat_member(room_id) and (
    user_id=auth.uid() or public.multichat_round_ready(room_id,round_number)
  )
);
create policy multichat_messages_member_select on public.multichat_messages for select using (public.is_multichat_member(room_id));
create policy multichat_party_select on public.multichat_party_messages for select using (public.is_multichat_member(room_id));
create policy multichat_party_insert on public.multichat_party_messages for insert with check (sender_user_id=auth.uid() and public.is_multichat_member(room_id));

create or replace function public.create_multichat(target_work uuid, room_title text, room_password text, target_model text, target_output_tokens integer default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare rid uuid;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;
  insert into multichat_rooms(work_id,host_user_id,title,password_hash,model,output_tokens)
  values(target_work,auth.uid(),left(trim(room_title),60),case when coalesce(room_password,'')='' then null else crypt(room_password,gen_salt('bf')) end,target_model,target_output_tokens) returning id into rid;
  insert into multichat_members(room_id,user_id,slot) values(rid,auth.uid(),1);
  return rid;
end $$;

create or replace function public.join_multichat(room_code text, room_password text) returns uuid language plpgsql security definer set search_path=public as $$
declare r multichat_rooms; rid uuid;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;
  select * into r from multichat_rooms where invite_code=upper(trim(room_code)) for update;
  if r.id is null then raise exception '방을 찾을 수 없습니다.'; end if;
  if r.status <> 'lobby' then raise exception '이미 시작된 방입니다.'; end if;
  if r.password_hash is not null and crypt(coalesce(room_password,''),r.password_hash)<>r.password_hash then raise exception '비밀번호가 올바르지 않습니다.'; end if;
  if exists(select 1 from multichat_members where room_id=r.id and user_id=auth.uid()) then return r.id; end if;
  if (select count(*) from multichat_members where room_id=r.id)>=2 then raise exception '방이 가득 찼습니다.'; end if;
  insert into multichat_members(room_id,user_id,slot) values(r.id,auth.uid(),2); return r.id;
end $$;

create or replace function public.start_multichat(target_room uuid) returns void language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from multichat_rooms where id=target_room and host_user_id=auth.uid() and status='lobby') then raise exception '방장만 시작할 수 있습니다.'; end if;
  if (select count(*) from multichat_members where room_id=target_room)<>2 then raise exception '두 명이 모두 참가해야 합니다.'; end if;
  update multichat_rooms set status='active',current_round=1,started_at=now(),updated_at=now() where id=target_room;
end $$;

create or replace function public.kick_multichat_member(target_room uuid,target_user uuid) returns void language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from multichat_rooms where id=target_room and host_user_id=auth.uid() and status='lobby') then raise exception '로비의 방장만 추방할 수 있습니다.'; end if;
 if target_user=auth.uid() then raise exception '자신을 추방할 수 없습니다.'; end if;
 delete from multichat_members where room_id=target_room and user_id=target_user;
end $$;

create or replace function public.set_multichat_password(target_room uuid,new_password text) returns void language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from multichat_rooms where id=target_room and host_user_id=auth.uid() and status='lobby') then raise exception '로비의 방장만 비밀번호를 바꿀 수 있습니다.'; end if;
 update multichat_rooms set password_hash=case when coalesce(new_password,'')='' then null else crypt(new_password,gen_salt('bf')) end,updated_at=now() where id=target_room;
end $$;

create or replace function public.set_multichat_persona(target_room uuid,target_persona uuid) returns void language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from personas where id=target_persona and user_id=auth.uid()) then raise exception '잘못된 페르소나입니다.'; end if;
 update multichat_members set persona_id=target_persona where room_id=target_room and user_id=auth.uid();
end $$;

create or replace function public.submit_multichat_turn(target_room uuid, submission_content text) returns void language plpgsql security definer set search_path=public as $$
declare r multichat_rooms; s smallint;
begin
 select * into r from multichat_rooms where id=target_room for update;
 if r.status<>'active' then raise exception '진행 중인 방이 아닙니다.'; end if;
 select slot into s from multichat_members where room_id=target_room and user_id=auth.uid();
 if s is null then raise exception '참여자가 아닙니다.'; end if;
 if exists(select 1 from multichat_messages where room_id=target_room and round_number=r.current_round and role='assistant') then raise exception '현재 응답을 생성 중입니다.'; end if;
 insert into multichat_submissions(room_id,round_number,user_id,slot,content,is_skip) values(target_room,r.current_round,auth.uid(),s,left(coalesce(submission_content,''),4000),trim(coalesce(submission_content,''))='');
end $$;

create or replace function public.claim_multichat_generation(target_room uuid, is_reroll boolean default false) returns integer language plpgsql security definer set search_path=public as $$
declare r multichat_rooms; idx integer;
begin
 select * into r from multichat_rooms where id=target_room for update;
 if r.host_user_id<>auth.uid() or r.status<>'active' then raise exception '방장만 생성할 수 있습니다.'; end if;
 if is_reroll then
   if r.current_round<=1 then raise exception '리롤할 응답이 없습니다.'; end if;
   select coalesce(max(reroll_index),-1)+1 into idx from multichat_messages where room_id=target_room and round_number=r.current_round-1 and role='assistant';
   update multichat_messages set is_active_variant=false where room_id=target_room and round_number=r.current_round-1 and role='assistant';
   insert into multichat_messages(room_id,round_number,role,generation_status,reroll_index) values(target_room,r.current_round-1,'assistant','streaming',idx); return r.current_round-1;
 end if;
 if (select count(*) from multichat_submissions where room_id=target_room and round_number=r.current_round)<>2 then raise exception '두 사용자의 제출을 기다리고 있습니다.'; end if;
 if exists(select 1 from multichat_messages where room_id=target_room and round_number=r.current_round and role='assistant' and generation_status='interrupted') then
   update multichat_messages set generation_status='streaming',content='' where room_id=target_room and round_number=r.current_round and role='assistant'; return r.current_round;
 end if;
 if exists(select 1 from multichat_messages where room_id=target_room and round_number=r.current_round and role='assistant') then return 0; end if;
 insert into multichat_messages(room_id,round_number,role,content) select target_room,r.current_round,'user',string_agg('user'||slot||': '||case when is_skip then '[skip]' else content end,E'\n\n' order by slot) from multichat_submissions where room_id=target_room and round_number=r.current_round;
 insert into multichat_messages(room_id,round_number,role,generation_status) values(target_room,r.current_round,'assistant','streaming'); return r.current_round;
end $$;

create or replace function public.complete_multichat_generation(target_room uuid,target_round integer,response_content text,in_tokens integer,out_tokens integer,response_cost numeric,failed boolean default false) returns void language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from multichat_rooms where id=target_room and host_user_id=auth.uid()) then raise exception '방장만 완료할 수 있습니다.'; end if;
 update multichat_messages set content=response_content,generation_status=case when failed then 'interrupted' else 'complete' end,input_tokens=in_tokens,output_tokens=out_tokens,cost=response_cost
 where id=(select id from multichat_messages where room_id=target_room and round_number=target_round and role='assistant' order by reroll_index desc limit 1);
 if not failed and target_round=(select current_round from multichat_rooms where id=target_room) then update multichat_rooms set current_round=current_round+1,total_input_tokens=total_input_tokens+in_tokens,total_output_tokens=total_output_tokens+out_tokens,total_cost=total_cost+response_cost,updated_at=now() where id=target_room; end if;
end $$;

grant execute on function public.create_multichat(uuid,text,text,text,integer), public.join_multichat(text,text), public.start_multichat(uuid), public.kick_multichat_member(uuid,uuid), public.set_multichat_password(uuid,text), public.set_multichat_persona(uuid,uuid), public.submit_multichat_turn(uuid,text), public.claim_multichat_generation(uuid,boolean), public.complete_multichat_generation(uuid,integer,text,integer,integer,numeric,boolean) to authenticated;
do $$ begin alter publication supabase_realtime add table public.multichat_rooms, public.multichat_members, public.multichat_submissions, public.multichat_messages, public.multichat_party_messages; exception when duplicate_object then null; end $$;
