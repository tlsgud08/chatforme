-- Additive, opt-in runtime. Existing payload and generation RPCs are untouched.
alter table public.sessions add column simulation_settings jsonb not null default '{}'::jsonb;
alter table public.platform_config add column simulation_prompts jsonb not null default '{}'::jsonb;

create table public.work_simulation_config (
 work_id uuid primary key references public.works(id) on delete cascade,
 settings jsonb not null default '{}'::jsonb
);
alter table public.work_simulation_config enable row level security;
create policy simulation_work_read on public.work_simulation_config for select to authenticated
 using(exists(select 1 from public.works w where w.id=work_id));
create policy simulation_work_write on public.work_simulation_config for all to authenticated
 using(public.can_edit_work(work_id)) with check(public.can_edit_work(work_id));
grant select,insert,update,delete on public.work_simulation_config to authenticated;

create table public.session_simulation_events (
 session_id uuid not null references public.sessions(id) on delete cascade,
 message_id uuid primary key references public.messages(id) on delete cascade,
 source_hash text not null,
 patch jsonb not null,
 updated_at timestamptz not null default clock_timestamp()
);
create index simulation_events_session on public.session_simulation_events(session_id);
create table public.session_simulation_rolls (
 session_id uuid not null references public.sessions(id) on delete cascade,
 scope text not null,
 rolls jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 primary key(session_id,scope)
);
create table public.session_simulation_calls (
 id uuid primary key,
 session_id uuid not null references public.sessions(id) on delete cascade,
 stage text not null check(stage in('dice','knowledge','verify')),
 model text not null,
 input_tokens integer not null check(input_tokens>=0),
 output_tokens integer not null check(output_tokens>=0),
 cost numeric not null check(cost>=0),
 created_at timestamptz not null default clock_timestamp()
);
create index simulation_calls_session on public.session_simulation_calls(session_id);
create table private.session_simulation_leases (
 session_id uuid primary key references public.sessions(id) on delete cascade,
 token uuid not null, user_id uuid not null references auth.users(id) on delete cascade, expires_at timestamptz not null
);
alter table private.session_simulation_leases enable row level security;
revoke all on private.session_simulation_leases from public,anon,authenticated;
alter table public.session_simulation_events enable row level security;
alter table public.session_simulation_rolls enable row level security;
alter table public.session_simulation_calls enable row level security;
-- The referenced sessions SELECT is already protected by owner/member RLS.
create policy simulation_events_read on public.session_simulation_events for select to authenticated using(exists(select 1 from public.sessions s where s.id=session_id));
create policy simulation_rolls_read on public.session_simulation_rolls for select to authenticated using(exists(select 1 from public.sessions s where s.id=session_id));
create policy simulation_calls_read on public.session_simulation_calls for select to authenticated using(exists(select 1 from public.sessions s where s.id=session_id));
grant select on public.session_simulation_events,public.session_simulation_rolls,public.session_simulation_calls to authenticated;

create function public.save_work_simulation(target_work uuid,previous jsonb,desired jsonb) returns boolean
language plpgsql security invoker set search_path=public,pg_temp as $$
declare current_value jsonb;
begin
 if auth.uid() is null or not public.can_edit_work(target_work) then raise exception '작품 수정 권한이 없습니다.' using errcode='42501'; end if;
 perform 1 from public.works where id=target_work for update;
 select settings into current_value from public.work_simulation_config where work_id=target_work for update;
 if coalesce(current_value,'{}'::jsonb)=desired then return true; end if;
 if coalesce(current_value,'{}'::jsonb) is distinct from previous then raise exception '다른 화면에서 판정 설정이 바뀌었습니다.' using errcode='40001'; end if;
 if jsonb_typeof(desired)<>'object' or octet_length(desired::text)>100000 then raise exception '설정 형식 또는 길이를 확인해 주세요.'; end if;
 insert into public.work_simulation_config(work_id,settings) values(target_work,desired) on conflict(work_id) do update set settings=excluded.settings;
 return true;
end $$;

create function public.save_simulation_prompts(previous jsonb,desired jsonb) returns boolean
language plpgsql security invoker set search_path=public,pg_temp as $$
declare current_value jsonb; changed integer;
begin
 if auth.uid() is null or not public.is_app_admin() then raise exception '관리자만 수정할 수 있습니다.' using errcode='42501'; end if;
 select simulation_prompts into current_value from public.platform_config where id=1 for update;
 if current_value=desired then return true; end if;
 if current_value is distinct from previous then raise exception '다른 화면에서 전역 프롬프트가 바뀌었습니다.' using errcode='40001'; end if;
 if jsonb_typeof(desired)<>'object' or nullif(btrim(desired->>'dice'),'') is null or nullif(btrim(desired->>'knowledge'),'') is null
  or nullif(btrim(desired->>'analystModel'),'') is null or nullif(btrim(desired->>'verifierModel'),'') is null or octet_length(desired::text)>100000 then raise exception '프롬프트와 모델을 확인해 주세요.'; end if;
 update public.platform_config set simulation_prompts=desired,updated_at=clock_timestamp() where id=1;
 get diagnostics changed=row_count;
 if changed<>1 then raise exception '관리자만 수정할 수 있습니다.' using errcode='42501'; end if;
 return true;
end $$;

-- Use a private definer only for writes to protected derived state. A public
-- invoker wrapper exposes these RPCs, and every entry verifies session access.
create function private.simulation_access(target_session uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null or not exists(select 1 from public.sessions s where s.id=target_session and (s.user_id=auth.uid() or (s.multichat_room_id is not null and public.is_multichat_member(s.multichat_room_id)))) then
  raise exception '세션 접근 권한이 없습니다.' using errcode='42501'; end if;
end $$;
create function public.simulation_source_hash(target_session uuid,through_turn integer) returns text
language sql stable security invoker set search_path=public,pg_temp as $$
 select md5(coalesce(string_agg(m.id::text||':'||m.content_version::text,',' order by m.turn_index,case m.role when 'user' then 0 else 1 end,m.created_at,m.id),''))
 from public.messages m where m.session_id=target_session and m.is_active_variant and not m.is_hidden and m.generation_status='complete' and m.turn_index<=through_turn;
$$;
create function private.simulation_lease(target_session uuid,lease_token uuid,operation text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform private.simulation_access(target_session);
 if operation='release' then
  delete from private.session_simulation_leases where session_id=target_session and token=lease_token and user_id=auth.uid();return true;
 elsif operation='renew' then
  update private.session_simulation_leases set expires_at=clock_timestamp()+interval '120 seconds' where session_id=target_session and token=lease_token and user_id=auth.uid() and expires_at>clock_timestamp();return found;
 elsif operation<>'claim' or lease_token is null then raise exception '잘못된 정보 처리 요청입니다.'; end if;
 insert into private.session_simulation_leases(session_id,token,user_id,expires_at) values(target_session,lease_token,auth.uid(),clock_timestamp()+interval '120 seconds')
 on conflict(session_id) do update set token=excluded.token,user_id=excluded.user_id,expires_at=excluded.expires_at
 where session_simulation_leases.expires_at<clock_timestamp() or (session_simulation_leases.token=lease_token and session_simulation_leases.user_id=auth.uid());
 return found;
end $$;
create function public.simulation_lease(target_session uuid,lease_token uuid,operation text) returns boolean
language sql security invoker set search_path=public,pg_temp as $$select private.simulation_lease(target_session,lease_token,operation)$$;
revoke all on function private.simulation_lease(uuid,uuid,text),public.simulation_lease(uuid,uuid,text) from public,anon;
grant execute on function private.simulation_lease(uuid,uuid,text),public.simulation_lease(uuid,uuid,text) to authenticated;
create function private.simulation_busy(target_session uuid) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 perform private.simulation_access(target_session);
 return exists(select 1 from private.session_simulation_leases where session_id=target_session and expires_at>clock_timestamp());
end $$;
revoke all on function private.simulation_busy(uuid) from public,anon;
grant execute on function private.simulation_busy(uuid) to authenticated;
create function public.simulation_context(target_session uuid,before_turn integer default 2147483647) returns jsonb
language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare s public.sessions; entries jsonb; costs jsonb;
begin
 select * into s from public.sessions where id=target_session;
 if not found or auth.uid() is null then raise exception '세션 접근 권한이 없습니다.' using errcode='42501'; end if;
 with timeline as (
  select m.*,md5(string_agg(m.id::text||':'||m.content_version::text,',') over(order by m.turn_index,case m.role when 'user' then 0 else 1 end,m.created_at,m.id rows between unbounded preceding and current row)) as source_hash
  from public.messages m where m.session_id=target_session and m.is_active_variant and not m.is_hidden and m.generation_status='complete' and m.turn_index<before_turn
 ) select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'content',t.content,'content_version',t.content_version,'turn_index',t.turn_index,
   'user_text',coalesce((select string_agg(u.content,E'\n' order by u.created_at,u.id) from public.messages u where u.session_id=target_session and u.turn_index=t.turn_index and u.role='user' and u.is_active_variant and not u.is_hidden),''),
   'source_hash',t.source_hash,'patch',case when e.source_hash=t.source_hash then e.patch else null end) order by t.turn_index,t.created_at,t.id),'[]'::jsonb)
 into entries from timeline t left join public.session_simulation_events e on e.message_id=t.id where t.role='assistant' and t.turn_index>=coalesce((s.simulation_settings->>'knowledgeFromTurn')::integer,0);
 select jsonb_build_object('cost',coalesce(sum(cost),0),'inputTokens',coalesce(sum(input_tokens),0),'outputTokens',coalesce(sum(output_tokens),0)) into costs from public.session_simulation_calls where session_id=target_session;
 return jsonb_build_object('entries',entries,'settings',s.simulation_settings)||costs;
end $$;

create function private.save_simulation_event(target_session uuid,target_message uuid,expected_hash text,desired jsonb,expected_previous jsonb default null) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.messages; old_patch jsonb; old_hash text;
begin
 perform private.simulation_access(target_session);
 perform 1 from public.sessions where id=target_session and simulation_settings->>'knowledge'='true' for update;
 if not found then raise exception '정보 관리가 꺼졌습니다.' using errcode='40001'; end if;
 select * into m from public.messages where id=target_message and session_id=target_session and role='assistant' and is_active_variant and not is_hidden and generation_status='complete' for share;
 if not found or public.simulation_source_hash(target_session,m.turn_index) is distinct from expected_hash then raise exception '대화가 변경되어 정보 갱신을 다시 해야 합니다.' using errcode='40001'; end if;
 if expected_previous is not null and (exists(select 1 from public.messages where session_id=target_session and generation_status='streaming') or exists(select 1 from private.session_simulation_leases where session_id=target_session and expires_at>clock_timestamp())) then raise exception '응답 생성과 정보 정리가 끝난 뒤 수정해 주세요.' using errcode='40001'; end if;
 select patch,source_hash into old_patch,old_hash from public.session_simulation_events where message_id=target_message for update;
 if old_hash=expected_hash and expected_previous is null then return true; end if;
 if expected_previous is not null and old_patch is distinct from expected_previous then raise exception '정보 표가 변경되었습니다.' using errcode='40001'; end if;
 if jsonb_typeof(desired)<>'object' or jsonb_typeof(desired->'actors') is distinct from 'array' or jsonb_typeof(desired->'facts') is distinct from 'array'
  or jsonb_typeof(desired->'knowledge') is distinct from 'array' or jsonb_typeof(desired->'scene') is distinct from 'array' or octet_length(desired::text)>500000 then raise exception '잘못된 정보 기록입니다.'; end if;
 insert into public.session_simulation_events(session_id,message_id,source_hash,patch) values(target_session,target_message,expected_hash,desired)
 on conflict(message_id) do update set source_hash=excluded.source_hash,patch=excluded.patch,updated_at=clock_timestamp();
 if old_patch is distinct from desired then delete from public.session_simulation_events e using public.messages later where e.message_id=later.id and e.session_id=target_session and later.turn_index>m.turn_index; end if;
 return true;
end $$;

create function public.set_simulation_settings(target_session uuid,previous jsonb,desired jsonb) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare s public.sessions;
begin
 select * into s from public.sessions where id=target_session for update;
 if not found or auth.uid() is null then raise exception '세션 접근 권한이 없습니다.' using errcode='42501'; end if;
 if s.simulation_settings=desired then return desired; end if;
 if s.simulation_settings is distinct from previous then raise exception '다른 화면에서 설정이 바뀌었습니다.' using errcode='40001'; end if;
 if coalesce((desired->>'knowledgeFromTurn')::integer,0)>coalesce((s.simulation_settings->>'knowledgeFromTurn')::integer,0) and exists(select 1 from public.session_simulation_events where session_id=target_session) then raise exception '이미 기록한 정보의 시작 시점은 뒤로 옮길 수 없습니다.'; end if;
 if exists(select 1 from public.messages where session_id=target_session and generation_status='streaming') or private.simulation_busy(target_session) then raise exception '응답 생성과 정보 정리가 끝난 뒤 설정해 주세요.'; end if;
 if jsonb_typeof(desired) is distinct from 'object' or jsonb_typeof(desired->'dice') is distinct from 'boolean' or jsonb_typeof(desired->'knowledge') is distinct from 'boolean'
  or coalesce((desired->>'knowledgeFromTurn')::integer,0)<0 then raise exception '잘못된 기능 설정입니다.'; end if;
 update public.sessions set simulation_settings=desired where id=target_session;
 if not found then raise exception '설정 권한이 없습니다.' using errcode='42501'; end if;
 return desired;
end $$;
revoke all on function public.set_simulation_settings(uuid,jsonb,jsonb) from public,anon;
grant execute on function public.set_simulation_settings(uuid,jsonb,jsonb) to authenticated;
create function public.save_simulation_event(target_session uuid,target_message uuid,expected_hash text,desired jsonb,expected_previous jsonb default null) returns boolean
language sql security invoker set search_path=public,pg_temp as $$select private.save_simulation_event(target_session,target_message,expected_hash,desired,expected_previous)$$;

create function private.roll_simulation_dice(target_session uuid,scope_key text,actions jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; a jsonb; die integer; success_min integer; critical_min integer; value integer; sample bigint; ceiling bigint; bytes bytea;
begin
 perform private.simulation_access(target_session);
 perform 1 from public.sessions where id=target_session and simulation_settings->>'dice'='true' for update;
 if not found then raise exception '주사위가 꺼졌습니다.' using errcode='40001'; end if;
 if nullif(scope_key,'') is null or length(scope_key)>200 or jsonb_typeof(actions) is distinct from 'array' or jsonb_array_length(actions)>4 then raise exception '잘못된 판정 요청입니다.'; end if;
 select rolls into result from public.session_simulation_rolls where session_id=target_session and scope=scope_key;
 if found then return result; end if;
 result:='[]'::jsonb;
 for a in select item.value from jsonb_array_elements(actions) as item loop
  die:=(a->>'die')::integer;success_min:=(a->>'successMin')::integer;critical_min:=(a->>'criticalMin')::integer;
  if die is null or success_min is null or critical_min is null or die not between 2 and 10000 or success_min not between 1 and die+1 or critical_min not between success_min and die+1 then raise exception '잘못된 주사위 범위입니다.'; end if;
  -- Rejection sampling, avoiding modulo bias. pgcrypto lives in extensions.
  ceiling:=4294967296-(4294967296 % die);
  loop
   bytes:=extensions.gen_random_bytes(4);
   sample:=get_byte(bytes,0)::bigint*16777216+get_byte(bytes,1)::bigint*65536+get_byte(bytes,2)::bigint*256+get_byte(bytes,3)::bigint;
   exit when sample<ceiling;
  end loop;
  value:=(sample % die)::integer+1;
  result:=result||jsonb_build_array(a||jsonb_build_object('value',value,'outcome',case when value>=critical_min then 'critical_success' when value>=success_min then 'success' else 'failure' end));
 end loop;
 insert into public.session_simulation_rolls(session_id,scope,rolls) values(target_session,scope_key,result);
 return result;
end $$;
create function public.roll_simulation_dice(target_session uuid,scope_key text,actions jsonb) returns jsonb
language sql security invoker set search_path=public,pg_temp as $$select private.roll_simulation_dice(target_session,scope_key,actions)$$;

create function private.record_simulation_call(target_session uuid,call_id uuid,stage_name text,model_name text,in_tokens integer,out_tokens integer,call_cost numeric) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform private.simulation_access(target_session);
 insert into public.session_simulation_calls(id,session_id,stage,model,input_tokens,output_tokens,cost) values(call_id,target_session,stage_name,model_name,in_tokens,out_tokens,call_cost) on conflict(id) do nothing;
end $$;
create function public.record_simulation_call(target_session uuid,call_id uuid,stage_name text,model_name text,in_tokens integer,out_tokens integer,call_cost numeric) returns void
language sql security invoker set search_path=public,pg_temp as $$select private.record_simulation_call(target_session,call_id,stage_name,model_name,in_tokens,out_tokens,call_cost)$$;

revoke all on function private.simulation_access(uuid) from public,anon,authenticated;
revoke all on function private.save_simulation_event(uuid,uuid,text,jsonb,jsonb),private.roll_simulation_dice(uuid,text,jsonb),private.record_simulation_call(uuid,uuid,text,text,integer,integer,numeric) from public,anon;
grant execute on function private.save_simulation_event(uuid,uuid,text,jsonb,jsonb),private.roll_simulation_dice(uuid,text,jsonb),private.record_simulation_call(uuid,uuid,text,text,integer,integer,numeric) to authenticated;
revoke all on function public.save_work_simulation(uuid,jsonb,jsonb),public.save_simulation_prompts(jsonb,jsonb),public.simulation_source_hash(uuid,integer),public.simulation_context(uuid,integer),public.save_simulation_event(uuid,uuid,text,jsonb,jsonb),public.roll_simulation_dice(uuid,text,jsonb),public.record_simulation_call(uuid,uuid,text,text,integer,integer,numeric) from public,anon;
grant execute on function public.save_work_simulation(uuid,jsonb,jsonb),public.save_simulation_prompts(jsonb,jsonb),public.simulation_source_hash(uuid,integer),public.simulation_context(uuid,integer),public.save_simulation_event(uuid,uuid,text,jsonb,jsonb),public.roll_simulation_dice(uuid,text,jsonb),public.record_simulation_call(uuid,uuid,text,text,integer,integer,numeric) to authenticated;
notify pgrst,'reload schema';
