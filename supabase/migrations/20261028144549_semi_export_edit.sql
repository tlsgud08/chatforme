create function private.edit_semi_session_export(target_session uuid,target_link uuid,expected_snapshot jsonb,summary_text text,persona_name text,persona_description text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare me uuid:=auth.uid(); l public.semi_session_links; mine_a boolean; previous jsonb; next_snapshot jsonb; claim jsonb; changed_persona boolean;
begin
 if me is null then raise exception '로그인이 필요합니다.' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('semi:'||target_session::text,0));
 perform 1 from public.sessions where id=target_session and user_id=me and multichat_room_id is null for update;
 if not found then raise exception '본인의 개인 채팅방을 선택해 주세요.' using errcode='42501'; end if;
 select * into l from public.semi_session_links where id=target_link and status='active'
  and ((user_a=me and session_a=target_session) or (user_b=me and session_b=target_session)) for update;
 if not found then raise exception '활성 연결을 확인해 주세요.' using errcode='42501'; end if;
 mine_a:=l.user_a=me;
 if not public.is_my_friend(case when mine_a then l.user_b else l.user_a end) then raise exception '친구 관계를 확인해 주세요.' using errcode='42501'; end if;
 previous:=case when mine_a then l.snapshot_a else l.snapshot_b end;
 claim:=case when mine_a then l.claim_a else l.claim_b end;
 if previous is null then raise exception '먼저 전달용 요약을 생성해 주세요.'; end if;
 if nullif(btrim(summary_text),'') is null or persona_name is null or persona_description is null then raise exception '전달할 내용을 확인해 주세요. 요약은 비울 수 없습니다.'; end if;
 -- A lost acknowledgement may be replayed without changing timestamps again.
 if previous->>'content'=summary_text and coalesce(previous->'persona'->>'name','')=persona_name and coalesce(previous->'persona'->>'description','')=persona_description then return previous; end if;
 if previous is distinct from expected_snapshot then raise exception '다른 화면에서 전송 내용이 변경되었습니다. 입력 내용을 보관하고 다시 확인해 주세요.' using errcode='40001'; end if;
 if claim is not null and (claim->>'expires_at')::timestamptz>clock_timestamp() then raise exception '전달용 요약 생성이 끝난 뒤 편집해 주세요.'; end if;
 changed_persona:=coalesce(previous->'persona'->>'name','')<>persona_name or coalesce(previous->'persona'->>'description','')<>persona_description;
 next_snapshot:=previous||jsonb_build_object('content',summary_text,'persona',jsonb_build_object('name',persona_name,'description',persona_description),'edited_at',clock_timestamp(),
  'persona_override',changed_persona or coalesce((previous->>'persona_override')::boolean,false));
 update public.semi_session_links set snapshot_a=case when mine_a then next_snapshot else snapshot_a end,
  snapshot_b=case when mine_a then snapshot_b else next_snapshot end,updated_at=clock_timestamp() where id=l.id;
 return next_snapshot;
end $$;
revoke all on function private.edit_semi_session_export(uuid,uuid,jsonb,text,text,text) from public,anon;
grant execute on function private.edit_semi_session_export(uuid,uuid,jsonb,text,text,text) to authenticated;
create function public.edit_semi_session_export(target_session uuid,target_link uuid,expected_snapshot jsonb,summary_text text,persona_name text,persona_description text)
returns jsonb language sql security invoker set search_path=public as $$select private.edit_semi_session_export(target_session,target_link,expected_snapshot,summary_text,persona_name,persona_description)$$;
revoke all on function public.edit_semi_session_export(uuid,uuid,jsonb,text,text,text) from public,anon;
grant execute on function public.edit_semi_session_export(uuid,uuid,jsonb,text,text,text) to authenticated;

-- Explicitly edited shared persona text takes precedence over the live source.
-- A subsequent AI-generated sync replaces the snapshot and removes this override.
do $migration$
declare definition text; needle text:='''peer_persona'',persona_payload,';
begin
 select pg_get_functiondef('private.semi_session_context(uuid)'::regprocedure) into definition;
 if strpos(definition,needle)=0 then raise exception 'Unexpected semi context function'; end if;
 execute replace(definition,needle,'''peer_persona'',case when (case when l.user_a=me then l.snapshot_b else l.snapshot_a end)->>''persona_override''=''true'' then (case when l.user_a=me then l.snapshot_b else l.snapshot_a end)->''persona'' else persona_payload end,');
end $migration$;
notify pgrst,'reload schema';
