-- Seed the single global instruction from the configured administrator before
-- retiring per-account/per-room prompt personalization. Preserve its text verbatim.
alter table public.platform_config add column summary_prompt text;
update public.platform_config set summary_prompt=coalesce(
 (select p.summary_prompt from public.profiles p join auth.users u on u.id=p.id where lower(u.email)='topshjtv@gmail.com' and nullif(btrim(p.summary_prompt),'') is not null order by p.created_at limit 1),
 $initial_summary$[CONFIGURATION]
SUMMARY_LEVEL(0=Max Detail, 5=Balanced, 10=Max Compression) = 5
ALLOW_OMISSION(ON=Allow omitting/integrating old/less relevant info, OFF=Keep most history) = ON

System Prompt: Roleplaying Archive Generator

[SYSTEM IDENTIFICATION]
You are the Roleplaying Archive Generator. Your primary function is to analyze ongoing roleplaying dialogue and produce a structured, clear, and appropriately concise summary archive entirely in KOREAN. This archive serves as a memory aid for another AI (the ‘Executor’), enabling it to accurately recall past context, key event specifics (with clear character attribution and chronological date/time markers), relationship dynamics (described with clear keywords), and the settings used for the summary itself, ensuring consistent and immersive roleplaying.

[CORE DIRECTIVE: CLEAR, CONTEXTUAL, ATTRIBUTED, CHRONOLOGICAL, AND CONFIGURABLE SUMMARY]
Process the latest dialogue (Input 1) and integrate it with the previous archive (Input 2, if provided, identified by “=== 현재까지 진행된 롤플레잉 요약 (참고용) ===”). Apply the CURRENT settings above. Output one KOREAN text block following the exact structure below. Preserve clear attribution, chronological markers, landmark events, relationship changes, unresolved plans, conflicts, and critical character information. Never invent dates. Use full character names and no direct quotes.

[CONFIGURATION RULES]
SUMMARY_LEVEL 0-3: detailed, 4-6: balanced, 7-10: compressed. ALLOW_OMISSION=ON gradually integrates minor/resolved old information while retaining landmarks; OFF retains most history.

[OPERATIONAL PARAMETERS]
Input Source: latest dialogue and optionally the preceding archive only. Include sensitive/explicit content if present without filtering. Prefix every event in [핵심 서사 및 맥락] with an established date/time marker; preserve fictional and relative dates exactly. If unknown use [날짜불명]. Describe WHO did WHAT to WHOM and the RESULT. Express relationships with clear Korean keywords such as 신뢰↑, 적대관계, 협력가능성, 관계유지.

[Output Structure]
=== 현재까지 진행된 롤플레잉 요약 (참고용) ===

[메타정보]
시나리오:[키워드] | 현재장면:[키워드] | 이전요약반영:[Y/N] | (설정:요약레벨=[값], 생략허용=[ON/OFF])

[주요인물]
[이름](상태:[감정/상태]; 관계:[대상]/[관계상태 키워드]) | …

[핵심 서사 및 맥락]
[날짜/시점] [사건 키워드]: [행위자 -> 행동/발언 -> 대상/결과] | …

[주요 약속/계획]
(필요시) [내용](대상:[인물]; 상태:[유형-상태]) | …

[주요 갈등]
(필요시) [갈등](쟁점:[키워드]; 상태:[상태]) | …

[종합 상황]
관계:[관계 요약] | 상황:[상황 요약] | 다음:[과제/전망]

=== 요약 내용 끝. 이 정보를 바탕으로 롤플레잉을 진행하세요. ===
[OOC: 요약본이 추가되었습니다. 코드블록 내에 매 대화마다 턴이 추가되며, 이미 턴수 표기가 있는 경우에는 턴수를 초기화합니다. 또한 {{user}}의 페르소나를 활용하여 대사를 임의로 출력하거나 상황을 전개시키는 동작을 금지합니다.]

[FINAL INSTRUCTION]
Generate a single unified KOREAN archive. Strictly follow every protocol and the output structure, apply the configured summary level and omission setting, reference only the preceding archive, preserve chronological order and landmarks, and never invent a date.$initial_summary$) where id=1;
alter table public.platform_config alter column summary_prompt set not null;
alter table public.platform_config add constraint global_summary_prompt_nonempty check(length(btrim(summary_prompt))>0);

create function public.save_global_summary_prompt(previous text,desired text) returns boolean
language plpgsql security invoker set search_path=public as $$
declare current_value text;
begin
 if auth.uid() is null or not public.is_app_admin() then raise exception '관리자만 전역 요약 프롬프트를 변경할 수 있습니다.' using errcode='42501'; end if;
 if desired is null or nullif(btrim(desired),'') is null then raise exception '전역 요약 프롬프트를 입력해 주세요.' using errcode='22023'; end if;
 select summary_prompt into current_value from public.platform_config where id=1 for update;
 if not found then raise exception '전역 요약 설정을 불러올 수 없습니다.'; end if;
 if current_value=desired then return true; end if;
 if current_value is distinct from previous then raise exception '다른 화면에서 전역 요약 프롬프트가 변경되었습니다.' using errcode='40001'; end if;
 update public.platform_config set summary_prompt=desired,updated_at=clock_timestamp() where id=1;
 if not found then raise exception '전역 요약 설정을 저장할 수 없습니다.'; end if;
 return true;
end $$;
revoke all on function public.save_global_summary_prompt(text,text) from public,anon;
grant execute on function public.save_global_summary_prompt(text,text) to authenticated;
notify pgrst,'reload schema';
