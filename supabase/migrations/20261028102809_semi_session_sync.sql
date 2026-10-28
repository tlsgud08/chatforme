-- Additive experiment: reverting the frontend branch leaves ordinary chats intact.
alter table public.platform_config add column semi_multichat_prompt text not null default
'현재 세션의 플레이 인물은 PC이며, 연결된 개인 세션의 인물은 PC2입니다. PC2 Information과 PC2 Session Summary는 상대 세션에서 전달받은 정보입니다.';

create function public.save_semi_multichat_prompt(previous text,desired text) returns boolean
language plpgsql security invoker set search_path=public as $$
declare current_value text;
begin
 if auth.uid() is null or not public.is_app_admin() then raise exception '운영자만 세미 멀티챗 프롬프트를 변경할 수 있습니다.' using errcode='42501'; end if;
 if desired is null then raise exception '프롬프트 값이 필요합니다.'; end if;
 select semi_multichat_prompt into current_value from public.platform_config where id=1 for update;
 if not found then raise exception '공통 설정이 없습니다.'; end if;
 if current_value=desired then return true; end if;
 if current_value is distinct from previous then raise exception '다른 화면에서 프롬프트가 변경되었습니다. 다시 불러와 주세요.' using errcode='40001'; end if;
 update public.platform_config set semi_multichat_prompt=desired,updated_at=clock_timestamp() where id=1;
 return true;
end $$;
revoke all on function public.save_semi_multichat_prompt(text,text) from public,anon;
grant execute on function public.save_semi_multichat_prompt(text,text) to authenticated;

create table public.semi_session_links (
 id uuid primary key default gen_random_uuid(),
 user_a uuid not null references public.profiles(id) on delete cascade,
 user_b uuid not null references public.profiles(id) on delete cascade,
 session_a uuid not null references public.sessions(id) on delete cascade,
 session_b uuid references public.sessions(id) on delete cascade,
 title_a text not null, title_b text,
 status text not null default 'pending' check(status in ('pending','active','closed')),
 snapshot_a jsonb, snapshot_b jsonb,
 claim_a jsonb, claim_b jsonb,
 updated_at timestamptz not null default now(),
 check(user_a<>user_b),check(session_a is distinct from session_b),
 check(status<>'active' or session_b is not null)
);
create index semi_links_user_a_idx on public.semi_session_links(user_a,status);
create index semi_links_user_b_idx on public.semi_session_links(user_b,status);
create unique index semi_links_session_a_live on public.semi_session_links(session_a) where status<>'closed';
create unique index semi_links_session_b_live on public.semi_session_links(session_b) where status='active';
alter table public.semi_session_links enable row level security;
revoke all on public.semi_session_links from public,anon,authenticated;
grant select on public.semi_session_links to authenticated;
create policy semi_links_read on public.semi_session_links for select to authenticated
 using((auth.uid()=user_a and public.is_my_friend(user_b)) or (auth.uid()=user_b and public.is_my_friend(user_a)));

create function private.close_unfriended_semi_sessions() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status<>'accepted' then
  update public.semi_session_links set status='closed',snapshot_a=null,snapshot_b=null,claim_a=null,claim_b=null,updated_at=clock_timestamp()
   where status<>'closed' and least(user_a,user_b)=new.user_a and greatest(user_a,user_b)=new.user_b;
 end if;
 return new;
end $$;
revoke all on function private.close_unfriended_semi_sessions() from public,anon,authenticated;
create trigger close_unfriended_semi_sessions after update of status on public.friendships
 for each row execute function private.close_unfriended_semi_sessions();

-- Cross-owner writes are limited to this non-exposed function. No access to a
-- friend's messages, notes, session row or API key is granted to clients.
create function private.semi_session_action(operation text,target_session uuid,target_link uuid,other_user uuid,details jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare me uuid:=auth.uid(); s public.sessions; l public.semi_session_links; mine_a boolean;
 claim jsonb; stamp timestamptz:=clock_timestamp(); ticket uuid; snap jsonb; result jsonb; p jsonb;
begin
 if me is null then raise exception '로그인이 필요합니다.' using errcode='42501'; end if;
 -- All operations originate in an owned, ordinary personal session.
 perform pg_advisory_xact_lock(hashtextextended('semi:'||target_session::text,0));
 select * into s from public.sessions where id=target_session and user_id=me and multichat_room_id is null for update;
 if not found then raise exception '본인의 개인 채팅방을 선택해 주세요.' using errcode='42501'; end if;
 if operation='request' then
  if other_user is null or other_user=me or not public.is_my_friend(other_user) then raise exception '연결할 친구를 선택해 주세요.'; end if;
  if exists(select 1 from public.semi_session_links where status<>'closed' and (session_a=s.id or session_b=s.id)) then raise exception '이 채팅방에는 이미 연결 또는 요청이 있습니다.'; end if;
  insert into public.semi_session_links(user_a,user_b,session_a,title_a) values(me,other_user,s.id,s.title) returning * into l;
  return to_jsonb(l);
 end if;
 select * into l from public.semi_session_links where id=target_link and me in(user_a,user_b) for update;
 if not found then raise exception '연결을 찾을 수 없습니다.' using errcode='42501'; end if;
 mine_a:=l.user_a=me;
 if operation='accept' then
  if mine_a or l.status<>'pending' then raise exception '수락할 연결 요청이 없습니다.'; end if;
  if not public.is_my_friend(l.user_a) then raise exception '친구 관계를 확인해 주세요.'; end if;
  if exists(select 1 from public.semi_session_links where status<>'closed' and (session_a=s.id or session_b=s.id)) then raise exception '이 채팅방은 이미 연결되어 있습니다.'; end if;
  update public.semi_session_links set session_b=s.id,title_b=s.title,status='active',updated_at=stamp where id=l.id returning * into l;
  return to_jsonb(l);
 end if;
 -- An invite recipient may decline from any of their own personal rooms.
 if (mine_a and l.session_a<>s.id) or (not mine_a and l.session_b is not null and l.session_b<>s.id) then raise exception '연결된 채팅방을 확인해 주세요.'; end if;
 if operation='close' then
  update public.semi_session_links set status='closed',snapshot_a=null,snapshot_b=null,claim_a=null,claim_b=null,updated_at=stamp where id=l.id;
  return jsonb_build_object('closed',true);
 end if;
 if l.status<>'active' or not public.is_my_friend(case when mine_a then l.user_b else l.user_a end) then raise exception '활성 연결이 없습니다.'; end if;
 -- Replay after a lost acknowledgement must not charge or publish twice.
 snap:=case when mine_a then l.snapshot_a else l.snapshot_b end;
 if operation='publish' and snap->>'request_id'=details->>'token' then
  return jsonb_build_object('total_input_tokens',s.total_input_tokens,'total_output_tokens',s.total_output_tokens,'total_cost',s.total_cost);
 end if;
 claim:=case when mine_a then l.claim_a else l.claim_b end;
 if operation='prepare' then
  if claim is not null and (claim->>'expires_at')::timestamptz>stamp then raise exception '이 세션에서 이미 전달용 요약을 생성하고 있습니다.'; end if;
  if exists(select 1 from public.messages where session_id=s.id and generation_status='streaming') then raise exception 'AI 응답이 끝난 뒤 동기화해 주세요.'; end if;
  ticket:=gen_random_uuid();
  select jsonb_build_object('name',name,'description',description) into p from public.personas where id=s.persona_id;
  claim:=jsonb_build_object('token',ticket,'expires_at',stamp+interval '10 minutes','source_hash',public.session_response_context_hash(s.id),'persona',coalesce(p,'{}'::jsonb));
  update public.semi_session_links set claim_a=case when mine_a then claim else claim_a end,claim_b=case when mine_a then claim_b else claim end where id=l.id;
  return jsonb_build_object('token',ticket,'session',to_jsonb(s));
 end if;
 if claim is null or claim->>'token' is distinct from details->>'token' then raise exception '요약 생성 요청이 만료되거나 변경되었습니다.' using errcode='40001'; end if;
 if operation='release' then
  update public.semi_session_links set claim_a=case when mine_a then null else claim_a end,claim_b=case when mine_a then claim_b else null end where id=l.id;
  return jsonb_build_object('released',true);
 end if;
 if operation<>'publish' then raise exception '잘못된 연동 작업입니다.'; end if;
 if (claim->>'expires_at')::timestamptz<stamp then raise exception '요약 생성 요청이 만료되었습니다.'; end if;
 if nullif(btrim(details->>'content'),'') is null then raise exception '전달할 요약이 비어 있습니다.'; end if;
 if claim->>'source_hash' is distinct from public.session_response_context_hash(s.id) then raise exception '요약을 생성하는 동안 대화나 요약이 변경되었습니다. 다시 동기화해 주세요.' using errcode='40001'; end if;
 if exists(select 1 from jsonb_to_recordset(coalesce(details->'source_notes','[]'::jsonb)) v(id uuid,content text,through_turn integer)
  where not exists(select 1 from public.summary_versions n where n.id=v.id and n.session_id=s.id and n.content=v.content and n.summarized_through_turn=v.through_turn)) then
  raise exception '참고한 요약 노트가 변경되었습니다. 다시 동기화해 주세요.' using errcode='40001';
 end if;
 -- The shared artifact is the model result, not a pointer to personal memory.
 snap:=jsonb_build_object('request_id',details->>'token','content',details->>'content','persona',claim->'persona','sent_at',stamp,'through_turn',details->'through_turn');
 update public.semi_session_links set snapshot_a=case when mine_a then snap else snapshot_a end,snapshot_b=case when mine_a then snapshot_b else snap end,
  claim_a=case when mine_a then null else claim_a end,claim_b=case when mine_a then claim_b else null end,updated_at=stamp where id=l.id;
 -- Account for the paid call, without changing summary, summary_last_turn,
 -- summary_versions or any message/is_summarized flag.
 update public.sessions set total_input_tokens=total_input_tokens+greatest(coalesce((details->>'input_tokens')::integer,0),0),
  total_output_tokens=total_output_tokens+greatest(coalesce((details->>'output_tokens')::integer,0),0),
  total_cost=total_cost+greatest(coalesce((details->>'cost')::numeric,0),0) where id=s.id returning
  jsonb_build_object('total_input_tokens',total_input_tokens,'total_output_tokens',total_output_tokens,'total_cost',total_cost) into result;
 return result;
end $$;
revoke all on function private.semi_session_action(text,uuid,uuid,uuid,jsonb) from public,anon;
grant usage on schema private to authenticated;
grant execute on function private.semi_session_action(text,uuid,uuid,uuid,jsonb) to authenticated;
create function public.semi_session_action(operation text,target_session uuid,target_link uuid default null,other_user uuid default null,details jsonb default '{}')
returns jsonb language sql security invoker set search_path=public as $$
 select private.semi_session_action(operation,target_session,target_link,other_user,details)
$$;
revoke all on function public.semi_session_action(text,uuid,uuid,uuid,jsonb) from public,anon;
grant execute on function public.semi_session_action(text,uuid,uuid,uuid,jsonb) to authenticated;
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  alter publication supabase_realtime add table public.semi_session_links;
 end if;
end $$;
notify pgrst,'reload schema';
