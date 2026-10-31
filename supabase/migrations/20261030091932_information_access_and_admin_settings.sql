-- Independent opt-in features. Legacy generation and prompt assembly stay unchanged.
alter table public.sessions add column knowledge_enabled boolean not null default false;
alter table public.sessions add column knowledge_revision integer not null default 0;
alter table public.sessions add column theme_anywhere_enabled boolean not null default false;
alter table public.platform_config add column knowledge_config jsonb not null default '{}'::jsonb;

create table public.session_knowledge_events (
 session_id uuid not null references public.sessions(id) on delete cascade,
 message_id uuid primary key,
 source_hash text not null,
 setup_hash text not null,
 patch jsonb not null,
 updated_at timestamptz not null default clock_timestamp()
);
create index knowledge_events_session on public.session_knowledge_events(session_id);
create table public.session_knowledge_calls (
 id uuid primary key,
 session_id uuid not null references public.sessions(id) on delete cascade,
 model text not null,
 input_tokens integer not null check(input_tokens>=0),
 output_tokens integer not null check(output_tokens>=0),
 cost numeric not null check(cost>=0),
 created_at timestamptz not null default clock_timestamp()
);
create index knowledge_calls_session on public.session_knowledge_calls(session_id);
alter table public.session_knowledge_events enable row level security;
alter table public.session_knowledge_calls enable row level security;
-- sessions SELECT already enforces owner or shared-room membership.
create policy knowledge_events_read on public.session_knowledge_events for select to authenticated
 using(exists(select 1 from public.sessions s where s.id=session_id));
create policy knowledge_calls_read on public.session_knowledge_calls for select to authenticated
 using(exists(select 1 from public.sessions s where s.id=session_id));
grant select on public.session_knowledge_events,public.session_knowledge_calls to authenticated;
revoke insert,update,delete on public.session_knowledge_events,public.session_knowledge_calls from anon,authenticated;
create table private.session_knowledge_leases (
 session_id uuid primary key references public.sessions(id) on delete cascade,
 token uuid not null,user_id uuid not null references auth.users(id) on delete cascade,expires_at timestamptz not null
);
alter table private.session_knowledge_leases enable row level security;
revoke all on private.session_knowledge_leases from public,anon,authenticated;
create function private.knowledge_access(target_session uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null or not exists(select 1 from public.sessions s where s.id=target_session and
 (s.user_id=auth.uid() or (s.multichat_room_id is not null and public.is_multichat_member(s.multichat_room_id)))) then
 raise exception '세션 접근 권한이 없습니다.' using errcode='42501';end if;
end $$;
revoke all on function private.knowledge_access(uuid) from public,anon,authenticated;
create function private.knowledge_lease(target_session uuid,lease_token uuid,operation text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform private.knowledge_access(target_session);
 if operation='release' then
 delete from private.session_knowledge_leases where session_id=target_session and token=lease_token and user_id=auth.uid();return true;
 elsif operation='renew' then
 update private.session_knowledge_leases set expires_at=clock_timestamp()+interval '120 seconds'
 where session_id=target_session and token=lease_token and user_id=auth.uid() and expires_at>clock_timestamp();return found;
 elsif operation<>'claim' or lease_token is null then raise exception '잘못된 정보 처리 요청입니다.';end if;
 insert into private.session_knowledge_leases(session_id,token,user_id,expires_at)
 values(target_session,lease_token,auth.uid(),clock_timestamp()+interval '120 seconds')
 on conflict(session_id) do update set token=excluded.token,user_id=excluded.user_id,expires_at=excluded.expires_at
 where session_knowledge_leases.expires_at<clock_timestamp() or (session_knowledge_leases.token=lease_token and session_knowledge_leases.user_id=auth.uid());
 return found;
end $$;
create function public.knowledge_lease(target_session uuid,lease_token uuid,operation text) returns boolean
language sql security invoker set search_path=public,pg_temp as $$select private.knowledge_lease(target_session,lease_token,operation)$$;
create function public.knowledge_source_hash(target_session uuid,through_turn integer) returns text
language sql stable security invoker set search_path=public,pg_temp as $$
 select md5(coalesce(string_agg(m.id::text||':'||m.content_version::text,',' order by m.turn_index,case m.role when 'user' then 0 else 1 end,m.created_at,m.id),''))
 from public.messages m where m.session_id=target_session and m.is_active_variant and not m.is_hidden and m.generation_status='complete' and m.turn_index<=through_turn;
$$;
create function public.knowledge_context(target_session uuid,before_turn integer default 2147483647) returns jsonb
language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare s public.sessions;entries jsonb;costs jsonb;seed jsonb;
begin
 select * into s from public.sessions where id=target_session;
 if not found or auth.uid() is null then raise exception '세션 접근 권한이 없습니다.' using errcode='42501';end if;
 with timeline as (
 select m.*,md5(string_agg(m.id::text||':'||m.content_version::text,',') over(order by m.turn_index,case m.role when 'user' then 0 else 1 end,m.created_at,m.id rows between unbounded preceding and current row)) as source_hash
 from public.messages m where m.session_id=target_session and m.is_active_variant and not m.is_hidden and m.generation_status='complete' and m.turn_index<before_turn
 ) select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'content',t.content,'content_version',t.content_version,'turn_index',t.turn_index,
 'user_text',coalesce((select string_agg(u.content,E'\n' order by u.created_at,u.id) from public.messages u where u.session_id=target_session and u.turn_index=t.turn_index and u.role='user' and u.is_active_variant and not u.is_hidden and u.generation_status='complete'),''),
 'source_hash',t.source_hash,'setup_hash',e.setup_hash,'patch',case when e.source_hash=t.source_hash then e.patch else null end) order by t.turn_index,t.created_at,t.id),'[]'::jsonb)
 into entries from timeline t left join public.session_knowledge_events e on e.message_id=t.id where t.role='assistant';
 select jsonb_build_object('id',target_session,'content','','user_text','','turn_index',-1,'content_version',0,'source_hash','seed','setup_hash',e.setup_hash,'patch',e.patch)
 into seed from (select 1) dummy left join public.session_knowledge_events e on e.message_id=target_session and e.session_id=target_session;
 select jsonb_build_object('cost',coalesce(sum(cost),0),'inputTokens',coalesce(sum(input_tokens),0),'outputTokens',coalesce(sum(output_tokens),0))
 into costs from public.session_knowledge_calls where session_id=target_session;
 return jsonb_build_object('entries',jsonb_build_array(seed)||entries,'revision',s.knowledge_revision,'enabled',s.knowledge_enabled)||costs;
end $$;
create function private.save_knowledge_event(target_session uuid,target_message uuid,expected_hash text,desired jsonb,setup_hash text,expected_revision integer,expected_previous jsonb default null) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.messages;old_patch jsonb;old_hash text;old_setup text;turn_number integer;
begin
 perform private.knowledge_access(target_session);
 perform 1 from public.sessions where id=target_session and knowledge_enabled and knowledge_revision=expected_revision for update;
 if not found then raise exception '정보 관리 설정이 변경되었습니다.' using errcode='40001';end if;
 if target_message=target_session then
 if expected_hash is distinct from 'seed' then raise exception '잘못된 초기 정보 기록입니다.';end if;turn_number:=-1;
 else
 select * into m from public.messages where id=target_message and session_id=target_session and role='assistant' and is_active_variant and not is_hidden and generation_status='complete' for share;
 if not found or public.knowledge_source_hash(target_session,m.turn_index) is distinct from expected_hash then
 raise exception '대화가 변경되어 정보 갱신을 다시 해야 합니다.' using errcode='40001';end if;turn_number:=m.turn_index;
 end if;
 if expected_previous is not null and (exists(select 1 from public.messages where session_id=target_session and generation_status='streaming') or exists(select 1 from private.session_knowledge_leases where session_id=target_session and expires_at>clock_timestamp())) then
 raise exception '응답 생성과 정보 정리가 끝난 뒤 수정해 주세요.' using errcode='40001';end if;
 select e.patch,e.source_hash,e.setup_hash into old_patch,old_hash,old_setup from public.session_knowledge_events e where e.message_id=target_message for update;
 if old_hash=expected_hash and old_setup=setup_hash and expected_previous is null then return true;end if;
 if expected_previous is not null and old_patch is distinct from expected_previous then raise exception '정보 표가 변경되었습니다.' using errcode='40001';end if;
 if jsonb_typeof(desired) is distinct from 'object' or jsonb_typeof(desired->'actors') is distinct from 'array' or jsonb_typeof(desired->'facts') is distinct from 'array'
 or jsonb_typeof(desired->'knowledge') is distinct from 'array' or jsonb_typeof(desired->'scene') is distinct from 'array' or octet_length(desired::text)>1000000 or length(setup_hash)<>64 then raise exception '잘못된 정보 기록입니다.';end if;
 insert into public.session_knowledge_events(session_id,message_id,source_hash,setup_hash,patch) values(target_session,target_message,expected_hash,setup_hash,desired)
 on conflict(message_id) do update set source_hash=excluded.source_hash,setup_hash=excluded.setup_hash,patch=excluded.patch,updated_at=clock_timestamp();
 if old_patch is distinct from desired then
 delete from public.session_knowledge_events e where e.session_id=target_session and e.message_id<>target_message and
 (turn_number=-1 or exists(select 1 from public.messages later where later.id=e.message_id and later.turn_index>turn_number));end if;
 return true;
end $$;
create function public.save_knowledge_event(target_session uuid,target_message uuid,expected_hash text,desired jsonb,setup_hash text,expected_revision integer,expected_previous jsonb default null) returns boolean
language sql security invoker set search_path=public,pg_temp as $$select private.save_knowledge_event(target_session,target_message,expected_hash,desired,setup_hash,expected_revision,expected_previous)$$;
create function public.set_information_features(target_session uuid,previous_revision integer,knowledge boolean,theme_anywhere boolean) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare s public.sessions;
begin
 select * into s from public.sessions where id=target_session for update;
 if not found or auth.uid() is null then raise exception '세션 접근 권한이 없습니다.' using errcode='42501';end if;
 if s.knowledge_revision<>previous_revision then raise exception '다른 화면에서 설정이 변경되었습니다.' using errcode='40001';end if;
 if knowledge is null or theme_anywhere is null then raise exception '기능 설정을 확인해 주세요.';end if;
 if exists(select 1 from public.messages where session_id=target_session and generation_status='streaming') then raise exception '응답 생성이 끝난 뒤 설정해 주세요.';end if;
 update public.sessions set knowledge_enabled=knowledge,theme_anywhere_enabled=theme_anywhere,knowledge_revision=knowledge_revision+1 where id=target_session returning * into s;
 if not found then raise exception '설정 권한이 없습니다.' using errcode='42501';end if;
 return jsonb_build_object('knowledge_enabled',s.knowledge_enabled,'theme_anywhere_enabled',s.theme_anywhere_enabled,'knowledge_revision',s.knowledge_revision);
end $$;
create function private.record_knowledge_call(target_session uuid,call_id uuid,model_name text,in_tokens integer,out_tokens integer,call_cost numeric) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform private.knowledge_access(target_session);
 insert into public.session_knowledge_calls(id,session_id,model,input_tokens,output_tokens,cost) values(call_id,target_session,model_name,in_tokens,out_tokens,call_cost) on conflict(id) do nothing;
end $$;
create function public.record_knowledge_call(target_session uuid,call_id uuid,model_name text,in_tokens integer,out_tokens integer,call_cost numeric) returns void
language sql security invoker set search_path=public,pg_temp as $$select private.record_knowledge_call(target_session,call_id,model_name,in_tokens,out_tokens,call_cost)$$;

-- All administrator editors share one transaction and compare-and-swap baseline.
create function public.save_admin_settings(previous jsonb,desired jsonb,new_master_password text default null) returns boolean
language plpgsql security invoker set search_path=public,pg_temp as $$
declare current_value jsonb;field text;required_fields text[]:=array['system_prompt','theme_prompt','multichat_system_prompt','summary_prompt','semi_multichat_prompt','semi_sync_summary_prompt','work_combination_prompt','knowledge_config'];
begin
 if auth.uid() is null or not public.is_app_admin() then raise exception '관리자만 설정을 변경할 수 있습니다.' using errcode='42501';end if;
 if desired is null or jsonb_typeof(desired) is distinct from 'object' or not desired ?& required_fields or (select count(*) from jsonb_object_keys(desired))<>8 then raise exception '전체 관리자 설정을 불러온 뒤 저장해 주세요.';end if;
 foreach field in array required_fields loop
 if field<>'knowledge_config' and jsonb_typeof(desired->field) is distinct from 'string' then raise exception '프롬프트 형식을 확인해 주세요.';end if;end loop;
 if nullif(btrim(desired->>'summary_prompt'),'') is null or nullif(btrim(desired->>'semi_sync_summary_prompt'),'') is null then raise exception '요약 프롬프트를 입력해 주세요.';end if;
 if jsonb_typeof(desired->'knowledge_config') is distinct from 'object' or nullif(btrim(desired->'knowledge_config'->>'model'),'') is null
 or nullif(btrim(desired->'knowledge_config'->>'recordPrompt'),'') is null or nullif(btrim(desired->'knowledge_config'->>'mainPrompt'),'') is null
 or coalesce((desired->'knowledge_config'->>'maxOutputTokens')::integer,0) not between 1000 and 32000 then raise exception '정보 관리 모델과 프롬프트·출력량을 확인해 주세요.';end if;
 if new_master_password is not null and length(new_master_password)<8 then raise exception '마스터 비밀번호는 8자 이상이어야 합니다.';end if;
 select jsonb_build_object('system_prompt',p.system_prompt,'theme_prompt',p.theme_prompt,'multichat_system_prompt',p.multichat_system_prompt,
 'summary_prompt',p.summary_prompt,'semi_multichat_prompt',p.semi_multichat_prompt,'semi_sync_summary_prompt',p.semi_sync_summary_prompt,
 'work_combination_prompt',p.work_combination_prompt,'knowledge_config',p.knowledge_config) into current_value from public.platform_config p where id=1 for update;
 if not found then raise exception '관리자 설정이 없습니다.';end if;
 if current_value is distinct from desired and current_value is distinct from previous then raise exception '다른 화면에서 관리자 설정이 변경되었습니다. 입력은 유지했습니다.' using errcode='40001';end if;
 update public.platform_config set system_prompt=desired->>'system_prompt',theme_prompt=desired->>'theme_prompt',multichat_system_prompt=desired->>'multichat_system_prompt',
 summary_prompt=desired->>'summary_prompt',semi_multichat_prompt=desired->>'semi_multichat_prompt',semi_sync_summary_prompt=desired->>'semi_sync_summary_prompt',work_combination_prompt=desired->>'work_combination_prompt',knowledge_config=desired->'knowledge_config',updated_at=clock_timestamp() where id=1;
 if not found then raise exception '관리자 저장 권한이 없습니다.' using errcode='42501';end if;
 if new_master_password is not null then perform public.set_signup_master_password(new_master_password);end if;
 return true;
end $$;

revoke all on function private.knowledge_lease(uuid,uuid,text),private.save_knowledge_event(uuid,uuid,text,jsonb,text,integer,jsonb),private.record_knowledge_call(uuid,uuid,text,integer,integer,numeric) from public,anon;
grant execute on function private.knowledge_lease(uuid,uuid,text),private.save_knowledge_event(uuid,uuid,text,jsonb,text,integer,jsonb),private.record_knowledge_call(uuid,uuid,text,integer,integer,numeric) to authenticated;
revoke all on function public.knowledge_lease(uuid,uuid,text),public.knowledge_source_hash(uuid,integer),public.knowledge_context(uuid,integer),public.save_knowledge_event(uuid,uuid,text,jsonb,text,integer,jsonb),public.set_information_features(uuid,integer,boolean,boolean),public.record_knowledge_call(uuid,uuid,text,integer,integer,numeric),public.save_admin_settings(jsonb,jsonb,text) from public,anon;
grant execute on function public.knowledge_lease(uuid,uuid,text),public.knowledge_source_hash(uuid,integer),public.knowledge_context(uuid,integer),public.save_knowledge_event(uuid,uuid,text,jsonb,text,integer,jsonb),public.set_information_features(uuid,integer,boolean,boolean),public.record_knowledge_call(uuid,uuid,text,integer,integer,numeric),public.save_admin_settings(jsonb,jsonb,text) to authenticated;
notify pgrst,'reload schema';
