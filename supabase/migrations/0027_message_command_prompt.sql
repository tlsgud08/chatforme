-- 리롤 시에도 원래 턴에 적용한 명령어를 그대로 재사용할 수 있도록 실행 당시 본문을 보존한다.
alter table public.messages
  add column if not exists command_prompt text;
