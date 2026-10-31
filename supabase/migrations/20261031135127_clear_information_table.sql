-- Clearing is atomic with disabling tracking and invalidating in-flight writers.
create function private.clear_information_table(target_session uuid, previous_revision integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.sessions;
begin
 perform private.knowledge_access(target_session);
 select * into s from public.sessions where id=target_session for update;
 if s.knowledge_revision is distinct from previous_revision then
  raise exception '다른 화면에서 설정이 변경되었습니다. 새로고침 후 다시 시도해 주세요.' using errcode='40001';
 end if;
 if exists(select 1 from public.messages where session_id=target_session and generation_status='streaming') then
  raise exception '응답 생성이 끝난 뒤 삭제해 주세요.' using errcode='40001';
 end if;
 update public.sessions set knowledge_enabled=false,knowledge_revision=knowledge_revision+1 where id=target_session returning * into s;
 delete from public.session_knowledge_events where session_id=target_session;
 delete from private.session_knowledge_leases where session_id=target_session;
 -- Retain the accounting ledger: previously spent API costs have not been refunded.
 return jsonb_build_object('knowledge_enabled',false,'knowledge_revision',s.knowledge_revision);
end $$;
create function public.clear_information_table(target_session uuid, previous_revision integer) returns jsonb
language sql security invoker set search_path='' as $$select private.clear_information_table(target_session,previous_revision)$$;
revoke all on function private.clear_information_table(uuid,integer),public.clear_information_table(uuid,integer) from public,anon;
grant execute on function private.clear_information_table(uuid,integer),public.clear_information_table(uuid,integer) to authenticated;
