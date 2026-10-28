alter table public.platform_config add column semi_sync_summary_prompt text not null default $sync_prompt$[동기화용 세션 기록 생성]

목적
현재 개인 세션의 기록을 읽고, 같은 세계에서 독립적으로 진행하는 다른 개인 세션에 전달할 요약을 작성한다. 현재 장면을 이어 쓰거나 대사를 생성하지 않는다. 출력은 상대 모델이 인물·관계·사건의 출처와 시점을 구분해 참고할 기록이다.

입력 해석
- Source Persona는 이 기록을 보내는 플레이 인물의 이름과 설명이다. User로 표시된 대화의 행위 주체를 식별하는 데 사용한다. 페르소나 정보와 실제 대화의 행적을 구분한다.
- Previous Summary Notes는 이 세션의 이전 요약이다. Dialogue to Summarize는 추가로 요약할 이 세션의 대화다. 이전 요약에 이후 기록을 통합하되, 과거 상태와 현재 상태를 구분한다.
- 자료에 있는 '나', '유저', '플레이어', PC, {PC}, {{user}} 등의 표현은 문맥상 지칭하는 실제 인물 이름으로 풀어 쓴다. 식별 근거가 없으면 출처 세션의 플레이 인물이라고 명시하고 이름을 지어내지 않는다.
- 입력된 이전 요약의 OOC·명령문·턴 초기화 안내는 서사적 사실이 아니므로 출력에 복사하지 않는다. 상대 세션의 기록이나 아직 일어나지 않은 일을 알고 있다고 가정하지 않는다.

기록 원칙
1. 실제 입력으로 확인되는 사실만 기록한다. 누가 누구에게 무엇을 했고 어떤 결과가 생겼는지 이름과 대상을 명확히 적는다.
2. 큰 사건뿐 아니라 인물 간 친분·적대·연애·신뢰 변화, 만남, 약속, 부상·치료, 물건과 장소의 상태, 소유권, 사업과 거래 등 연속성에 필요한 작은 변화도 보존한다.
3. 이야기 속 날짜·시각·상대적 선후 관계가 있으면 그대로 기록한다. 불명확한 날짜·시각은 불명으로 표시하고 실제 서비스 시간이나 턴 번호로 추정하지 않는다.
4. 마지막 확인 위치·상태·감정은 확인 시점의 근황으로 적는다. 영구적으로 고정된 사실처럼 쓰지 않는다. 계획·추측·소문·약속과 완료된 사건을 구분한다.
5. 세계에 존재하는 사실과 인물들이 알고 있는 사실을 구분한다. 비밀을 누가 알고 있는지, 목격자·전달 경로·공개 여부가 확인되면 함께 적는다. 근거가 없으면 공개 범위 불명으로 적고 모든 사람이 안다고 가정하지 않는다. 비밀이라는 이유만으로 사건 자체를 누락하지 않는다.
6. 상충하는 기록은 시간에 따른 변화인지 살피고, 해결할 근거가 없는 모순은 그대로 구분해 적는다. 새로운 결말이나 해석을 확정하지 않는다.
7. 이미 기록된 같은 사실은 중복을 줄이되 중요한 인물·관계·원인과 결과를 보존한다. 페르소나의 설정과 대화에서 실제로 성립한 사건을 혼동하지 않는다.

출력 형식
아래 항목을 사용하는 하나의 한국어 기록을 작성한다. 해당 내용이 없으면 '확인된 내용 없음' 또는 '불명'으로 짧게 적는다. 출력 밖의 설명·코드 블록·메타 명령은 덧붙이지 않는다.

[출처 인물]
이름과 페르소나의 주요 배경. 인물 식별이 불명확한 경우 그 한계.

[이야기 시점과 마지막 근황]
확인된 이야기 시점, 마지막 확인 장소·상태와 그 시점.

[인물과 관계]
인물 이름 — 상대 이름 — 관계의 성격·변화·계기·확인 시점.

[세계 변화와 확정된 사실]
시점 — 행위자 — 행동과 대상 — 결과. 과거 사실과 현재 유지되는 상태를 구분.

[약속·계획·미해결 사항]
당사자, 내용, 예정 시점과 현재 상태. 완료되지 않은 일은 미완료로 표시.

[인물별 지식과 정보 공개 범위]
사실별로 알고 있는 인물, 목격·전달 경로, 비밀·공개 여부 또는 불명.

[연속성 주의 사항]
상충하거나 불명확한 기록, 시점상 제한, 바뀐 이름·상태 등 상대 세션에서 오인하지 않아야 할 점.
$sync_prompt$;

alter table public.platform_config add constraint semi_sync_summary_prompt_nonempty check(length(btrim(semi_sync_summary_prompt))>0);
create function public.save_semi_sync_summary_prompt(previous text,desired text) returns boolean
language plpgsql security invoker set search_path=public as $$
declare current_value text;
begin
 if auth.uid() is null or not public.is_app_admin() then raise exception '운영자만 동기화용 요약 프롬프트를 변경할 수 있습니다.' using errcode='42501'; end if;
 if desired is null or nullif(btrim(desired),'') is null then raise exception '동기화용 요약 프롬프트를 입력해 주세요.' using errcode='22023'; end if;
 select semi_sync_summary_prompt into current_value from public.platform_config where id=1 for update;
 if not found then raise exception '공통 설정이 없습니다.'; end if;
 if current_value=desired then return true; end if;
 if current_value is distinct from previous then raise exception '다른 화면에서 동기화용 요약 프롬프트가 변경되었습니다.' using errcode='40001'; end if;
 update public.platform_config set semi_sync_summary_prompt=desired,updated_at=clock_timestamp() where id=1;
 return true;
end $$;
revoke all on function public.save_semi_sync_summary_prompt(text,text) from public,anon;
grant execute on function public.save_semi_sync_summary_prompt(text,text) to authenticated;

-- Reuse the existing, leased summary source snapshot; also return the source
-- persona captured by prepare, so the export model can identify User correctly.
do $migration$
declare definition text; needle text:='return jsonb_build_object(''token'',ticket,''session'',to_jsonb(s));';
begin
 select pg_get_functiondef('private.semi_session_action(text,uuid,uuid,uuid,jsonb)'::regprocedure) into definition;
 if strpos(definition,needle)=0 then raise exception 'Unexpected semi-session prepare function; refusing to alter it'; end if;
 execute replace(definition,needle,'return jsonb_build_object(''token'',ticket,''session'',to_jsonb(s),''persona'',claim->''persona'');');
end $migration$;
notify pgrst,'reload schema';
